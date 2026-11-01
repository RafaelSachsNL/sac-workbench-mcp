/**
 * Story authoring on top of SAC's internal content library.
 *
 * There is no public API to create a story with widgets. This tool replays the three calls the SAC UI
 * makes when you create a responsive story, add a Datasphere model and insert a table
 * (createTempContent → createContent [embedded model reference] → updateContentAndMoveResource),
 * recorded once into templates/story_table.json and parameterised here.
 */

import { newCubeId } from "../story/binding.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "../browser/session.js";
import { assertWritable, config, defaultOf } from "../config.js";
import { toolError, toolSuccess } from "./_helpers.js";
import { contentlib, ensureTenantPackage, outlineNames, RECORDED_PACKAGE } from "../story/content.js";
import { removeWidget } from "../story/fragments.js";
import { bindPlanningDataSource } from "../story/planning.js";
import { fetchModelMetadata, fetchSacModelMetadata, resolveDimension, resolveMeasure } from "../story/metadata.js";
import { sacModel } from "../story/planwrite.js";
import { dirOf } from "../paths.js";
import { metadataFor, searchDatasphere } from "../story/datasphere-search.js";

interface StoryTemplate {
  placeholders: Record<string, string>;
  createTempContent: { action: string; data: Record<string, unknown> };
  createContent: { action: string; data: Record<string, unknown> };
  updateContentAndMoveResource: { action: string; data: Record<string, unknown> };
}

const TEMPLATE_FILE = resolve(dirOf(import.meta.url), "..", "..", "templates", "story_table.json");

// Values are substituted into JSON that itself contains JSON strings (cdata), so they must not need escaping.
const SAFE_TEXT = /^[^"\\\n\r\t]*$/;
const SAFE_ID = /^[A-Za-z0-9_.:\-/]+$/;

/** SAC client-side cube ids look like "C" + 26 lowercase alphanumerics. */

/** Replace all placeholder values at once (longest first, via tokens) so overlapping values cannot collide. */
function substitute(json: string, from: Record<string, string>, to: Record<string, string>): string {
  const keys = Object.keys(from).sort((a, b) => from[b].length - from[a].length);
  for (const k of keys) json = json.split(from[k]).join(`\u0000${k}\u0000`);
  for (const k of keys) json = json.split(`\u0000${k}\u0000`).join(to[k] ?? from[k]);
  return json;
}

/** The SAC user id, derived from the target folder's ancestry (PRIVATE_<USER>). */
export async function resolveUser(folderId: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  if (config.user) return config.user;
  const res: Record<string, unknown> = await contentlib("getResourceEx", {
    resourceId: folderId,
    metadata: { name: true, ancestorPath: { name: true }, resourceType: true, createdBy: true },
  });
  const ancestors = (res.ancestorPath as { resourceId?: string }[] | undefined) ?? [];
  const priv = [folderId, ...ancestors.map((a) => a.resourceId ?? "")].find((id) => id.startsWith("PRIVATE_"));
  if (priv) return priv.slice("PRIVATE_".length);
  throw new Error("Could not determine the SAC user id (target folder is not under My Files). Pass userId or set user in sac-mcp.config.json.");
}

const FREE_AXIS_RE = /((\\*)"Axis\2":\2"Free\2",\2"OrderedDimensionNames\2":\[)([^\]]*)(\])/g;
const FREE_AXIS_TOKEN = "\u0000FREEAXIS\u0000";

// The repository view actions answer 403 unless the options block looks like the Files UI's.
const REPO_VIEW_OPTIONS = {
  metadata: {
    epmObjectDataToFetch: { CUBE: ["mode", "isRemote", "capability.simpleColumnNames"] },
    fetchEpmObjectTypes: ["CUBE"],
    fetchEpmObjectMetadata: false,
  },
  fetchEnhancedProperties: ["SIMPLE_COLUMN_NAMES", "MODE", "IS_REMOTE", "DATA_ANALYZER_INFO", "STORY_OPTIMIZED_INFO", "DEFAULT_VIEW_MODE"],
  sort: { key: "name", descending: false },
  includeTotalResourceCount: true,
};


export interface CreateTableStoryArgs {
  name: string;
  description: string;
  folderId: string;
  connection: string;
  space: string;
  model: string;
  rowDimension: string;
  measure: string;
  userId?: string;
}

/** New responsive story with one table, saved into folderId (see the module comment). */
export async function createTableStory(args: CreateTableStoryArgs) {
  for (const k of ["name", "description"] as const)
    if (!SAFE_TEXT.test(args[k])) throw new Error(`${k} must not contain quotes, backslashes or line breaks`);
  for (const k of ["folderId", "connection", "space", "model", "rowDimension", "measure"] as const)
    if (!SAFE_ID.test(args[k])) throw new Error(`${k} contains unsupported characters`);

  await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
  const tpl = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8")) as StoryTemplate;
  const ph = { ...tpl.placeholders, tenantPackage: RECORDED_PACKAGE };
  const user = await resolveUser(args.folderId, args.userId);
  const pkg = await ensureTenantPackage();
  const meta = await fetchModelMetadata(args.connection, args.space, args.model);
  const row = resolveDimension(meta, args.rowDimension);
  const measure = resolveMeasure(meta, args.measure);
  const values: Record<string, string> = {
    user,
    folderId: args.folderId,
    name: args.name,
    description: args.description,
    connection: args.connection,
    space: args.space,
    model: args.model,
    rowName: row.name,
    rowKey: row.key,
    rowCaption: row.caption,
    measure,
    cubeId: newCubeId(),
    tenantPackage: pkg,
  };

  // 1. temporary story (gets a fresh server-side id)
  const temp = JSON.parse(substitute(JSON.stringify(tpl.createTempContent), ph, values));
  const created = await contentlib(temp.action, temp.data);
  const storyId = created.resourceId as string;
  if (!storyId) throw new Error(`createTempContent returned no resourceId: ${JSON.stringify(created).slice(0, 500)}`);
  values.storyId = storyId;

  // 2. embedded model reference under the story
  const cube = JSON.parse(substitute(JSON.stringify(tpl.createContent), ph, values));
  await contentlib(cube.action, cube.data);

  // 3. story content with the table, moved from TEMP into the target folder
  // The query lists every non-row/column dimension on the Free axis; rebuild it for this model and row.
  let freeQuote = '"';
  let saveJson = JSON.stringify(tpl.updateContentAndMoveResource).replace(FREE_AXIS_RE, (_m, head, bs, _list, tail) => {
    freeQuote = bs + '"';
    return head + FREE_AXIS_TOKEN + tail;
  });
  saveJson = substitute(saveJson, ph, values);
  const free = meta.allDimensionNames.filter((n) => n !== row.name && n !== "CustomDimension1" && n !== "$$Cells$$");
  saveJson = saveJson.split(FREE_AXIS_TOKEN).join(free.map((n) => freeQuote + n + freeQuote).join(","));
  const save = JSON.parse(saveJson);
  // see insertFragment: no pre-executed table query when the row dimension has no text attribute
  if (!row.text) {
    const storyData = save.data.cdata.content.entities.find((e: { type?: string }) => e.type === "story").data;
    storyData.preExecuteUqmQueryIds = (storyData.preExecuteUqmQueryIds ?? []).filter((q: string) => !q.includes("table2"));
  }
  const saved = await contentlib(save.action, save.data);

  return { storyId, saved, row, measure };
}

/**
 * New responsive story for an SAC planning model (native or Seamless): the recorded table story without its
 * Datasphere parts — the table, its dataset and the embedded model reference are left out, the SAC model's dataset
 * is bound instead. Returns the story id; the lane is empty.
 */
export async function createSacResponsiveStory(args: {
  name: string;
  description: string;
  folderId: string;
  model: { name: string; dataSource: { SchemaName: string; ObjectName: string; System?: string }; analytic?: boolean };
  userId?: string;
}): Promise<{ storyId: string }> {
  for (const k of ["name", "description"] as const)
    if (!SAFE_TEXT.test(args[k])) throw new Error(`${k} must not contain quotes, backslashes or line breaks`);
  if (!SAFE_ID.test(args.folderId)) throw new Error("folderId contains unsupported characters");
  await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
  const tpl = JSON.parse(readFileSync(TEMPLATE_FILE, "utf8")) as StoryTemplate;
  const ph = { ...tpl.placeholders, tenantPackage: RECORDED_PACKAGE };
  const user = await resolveUser(args.folderId, args.userId);
  const pkg = await ensureTenantPackage();
  // model values stay as recorded: everything that uses them is removed below
  const values: Record<string, string> = { ...ph, user, folderId: args.folderId, name: args.name, description: args.description, tenantPackage: pkg };

  const temp = JSON.parse(substitute(JSON.stringify(tpl.createTempContent), ph, values));
  const created = await contentlib(temp.action, temp.data);
  const storyId = created.resourceId as string;
  if (!storyId) throw new Error(`createTempContent returned no resourceId: ${JSON.stringify(created).slice(0, 500)}`);
  values.storyId = storyId;

  const save = JSON.parse(substitute(JSON.stringify(tpl.updateContentAndMoveResource), ph, values));
  const content = save.data.cdata.content;
  const table = [...outlineNames(content).values()].find((n) => n.kind === "table2");
  if (table) removeWidget(content, table.name);
  content.entities = content.entities.filter((e: { type?: string }) => e?.type !== "dataset" && e?.type !== "datasetAlias");
  const story = content.entities.find((e: { type?: string }) => e.type === "story").data;
  story.persistedUqmQuery = [];
  story.preExecuteUqmQueryIds = [];
  // no metadata cache: a cached one of another model makes SAC reconcile against that model
  story.persistedUdm = [];
  story.uqmRemoteSystemNames = args.model.dataSource.System ? [args.model.dataSource.System] : [];
  story.lastDataSource = bindPlanningDataSource(content, args.model);
  await contentlib(save.action, save.data);
  return { storyId };
}

export function registerStoryTools(server: McpServer): void {
  server.tool(
    "sac_files_list",
    "List a folder in the SAC file repository (internal Files API): sub-folders, stories, models, etc. with resource ids.",
    {
      folderId: z.string().describe("Folder resourceId, e.g. PRIVATE_<USER> (My Files), PUBLIC, or a folder id"),
      limit: z.number().optional().default(150),
      offset: z.number().optional().default(0),
    },
    async ({ folderId, limit, offset }) => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        // Same call the Files UI makes when opening a folder (getRepoView returns the parent's view instead).
        const res = await contentlib("getAncestorAndSubNodes", {
          resourceId: folderId,
          filter: [],
          bIncTemporary: false,
          detail: false,
          allowAuthOverride: false,
          options: { ...REPO_VIEW_OPTIONS, limit, offset },
        });
        const pick = (r: Record<string, unknown>) => ({
          resourceId: r.resourceId,
          resourceType: r.resourceType,
          name: r.name,
          description: r.description,
          createdBy: r.createdBy,
          modifiedTime: r.modifiedTime,
        });
        const lists = Object.entries(res).filter(
          ([k, v]) => k !== "ancestorNodes" && Array.isArray(v) && typeof v[0] === "object",
        ) as [string, Record<string, unknown>[]][];
        return toolSuccess({
          path: ((res.ancestorNodes as Record<string, unknown>[] | undefined) ?? []).map((a) => a.name).join(" / "),
          ...Object.fromEntries(lists.map(([k, v]) => [k, v.map(pick)])),
          ...(res.totalResourceCount !== undefined ? { totalResourceCount: res.totalResourceCount } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_datasphere_search",
    `Search Datasphere objects through the SAC live connection (no Datasphere login): model name or words → technical
name, business name, space, kind, connection. Use it to find the space of a model before sac_model_metadata or
sac_story_generate_dashboard. Without connection all known Datasphere connections are searched.`,
    {
      query: z.string().describe("Technical name or words of the business name, e.g. SD_RL_BILLINGITEM or 'billing items'"),
      connection: z.string().optional(),
      kind: z.enum(["analyticModel", "all"]).optional().describe("Default analyticModel"),
      top: z.number().int().min(1).max(100).optional(),
    },
    async ({ query, connection, kind, top }) => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const hits = await searchDatasphere({ query, connection, kind: kind ?? "analyticModel", top });
        return toolSuccess({ count: hits.length, results: hits });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_model_metadata",
    "Live metadata of a model as SAC sees it: dimensions (technical name, caption, key/text attribute) and measures. Datasphere analytic models through the live connection (space/connection may be omitted: found via the Datasphere search) and SAC planning models, native or Seamless (model name or C… id, no connection/space).",
    {
      connection: z.string().optional().describe("SAC live connection name to Datasphere (default: found by the search, else config)"),
      space: z.string().optional().describe("Datasphere space (schema); default: found by the search, else config"),
      model: z.string().describe("Analytic model technical name, or SAC planning model name / C… id"),
    },
    async ({ connection, space, model }) => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const sac = connection || space ? undefined : await sacModel(model).catch(() => undefined);
        if (sac) {
          const meta = await fetchSacModelMetadata(sac.endpoint, sac.dataSource, sac.name);
          return toolSuccess({
            source: { kind: sac.dataSource.System ? "seamless" : "sac", ...(sac.analytic ? { analytic: true } : {}), model: sac.name, cubeId: sac.cubeId, description: sac.description },
            dimensions: meta.dimensions.filter((d) => !d.plain).map(({ plain, ...d }) => d),
            planningDimensions: sac.dimensions,
            measures: meta.measures,
            note: `SAC ${sac.analytic ? "analytic" : "planning"} model: the dashboard generator filters every widget to Version Actual; KPI tiles can filter Version (e.g. public.Plan) or a dynamic date range (Date).`,
          });
        }
        const located = await metadataFor(model, connection, space);
        const meta = located.meta;
        return toolSuccess({
          source: { connection: located.connection, space: located.space, ...(located.resolved ? { foundBySearch: true } : {}) },
          dimensions: meta.dimensions.filter((d) => !d.plain).map(({ plain, ...d }) => d),
          plainDimensions: meta.dimensions.filter((d) => d.plain).map((d) => d.name),
          measures: meta.measures,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_create_table",
    `Create a new responsive story containing one table (rows: one dimension, columns: one measure) bound to a
Datasphere analytic model via a live connection, and save it into a folder. Uses SAC's internal content library
(the same calls the story editor makes). Returns the new story id and URL.
Example: model DEMO_SALES_MODEL in space DEMO_SPACE on connection DWC_LIVE, rowDimension DJ_State, measure Gross_Sales.`,
    {
      name: z.string().describe("Story name"),
      description: z.string().optional().default(""),
      folderId: z.string().describe("Target folder resourceId (e.g. from sac_contentlib getRepoView); 'PRIVATE_<USER>' for My Files root"),
      connection: z.string().optional().transform((v) => v ?? defaultOf("connection")).describe("SAC live connection name to Datasphere"),
      space: z.string().optional().transform((v) => v ?? defaultOf("space")).describe("Datasphere space (schema)"),
      model: z.string().describe("Datasphere analytic model technical name"),
      rowDimension: z.string().describe("Row dimension: caption as shown in SAC (e.g. DJ_State) or InA name (e.g. _DJ_State_ID); see sac_model_metadata"),
      measure: z.string().describe("Measure name (e.g. Gross_Sales); see sac_model_metadata"),
      userId: z.string().optional().describe("SAC user id; derived from the folder if it is under My Files"),
      allowalteration: z.boolean().optional().describe("Must be true to execute"),
    },
    async (args) => {
      if (!args.allowalteration)
        return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("create story");
        const { storyId, saved, row, measure } = await createTableStory(args);
        return toolSuccess({
          storyId,
          name: saved.name,
          parentResId: saved.parentResId,
          ownerType: saved.ownerType,
          model: `${args.connection}/${args.space}/${args.model}`,
          table: { rows: `${row.caption} (${row.name})`, measure },
          openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?type=RESPONSIVE&mode=view`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_folder_create",
    "Create a folder (e.g. below My Files / SANDBOX). Returns its resourceId.",
    { parentId: z.string(), name: z.string(), description: z.string().optional(), allowalteration: z.boolean().optional() },
    async ({ parentId, name, description, allowalteration }) => {
      if (!allowalteration) return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("create folder");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const res = await contentlib("createFolder", { parentResId: parentId, name, description: description ?? "" });
        return toolSuccess({ folderId: res.resourceId, name: res.name, parentId: res.parentResId });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_resource_move",
    "Move stories, insights, models or folders into another folder.",
    { resourceIds: z.array(z.string()).min(1), targetFolderId: z.string(), allowalteration: z.boolean().optional() },
    async ({ resourceIds, targetFolderId, allowalteration }) => {
      if (!allowalteration) return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("move resources");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        await contentlib("moveResource", { resourceIds, targetParentResId: targetFolderId });
        return toolSuccess({ moved: resourceIds, targetFolderId });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_resource_rename",
    "Rename a story, insight, model or folder (name and optional description).",
    { resourceId: z.string(), name: z.string(), description: z.string().optional(), allowalteration: z.boolean().optional() },
    async ({ resourceId, name, description, allowalteration }) => {
      if (!allowalteration) return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("rename resource");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const res = await contentlib("renameResource", { resourceId, name, ...(description !== undefined ? { description } : {}) });
        return toolSuccess({ resourceId, name: res?.name ?? name });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_resource_delete",
    `Move stories, insights, models, themes or folders to Deleted Files (recoverable there, like Delete in Files).
Only delete objects the user asked for.`,
    { resourceIds: z.array(z.string()).min(1), allowalteration: z.boolean().optional() },
    async ({ resourceIds, allowalteration }) => {
      if (!allowalteration) return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("delete resources");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        await contentlib("stageDeleteList", { resourceIds, deleteOpt: { onRemote: true } });
        return toolSuccess({ movedToDeletedFiles: resourceIds });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
