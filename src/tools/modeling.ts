/**
 * Modeling tools: SAC planning models and dimension members.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "../browser/session.js";
import { assertWritable, config } from "../config.js";
import { ensureTenantPackage } from "../story/content.js";
import { addModelDimension, setHierarchy, createPlanningModel, createPublicDimension, upsertMembers, upsertPublicMembers } from "../story/model-create.js";
import { listDesignAssets } from "../story/assets.js";
import { createStoryFromTemplate } from "../story/template.js";
import { stripToBlankCanvasPage } from "../story/canvas.js";
import { buildCanvasSkeleton, buildPlanningCanvas } from "../story/canvas-dashboard.js";
import { bindPlanningDataSource } from "../story/planning.js";
import { planningModel } from "../story/planwrite.js";
import { describeModel } from "../story/insight.js";
import { PAGE_NAME } from "../story/naming.js";
import { resolveUser } from "./story.js";
import { createDataAction, runDataAction, validateDataAction } from "../story/dataaction.js";
import { createMultiAction, validateMultiAction } from "../story/multiaction.js";
import { compositePropertyValues } from "../story/composite.js";
import { buildForecastStoryContent } from "../story/forecast-story.js";
import { reloadWithColumn } from "../story/data-reload.js";
import { dropMissingDependencies } from "../story/dependencies.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";


async function ready() {
  await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
  await ensureTenantPackage();
}

export function registerModelingTools(server: McpServer): void {
  server.tool(
    "sac_planning_model_create",
    `Create a new SAC planning model (stored in SAC) in a folder: the given measures and generic dimensions plus Date
(month granularity) and Version (Actual, optionally Plan). Technical names: letters, digits, underscore. Members of the
generic dimensions can be added with sac_model_members_set; data with the sac_import_* tools.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string(),
      measures: z.array(z.object({ name: z.string(), description: z.string().optional(), decimals: z.number().int().min(0).max(7).optional() })).min(1),
      dimensions: z.array(z.object({ name: z.string(), description: z.string().optional() })).default([]),
      planVersion: z.boolean().optional(),
      datasphereSpace: z.string().optional().describe("Seamless Planning: Datasphere space for the data (e.g. DEMO_SPACE); omitted = data in SAC"),
      fromYear: z.number().int().optional().describe("First year of the time dimension (default last year)"),
      toYear: z.number().int().optional().describe("Last year of the time dimension (default two years ahead)"),
      allowalteration: z.boolean().optional(),
    },
    async ({ allowalteration, ...spec }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create planning model");
        await ready();
        const r = await createPlanningModel(spec);
        return toolSuccess({ ...r, name: spec.name, openURL: `/sap/fpa/ui/app.html#/modeler&/m/model/${r.cubeId}` });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_model_members_set",
    "Add or update members (ID + description, optional further properties) of a dimension of an SAC model.",
    {
      cubeId: z.string().describe("Model id (C…)"),
      dimension: z.string(),
      members: z.array(z.object({ id: z.string(), description: z.string().optional() }).catchall(z.string())).min(1),
      allowalteration: z.boolean().optional(),
    },
    async ({ cubeId, dimension, members, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set members");
        await ready();
        const res = await upsertMembers(cubeId, dimension, members);
        return toolSuccess({ dimension, members: members.length, response: res });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_model_dimension_add",
    `Add a generic dimension (own dimension table) to an existing SAC model, like + Dimension in the modeler. Existing
data is booked on defaultMember ("#" unassigned) for the new dimension — reload it with the new column to split it.
Optional members right away. Seamless models get the dimension table in their Datasphere space.`,
    {
      cubeId: z.string().describe("Model id (C…)"),
      name: z.string().describe("Technical name: letters, digits, _"),
      description: z.string().optional(),
      members: z.array(z.object({ id: z.string(), description: z.string().optional() })).optional(),
      defaultMember: z.string().optional().describe('Member for the existing data rows (default "#"); must be one of members if not "#"'),
      allowalteration: z.boolean().optional(),
    },
    async ({ cubeId, name, description, members, defaultMember, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add model dimension");
        await ready();
        if (defaultMember && defaultMember !== "#" && !members?.some((m) => m.id === defaultMember))
          throw new Error(`defaultMember '${defaultMember}' must be one of the members`);
        const r = await addModelDimension(cubeId, { name, description, defaultMember, members });
        return toolSuccess({ ...r, name, members: members?.length ?? 0 });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_model_hierarchy_set",
    `Parent-child hierarchy on a dimension of an SAC model: creates the hierarchy if missing and sets the parents.
nodes in display order: [{id, description?, parent?}] — parent omitted/"" = top node; parents that are new members are
listed as nodes too (e.g. categories COOKIES/DRINKS, then the products under them). Other member columns are kept.`,
    {
      cubeId: z.string(),
      dimension: z.string(),
      hierarchy: z.string().describe("Hierarchy id, e.g. H_KAT"),
      description: z.string().optional(),
      nodes: z.array(z.object({ id: z.string(), description: z.string().optional(), parent: z.string().optional() })).min(1),
      makeDefault: z.boolean().optional().describe("Make it the default hierarchy (automatic for the first one)"),
      allowalteration: z.boolean().optional(),
    },
    async ({ cubeId, dimension, hierarchy, description, nodes, makeDefault, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set hierarchy");
        await ready();
        const r = await setHierarchy(cubeId, dimension, { id: hierarchy, description, nodes, makeDefault });
        return toolSuccess({ hierarchy, dimension, ...r });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_model_data_reload",
    `Reload the fact data of an SAC model with a derived column, e.g. after sac_model_dimension_add: export all facts
(backup CSV in captures/backups), set column = map[from] (otherwise "#"), CleanAndReplace per version, then compare
rows and totals per version. Empty dimension values become "#". dryRun: backup + distribution only, nothing changes.`,
    {
      cubeId: z.string(),
      column: z.string().describe("Dimension to fill, e.g. Kategorie"),
      from: z.string().describe("Dimension the value is derived from, e.g. Produkt"),
      map: z.record(z.string(), z.string()).describe("Source member → target member"),
      otherwise: z.string().optional().describe('Target for unmapped source members (default "#")'),
      dryRun: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ cubeId, column, from, map, otherwise, dryRun, allowalteration }) => {
      if (!allowalteration && !dryRun) return toolError(ALTERATION_MSG);
      try {
        if (!dryRun) assertWritable("reload model data");
        await ready();
        return toolSuccess(await reloadWithColumn(cubeId, { column, from, map, otherwise }, { dryRun }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_planning_story_create",
    `Create a planning story on an SAC planning model: canvas schablone (header + card) with an input-ready
table (one dimension in the rows, two measures). Without template the tool returns the available templates (ask the user).`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string(),
      cubeId: z.string().describe("SAC planning model id (C…), e.g. from sac_planning_model_create"),
      title: z.string().describe("Header title; '\\n' starts a subtitle"),
      rowDimension: z.string(),
      rowCaption: z.string().optional(),
      measures: z.array(z.string()).length(2),
      tableTitle: z.string().optional().describe("Title row of the table card"),
      template: z.string().optional(),
      headerInverted: z.boolean().optional(),
      headerComposite: z.string().optional().describe("Id of a header composite (40 px, title only) instead of the built-in header"),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create planning story");
        await ready();
        const assets = await listDesignAssets();
        if (!args.template)
          return toolSuccess({
            needsInput: true,
            note: "Story was NOT created. Please agree on the template with the user.",
            questions: [{ field: "template", question: "Which story template?", options: assets.templates.map((t) => ({ name: t.name, recommended: t.recommended })) }],
          });
        const t = assets.templates.find((x) => x.resourceId === args.template || x.name === args.template);
        if (!t) throw new Error(`Template '${args.template}' not found`);
        const model = await describeModel(args.cubeId);
        if (model.live) throw new Error("This is a live model; planning needs an SAC planning model");
        const user = await resolveUser(args.folderId);
        let widgets: string[] = [];
        const headerComposite = args.headerComposite
          ? { compositeId: args.headerComposite, interfaceProperty: await compositePropertyValues(args.headerComposite, { Title: args.title.split("\n")[0] }) }
          : undefined;
        // a freshly created model is not usable for stories for a few seconds (createTempContent answers 500)
        const create = async (attempt = 0): Promise<{ storyId: string }> => {
          try {
            return await createStoryFromTemplate(opts);
          } catch (e) {
            if (attempt >= 8 || !String(e).includes("createTempContent failed (500)")) throw e;
            await new Promise((r) => setTimeout(r, 5000));
            return create(attempt + 1);
          }
        };
        const opts: Parameters<typeof createStoryFromTemplate>[0] = {
          templateId: t.resourceId,
          name: args.name,
          description: args.description,
          folderId: args.folderId,
          user,
          prepare: async (_id, content) => {
            stripToBlankCanvasPage(content, PAGE_NAME(1));
            widgets = buildPlanningCanvas(content, PAGE_NAME(1), {
              title: args.title,
              headerInverted: args.headerInverted ?? false,
              headerComposite,
              model: { cubeId: args.cubeId, name: model.name },
              row: { name: args.rowDimension, caption: args.rowCaption },
              measures: [args.measures[0], args.measures[1]],
              tableLabel: args.tableTitle,
            });
          },
        };
        const { storyId } = await create();
        return toolSuccess({ storyId, name: args.name, widgets, openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=view` });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_public_dimension_create",
    "Create a public (shared) generic dimension in a folder, optionally with members. Reusable across SAC models.",
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string(),
      members: z.array(z.object({ id: z.string(), description: z.string().optional() })).optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ allowalteration, ...opts }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create public dimension");
        await ready();
        return toolSuccess(await createPublicDimension(opts));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_public_dimension_members_set",
    "Add or update members of a public dimension (resource id D…).",
    {
      resourceId: z.string(),
      members: z.array(z.object({ id: z.string(), description: z.string().optional() }).catchall(z.string())).min(1),
      allowalteration: z.boolean().optional(),
    },
    async ({ resourceId, members, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set public dimension members");
        await ready();
        await upsertPublicMembers(resourceId, members);
        return toolSuccess({ resourceId, members: members.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_dataaction_create",
    `Create a data action (planning sequence) on an SAC planning model with advanced-formula steps, e.g.
MEMBERSET [d/Measures] = ("Umsatz")  /  DATA() = RESULTLOOKUP([d/Version] = "public.Actual") * 1.1
The target version is chosen when the data action runs (do not put the version on the left side). Formulas are
validated first; validateOnly returns only the validation.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string(),
      cubeId: z.string().describe("Default model (SAC planning model id C…)"),
      steps: z.array(z.object({ name: z.string(), script: z.string(), description: z.string().optional() })).min(1),
      validateOnly: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ validateOnly, allowalteration, ...spec }) => {
      try {
        await ready();
        if (validateOnly) return toolSuccess({ validation: await validateDataAction(spec) });
        if (!allowalteration) return toolError(ALTERATION_MSG);
        assertWritable("create data action");
        return toolSuccess(await createDataAction(spec));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_dataaction_run",
    `Run a data action on a target version (e.g. public.Plan). autoPublish=true writes into the public version;
otherwise the result stays in the user's private edit of that version (like running it in a story without publishing).`,
    {
      dataActionId: z.string(),
      targetVersion: z.string().describe("Version member id, e.g. public.Plan"),
      autoPublish: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ dataActionId, targetVersion, autoPublish, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("run data action");
        await ready();
        return toolSuccess(await runDataAction({ dataActionId, targetVersion, autoPublish }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_multiaction_create",
    `Create a multi action whose steps run data actions one after another, each on a fixed target version
(e.g. copy Actual→Plan, then Plan +5 %). SAC validates the steps first; validateOnly=true only checks.
Run it afterwards with sac_multi_action_execute (id is returned; public API access is on by default).`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string().optional().describe("Default: defaults.folderId from the config"),
      steps: z
        .array(
          z.object({
            name: z.string().describe("Step label"),
            dataActionId: z.string(),
            targetVersion: z.string().describe("e.g. public.Plan"),
            autoPublish: z.boolean().optional(),
          }),
        )
        .min(1),
      publicApi: z.boolean().optional(),
      validateOnly: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ name, description, folderId, steps, publicApi, validateOnly, allowalteration }) => {
      try {
        await ready();
        if (validateOnly) return toolSuccess(await validateMultiAction(steps));
        if (!allowalteration) return toolError(ALTERATION_MSG);
        assertWritable("create multi action");
        const folder = folderId ?? config.defaults.folderId;
        if (!folder) throw new Error("folderId missing (and no defaults.folderId in the config)");
        return toolSuccess(await createMultiAction({ name, description, folderId: folder, steps, publicApi }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_canvas_create",
    `Empty canvas schablone for content added afterwards (planning tables, charts): header (40 px composite via
headerComposite, or classic), optional 40 px filter bar (container FP_FILTERBAR_ITEMS for input controls), and full-width
cards with a title row (heights in px). Optionally binds a planning model (native or Seamless) as data source.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string().optional(),
      title: z.string(),
      template: z.string().optional(),
      headerComposite: z.string().optional(),
      headerInverted: z.boolean().optional(),
      filterBar: z.boolean().optional(),
      cards: z.array(z.object({ title: z.string(), height: z.number().optional() })).min(1),
      model: z.string().optional().describe("Planning model (name or C… id) to bind as data source"),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create story");
        await ready();
        const folderId = args.folderId ?? config.defaults.folderId;
        if (!folderId) throw new Error("folderId missing (and no defaults.folderId in the config)");
        const assets = await listDesignAssets();
        if (!args.template)
          return toolSuccess({ needsInput: true, note: "Story was NOT created.", questions: [{ field: "template", question: "Which story template?", options: assets.templates.map((t) => t.name) }] });
        const t = assets.templates.find((x) => x.resourceId === args.template || x.name === args.template);
        if (!t) throw new Error(`Template '${args.template}' not found`);
        const user = await resolveUser(folderId);
        const headerComposite = args.headerComposite
          ? { compositeId: args.headerComposite, interfaceProperty: await compositePropertyValues(args.headerComposite, { Title: args.title }) }
          : undefined;
        const model = args.model ? await planningModel(args.model) : undefined;
        let out: { widgets: string[]; filterBar?: string; cards: string[] } = { widgets: [], cards: [] };
        const { storyId } = await createStoryFromTemplate({
          templateId: t.resourceId,
          name: args.name,
          description: args.description,
          folderId,
          user,
          prepare: async (_id, content) => {
            stripToBlankCanvasPage(content, PAGE_NAME(1));
            if (model) bindPlanningDataSource(content, model);
            out = buildCanvasSkeleton(content, PAGE_NAME(1), { title: args.title, headerInverted: args.headerInverted, headerComposite, filterBar: args.filterBar, cards: args.cards });
          },
        });
        return toolSuccess({ storyId, name: args.name, ...out, openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=edit` });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_planning_forecast_story_create",
    `Planning story with forecast layouts on a Seamless planning model (actuals to date, plan to year end, next year's quarters), in one call:
header (title), filter bar with the plan version (CIC_PLANVERSION — Actual stays fixed), card 1 "Forecast <year>": Actual
up to today, plan version up to year end, by month, with the year's sum; card 2 "Planung <year+1>": only "<year> (Ist +
Plan)" and the quarters of next year to plan. Months of next year are planned in-year later. Rows: one dimension; one measure.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string().optional(),
      title: z.string().describe("Page title in the header"),
      model: z.string().describe("Seamless planning model (name or C… id)"),
      rowDimension: z.string().describe("Dimension in the rows (name or description)"),
      measure: z.string().describe("Measure to plan (name or description)"),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create story");
        await ready();
        const folderId = args.folderId ?? config.defaults.folderId;
        if (!folderId) throw new Error("folderId missing (and no defaults.folderId in the config)");
        const model = await planningModel(args.model);
        const built = buildForecastStoryContent({ model, title: args.title, rowDimension: args.rowDimension, measure: args.measure });
        const assets = await listDesignAssets();
        if (!assets.templates.length) throw new Error("No story template found");
        const user = await resolveUser(folderId);
        let dropped: string[] = [];
        const { storyId } = await createStoryFromTemplate({
          templateId: assets.templates[0].resourceId,
          name: args.name,
          description: args.description,
          folderId,
          user,
          prepare: async (_id, content) => {
            for (const k of Object.keys(content)) delete content[k];
            Object.assign(content, built.content, { title: args.name });
            // the recorded template's theme/header composite may not exist on this tenant
            dropped = await dropMissingDependencies(content);
          },
        });
        return toolSuccess({
          ...(dropped.length ? { dropped } : {}),
          storyId,
          name: args.name,
          tables: built.tables,
          versionControl: "CIC_PLANVERSION",
          note: "The first display on Datasphere can take a few seconds.",
          openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=view`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
