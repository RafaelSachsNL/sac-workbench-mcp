/**
 * One-shot dashboard generator: story + layout + widgets + filter + theme from a single description.
 *
 * Layout on the 36-column lane (responsive):
 *   TE_TITLE_001                       title text, full width
 *   FP_KPI → CH_KPI_<…>_001 …          KPI row in a flow panel, tiles share the width
 *   CH_BAR_<…>_001  CH_BAR_<…>_002     charts, two per row
 *   TA_<…>_001                         table, full width
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable, config } from "../config.js";
import { appEntity, loadStory, outlineNames, saveStory, storyEntity } from "../story/content.js";
import { addStoryFilter } from "../story/filters.js";
import { insertFragment, removeWidget, storyModel, type Fragment, type ModelRef, type Position } from "../story/fragments.js";
import { fetchModelMetadata, measureCaption, resolveDimension, resolveMeasure } from "../story/metadata.js";
import { conventionName, PAGE_NAME } from "../story/naming.js";
import { applyThemeProfile, listThemeProfiles } from "../story/themes.js";
import { applyThemeResource } from "../story/theme-create.js";
import { metadataFor } from "../story/datasphere-search.js";
import { listDesignAssets } from "../story/assets.js";
import { listModels } from "../story/models.js";
import { browser } from "../browser/session.js";
import { applyMinimalStyle, formatTableNumbers, formatViz, scaleFor, type Scale } from "../story/format.js";
const SCALE = z.enum(["Default", "Unformatted", "Thousand", "Million", "Billion", "Auto-Formatted"]);
const KPI_FILTER = z.object({
  dimension: z.string(),
  members: z.array(z.string()).optional(),
  hierarchy: z.string().optional(),
  dynamic: z.object({ granularity: z.enum(["year", "quarter", "month", "day"]), last: z.number().optional(), next: z.number().optional() }).optional(),
});
import { stripToBlankCanvasPage } from "../story/canvas.js";
import { buildCanvasDashboard } from "../story/canvas-dashboard.js";
import { compositePropertyValues, describeComposite } from "../story/composite.js";

const isLean = (c: { height?: number; properties: string[] }) => (c.height ?? 999) <= 48 && c.properties.includes("Title");
import { bindModel } from "../story/binding.js";
import { createSacResponsiveStory, createTableStory, resolveUser } from "./story.js";
import { sacModel, type PlanningModel } from "../story/planwrite.js";
import { fetchSacModelMetadata, type ModelMetadata } from "../story/metadata.js";
import { addTableVersionFilter, sacDatasetIdOf, sacModelRef, setTableTitle, toSacFragment, withVersion } from "../story/sac-fragments.js";
import { bindPlanningDataSource } from "../story/planning.js";
import { applyChart } from "../story/chart.js";
import { createStoryFromTemplate } from "../story/template.js";
import { toolError, toolSuccess } from "./_helpers.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const FRAGMENT_DIR = resolve(dirOf(import.meta.url), "..", "..", "templates", "fragments");
const fragment = (name: string) => JSON.parse(readFileSync(join(FRAGMENT_DIR, `${name}.json`), "utf8")) as Fragment;

const LANE_COLUMNS = 36;

function setPosition(content: Json, widgetId: string, pos: Position) {
  for (const page of storyEntity(content).data.pages)
    for (const layout of page.content?.layouts ?? [])
      for (const section of layout.definition?.page?.sections ?? [])
        for (const w of section.widgets ?? [])
          if (w.widgetId === widgetId) Object.assign(w.definition.dynamicLayout, pos);
}

interface CanvasArgs {
  name: string;
  description: string;
  folderId: string;
  connection: string;
  space: string;
  model: string;
  title: string;
  filters?: (string | { dimension: string; label?: string })[];
  kpis: { measure: string; label?: string; scale?: Scale; decimals?: number; filters?: z.infer<typeof KPI_FILTER>[] }[];
  charts: { dimension: string; measure: string; label?: string; scale?: Scale; decimals?: number }[];
  table?: { dimension: string; measure: string; label?: string };
  filter?: { dimension: string; members: (string | { key: string; caption?: string })[] };
  theme?: string;
  template?: string;
  headerInverted?: boolean;
  headerComposite?: string;
  scale: Scale;
  decimals: number;
}

/** Canvas: new story from the template, reduced to one blank page, model bound, schablone built — saved once. */
async function generateCanvas(args: CanvasArgs) {
  if (!args.template || args.template === "none")
    throw new Error("The canvas layout builds on a story template that brings the Horizon CSS (card, card_Header) — pick one, e.g. the Horizon template");
  const assets = await listDesignAssets();
  const t = assets.templates.find((x) => x.resourceId === args.template || x.name === args.template);
  if (!t) throw new Error(`Template '${args.template}' not found. Available: ${assets.templates.map((x) => x.name).join(", ")}`);
  const theme = args.theme && args.theme !== "none" ? args.theme : undefined;
  const user = await resolveUser(args.folderId);
  const meta = await fetchModelMetadata(args.connection, args.space, args.model);
  let widgets: string[] = [];
  const headerComposite = args.headerComposite
    ? { compositeId: args.headerComposite, interfaceProperty: await compositePropertyValues(args.headerComposite, { Title: args.title.split("\n")[0] }) }
    : undefined;
  const { storyId } = await createStoryFromTemplate({
    templateId: t.resourceId,
    name: args.name,
    description: args.description,
    folderId: args.folderId,
    user,
    prepare: async (storyId, content) => {
      stripToBlankCanvasPage(content, PAGE_NAME(1));
      const model = await bindModel(content, storyId, user, { connection: args.connection, space: args.space, model: args.model });
      widgets = buildCanvasDashboard(content, PAGE_NAME(1), model, meta, {
        title: args.title,
        headerInverted: args.headerInverted ?? false,
        headerComposite,
        filters: args.filters,
        kpis: args.kpis,
        charts: args.charts,
        table: args.table,
        scale: args.scale,
        decimals: args.decimals,
      });
      if (args.filter) {
        const dim = resolveDimension(meta, args.filter.dimension);
        addStoryFilter(content, model, dim, args.filter.members.map((m) => (typeof m === "string" ? { key: m } : m)));
      }
      // a captured profile if there is one, else the theme resource itself (never silently the template's theme)
      if (theme) {
        if (listThemeProfiles().includes(theme)) applyThemeProfile(content, theme);
        else await applyThemeResource(content, theme);
      }
    },
  });
  return {
    storyId,
    name: args.name,
    template: t.name,
    theme: theme ?? "from template",
    widgets,
    openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=view`,
  };
}

interface SacGenArgs {
  name: string;
  description: string;
  folderId: string;
  title: string;
  kpis: { measure: string; label?: string; scale?: Scale; decimals?: number; filters?: z.infer<typeof KPI_FILTER>[] }[];
  charts: { dimension: string; measure: string; label?: string; scale?: Scale; decimals?: number }[];
  table?: { dimension: string; measure: string; label?: string };
  theme?: string;
  template?: string;
  headerInverted?: boolean;
  headerComposite?: string;
  scale: Scale;
  decimals: number;
  filters?: (string | { dimension: string; label?: string })[];
  filter?: { dimension: string; members: (string | { key: string; caption?: string })[] };
}

/** Story filter on an SAC model: before the widgets, so their queries carry it from the start. */
function addSacStoryFilter(content: Json, meta: ModelMetadata, model: ModelRef, datasetId: string, filter: SacGenArgs["filter"]) {
  if (!filter) return;
  const dim = resolveDimension(meta, filter.dimension);
  addStoryFilter(content, model, dim, filter.members.map((x) => (typeof x === "string" ? { key: x } : x)), datasetId);
}

/** Canvas on an SAC model (planning or analytic): the Horizon schablone from a story template, widgets rewritten for the model. */
async function generateSacCanvas(args: SacGenArgs, m: PlanningModel) {
  if (!args.template || args.template === "none")
    throw new Error("The canvas layout builds on a story template that brings the Horizon CSS (card, card_Header) — pick one, e.g. the Horizon template");
  const assets = await listDesignAssets();
  const t = assets.templates.find((x) => x.resourceId === args.template || x.name === args.template);
  if (!t) throw new Error(`Template '${args.template}' not found. Available: ${assets.templates.map((x) => x.name).join(", ")}`);
  const ds = m.dataSource as { SchemaName: string; ObjectName: string; System?: string };
  const meta: ModelMetadata = await fetchSacModelMetadata(m.endpoint, ds, m.name);
  const theme = args.theme && args.theme !== "none" ? args.theme : undefined;
  const user = await resolveUser(args.folderId);
  const headerComposite = args.headerComposite
    ? { compositeId: args.headerComposite, interfaceProperty: await compositePropertyValues(args.headerComposite, { Title: args.title.split("\n")[0] }) }
    : undefined;
  let widgets: string[] = [];
  const { storyId } = await createStoryFromTemplate({
    templateId: t.resourceId,
    name: args.name,
    description: args.description,
    folderId: args.folderId,
    user,
    prepare: async (_storyId, content) => {
      stripToBlankCanvasPage(content, PAGE_NAME(1));
      const datasetId = bindPlanningDataSource(content, { name: m.name, dataSource: ds, analytic: m.analytic });
      const story = storyEntity(content).data;
      story.lastDataSource = datasetId;
      story.uqmRemoteSystemNames = [...new Set([...(story.uqmRemoteSystemNames ?? []), ...(ds.System ? [ds.System] : [])])];
      addSacStoryFilter(content, meta, sacModelRef(m.cubeId, ds), datasetId, args.filter);
      widgets = buildCanvasDashboard(content, PAGE_NAME(1), sacModelRef(m.cubeId, ds), meta, {
        title: args.title,
        headerInverted: args.headerInverted ?? false,
        headerComposite,
        kpis: args.kpis,
        charts: args.charts,
        table: args.table,
        filters: args.filters,
        scale: args.scale,
        decimals: args.decimals,
        planning: {
          datasetId,
          rewrite: (frag, dimensions) => toSacFragment(frag, m.cubeId, ds, m.name, { dimensions, allDimensionNames: meta.allDimensionNames }),
        },
      });
      if (theme) {
        if (listThemeProfiles().includes(theme)) applyThemeProfile(content, theme);
        else await applyThemeResource(content, theme);
      }
    },
  });
  return {
    storyId,
    name: args.name,
    model: { name: m.name, kind: ds.System ? "seamless" : m.analytic ? "sac (analytic)" : "sac" },
    template: t.name,
    theme: theme ?? "from template",
    widgets,
    openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=view`,
  };
}

/** Responsive dashboard on an SAC model (planning or analytic): same layout as the Datasphere path, widgets rewritten for the model. */
async function generateSacResponsive(args: SacGenArgs, m: PlanningModel) {
  if (args.filters?.length) throw new Error("Input controls (filters) need the canvas layout — use filter for a story filter");
  const ds = m.dataSource as { SchemaName: string; ObjectName: string; System?: string };
  const meta: ModelMetadata = await fetchSacModelMetadata(m.endpoint, ds, m.name);
  const theme = args.theme === "none" ? undefined : args.theme;
  const { storyId } = await createSacResponsiveStory({ name: args.name, description: args.description, folderId: args.folderId, model: { name: m.name, dataSource: ds, analytic: m.analytic } });

  const story = await loadStory(storyId);
  const c = story.content;
  const model = sacModelRef(m.cubeId, ds);
  addSacStoryFilter(c, meta, model, sacDatasetIdOf(ds), args.filter);
  const allMeasures = meta.measures.map((x) => x.name);
  const names = appEntity(c).app.names as Record<string, string>;
  const taken = () => [...outlineNames(c).values()].map((n) => n.name);
  const lane = [...outlineNames(c).values()].find((n) => n.kind === "gridlane")?.name;
  if (!lane) throw new Error("Template story has no lane");
  for (const [, n] of outlineNames(c)) if (n.kind === "appPage") names[n.key] = PAGE_NAME(1);

  const created: string[] = [];
  const name = (frag: string, content: string) => {
    const n = conventionName(frag, content, taken());
    created.push(n);
    return n;
  };
  const add = (frag: string, opts: { name: string; container: string; position: Position; dims?: string[]; measures?: string[]; html?: string }) => {
    const dimensions = (opts.dims ?? []).map((d) => resolveDimension(meta, d));
    return insertFragment(c, toSacFragment(fragment(frag), m.cubeId, ds, m.name, { dimensions, allDimensionNames: meta.allDimensionNames }), {
      container: opts.container,
      outlineName: opts.name,
      position: opts.position,
      model,
      dimensions,
      measures: (opts.measures ?? []).map((x) => resolveMeasure(meta, x)),
      allMeasures,
      html: opts.html,
    });
  };

  let top = 0;
  const [headline, ...sub] = args.title.split("\n");
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const titleHtml =
    `<p><span style="font-size:28px;font-weight:bold">${esc(headline)}</span></p>` +
    sub.map((l) => `<p><span style="font-size:14px;color:#556b82">${esc(l)}</span></p>`).join("");
  // a subtitle needs a fourth grid row, otherwise it is cut off
  const titleRows = sub.length ? 4 : 3;
  add("text", { name: name("text", "Title"), container: lane, position: { left: 0, top, width: LANE_COLUMNS, height: titleRows }, html: titleHtml });
  top += titleRows;

  if (args.kpis.length) {
    const fp = name("flow_panel", "KPI");
    add("flow_panel", { name: fp, container: lane, position: { left: 0, top, width: LANE_COLUMNS, height: 7 } });
    const width = Math.floor(100 / args.kpis.length);
    for (const k of args.kpis) {
      const kpi = name("kpi_numeric_point", k.label ?? k.measure);
      add("kpi_numeric_point", { name: kpi, container: fp, position: { left: 0, top: 0, width, widthUnit: "percent", height: 130, heightUnit: "pixel" }, measures: [k.measure] });
      applyChart(c, kpi, { type: "metric", measures: [resolveMeasure(meta, k.measure)], filters: withVersion(k.filters) });
      formatViz(c, kpi, { title: k.label, scale: scaleFor(k, args.scale, measureCaption(meta, k.measure)), decimals: k.decimals ?? args.decimals });
      applyMinimalStyle(c, kpi);
    }
    top += 7;
  }

  args.charts.forEach((ch, i) => {
    const half = LANE_COLUMNS / 2;
    const last = i === args.charts.length - 1 && i % 2 === 0;
    const chart = name("chart_bar", ch.label ?? `${ch.measure} by ${ch.dimension}`);
    add("chart_bar", {
      name: chart,
      container: lane,
      position: { left: i % 2 === 0 ? 0 : half, top: top + Math.floor(i / 2) * 14, width: last ? LANE_COLUMNS : half, height: 14 },
      dims: [ch.dimension],
      measures: [ch.measure],
    });
    applyChart(c, chart, { filters: withVersion([]) });
    formatViz(c, chart, { title: ch.label, scale: scaleFor(ch, args.scale, measureCaption(meta, ch.measure)), decimals: ch.decimals ?? args.decimals });
    applyMinimalStyle(c, chart);
  });
  top += Math.ceil(args.charts.length / 2) * 14;

  // table: the Datasphere table fragment rewritten like the charts, plus the Version filter planning models need
  if (args.table) {
    const tableName = name("table", args.table.label ?? args.table.measure);
    const measure = resolveMeasure(meta, args.table.measure);
    const table = add("table", {
      name: tableName,
      container: lane,
      position: { left: 0, top, width: LANE_COLUMNS, height: 16 },
      dims: [args.table.dimension],
      measures: [args.table.measure],
    });
    addTableVersionFilter(c, table.widgetId, sacDatasetIdOf(ds));
    setTableTitle(c, table.widgetId, args.table.label ?? m.name);
    formatTableNumbers(c, tableName, [measure], { scale: scaleFor({ measure }, args.scale, measureCaption(meta, measure)), decimals: args.decimals });
  }

  if (theme) {
    if (listThemeProfiles().includes(theme)) applyThemeProfile(c, theme);
    else await applyThemeResource(c, theme);
  }
  const saved = await saveStory(story);
  return {
    storyId,
    name: args.name,
    model: { name: m.name, kind: ds.System ? "seamless" : m.analytic ? "sac (analytic)" : "sac" },
    widgets: [...outlineNames(c).values()].map((n) => n.name),
    updateCounter: saved.updateCounter,
    openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?type=RESPONSIVE&mode=view`,
  };
}

export function registerDashboardTools(server: McpServer): void {
  server.tool(
    "sac_story_generate_dashboard",
    `Follow docs/STORY_GUIDELINES.md (MCP prompt story_guidelines). Without theme, template and layout this tool
returns needsInput with options instead of creating anything — ask the user, then call again.
Generate a complete dashboard story in one step: title, KPI row (numeric points), bar charts (two per row) and a table,
optionally a story filter and a theme profile.
- responsive: one lane (template 'none').
- canvas: schablone on a story template with the Horizon CSS (e.g. "Horizon Template"): fixed 72 px header
  (card_Header, optionally inverted), fixed KPI row (up to 5 cards), scrolling body with cards (class card, radius 12),
  10 px spacing everywhere. All widgets are bound to one
Datasphere analytic model and named after the convention (TE_TITLE_001, FP_KPI, CH_KPI_SALES_001, CH_BAR_…, TA_…).
- SAC models — planning (native or Seamless) and analytic; pass the model name, no connection/space: responsive or canvas
  (with a story template); story filter (filter) in both, input controls (filters) on canvas; every widget is filtered to Version Actual unless a KPI names its own Version filter. With one measure,
  KPI tiles differ by their filters (e.g. Version public.Plan, dynamic year/month).
Dimensions/measures accept captions or technical names (see sac_model_metadata).`,
    {
      name: z.string().describe("Story name"),
      description: z.string().optional().default(""),
      folderId: z.string(),
      connection: z.string().optional().describe("Default: found by the Datasphere search, else config"),
      space: z.string().optional().describe("Datasphere space; default: found by the Datasphere search (never silently the config default when the model lives elsewhere)"),
      model: z.string().optional().describe("Datasphere model (technical name) or SAC planning model (name or C… id). If omitted the tool returns the available models instead of creating the story"),
      title: z.string().describe("Title text on top of the page; '\\n' starts a second line (subtitle)"),
      filters: z
        .array(z.union([z.string(), z.object({ dimension: z.string(), label: z.string().optional() })]))
        .max(6)
        .optional()
        .describe("Canvas: dimensions with an input control in the fixed control bar (e.g. DJ_State); {dimension, label} when the model only has technical names (Datasphere: FISCALYEAR → 'Fiscal Year')"),
      kpis: z
        .array(
          z.object({
            measure: z.string(),
            label: z.string().optional(),
            scale: SCALE.optional(),
            decimals: z.number().int().min(0).max(7).optional(),
            filters: z.array(KPI_FILTER).optional().describe("Filters of this tile only, e.g. Version or a dynamic date range — lets several tiles show one measure"),
          }),
        )
        .max(6)
        .default([]),
      charts: z.array(z.object({ dimension: z.string(), measure: z.string(), label: z.string().optional(), scale: SCALE.optional(), decimals: z.number().int().min(0).max(7).optional() })).max(6).default([]),
      table: z.object({ dimension: z.string(), measure: z.string(), label: z.string().optional() }).optional().describe("Omit for a dashboard without a table"),
      filter: z
        .object({
          dimension: z.string(),
          members: z.array(z.union([z.string(), z.object({ key: z.string(), caption: z.string().optional() })])).min(1),
        })
        .optional()
        .describe("Story filter; members are member keys (e.g. PC2)"),
      theme: z.string().optional().describe("Theme profile (e.g. MY_THEME) or 'none'. If omitted the tool returns the available themes instead of creating the story"),
      template: z.string().optional().describe("Story template name or 'none'. If omitted and templates exist, the tool asks"),
      layout: z.enum(["responsive", "canvas"]).optional().describe("Page layout. If omitted the tool asks"),
      headerInverted: z.boolean().optional().describe("Canvas only: dark header with white title. If omitted for a canvas the tool asks"),
      headerComposite: z.string().optional().describe("Canvas only: id of a header composite (sac_composite_header_create) used instead of the built-in header; its Title is set to the title"),
      scale: SCALE.optional().default("Million").describe("Number scale for KPIs and charts without their own scale; percentage measures (%, PCT, PERCENT in name/label) default to unscaled"),
      decimals: z.number().int().min(0).max(7).optional().default(1),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration)
        return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("generate dashboard");

        // guidelines: theme, template and layout are decided with the user, never silently defaulted.
        const questions: { field: string; question: string; options: unknown[]; recommended?: string }[] = [];
        if (args.model === undefined) {
          await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
          const models = await listModels();
          questions.push({
            field: "model",
            question: "Which data model should be used? (answer: model + connection + space)",
            options: [...models.filter((m) => m.supported), ...models.filter((m) => !m.supported)],
            recommended: models.find((m) => m.supported)?.model,
          });
        }
        if (args.theme === undefined || args.template === undefined) {
          await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
          const assets = await listDesignAssets();
          if (args.theme === undefined)
            questions.push({
              field: "theme",
              question: "Which theme should the story use?",
              options: [...assets.themes.map((t) => ({ name: t.name, modified: t.modifiedTime.slice(0, 10), recommended: t.recommended, reason: t.reason, profileAvailable: listThemeProfiles().includes(t.name) })), { name: "none" }],
              recommended: assets.themes.find((t) => t.recommended)?.name,
            });
          if (args.template === undefined && assets.templates.length)
            questions.push({
              field: "template",
              question: "Should a story template be used?",
              options: [...assets.templates.map((t) => ({ name: t.name, modified: t.modifiedTime.slice(0, 10), recommended: t.recommended, reason: t.reason })), { name: "none" }],
              recommended: assets.templates.find((t) => t.recommended)?.name,
            });
        }
        if (args.layout === undefined)
          questions.push({ field: "layout", question: "Responsive layout or canvas layout?", options: ["responsive", "canvas"] });
        if (args.layout !== "responsive" && args.headerInverted === undefined && !args.headerComposite) {
          // the lean 40 px header composite is recommended; the classic 72 px header remains (inverted or not)
          await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
          // lean = the 40 px kind (≤ 48 px canvas) with a Title property; others are listed but not recommended
          const found = (await listDesignAssets()).composites.filter((c) => /header/i.test(c.name)).slice(0, 8);
          const headers = (
            await Promise.all(found.map(async (c) => ({ ...c, ...(await describeComposite(c.resourceId).catch(() => ({ properties: [] as string[], height: undefined }))) })))
          ).sort((a, b) => Number(isLean(b)) - Number(isLean(a)));
          questions.push({
            field: headers.length ? "headerComposite | headerInverted" : "headerInverted",
            question: headers.length
              ? "Which header? Recommended: header composite (40 px, title only) – or the classic 72 px header (normal/inverted)."
              : "Should the header be inverted (dark with white text)? (Leaner: create sac_composite_header_create once and use it as headerComposite.)",
            options: [
              ...headers.map((c) => ({ headerComposite: c.resourceId, name: c.name, height: c.height, properties: c.properties, lean: isLean(c) })),
              { headerInverted: false },
              { headerInverted: true },
            ],
            ...(headers.find(isLean) ? { recommended: headers.find(isLean)!.name } : {}),
          });
        }
        if (questions.length)
          return toolSuccess({
            needsInput: true,
            note: "Story was NOT created. Please clarify the questions with the user and repeat the call with the answers.",
            questions,
          });
        const modelName = args.model!;
        // SAC models (planning native/Seamless, analytic) are bound directly
        const sacM = args.connection || args.space ? undefined : await sacModel(modelName).catch(() => undefined);
        if (sacM) {
          if (args.layout === "canvas") return toolSuccess(await generateSacCanvas(args, sacM));
          if (args.template && args.template !== "none") throw new Error("Story templates are only supported with the canvas layout — use template 'none' for responsive");
          return toolSuccess(await generateSacResponsive(args, sacM));
        }
        // space/connection: given, else the Datasphere search, else config; a wrong given space is corrected
        const located = await metadataFor(modelName, args.connection, args.space);
        Object.assign(args, { connection: located.connection, space: located.space });
        const src = { connection: located.connection, space: located.space };
        if (args.layout === "canvas") return toolSuccess({ ...(await generateCanvas({ ...args, ...src, model: modelName })), source: { ...src, foundBySearch: located.resolved } });
        if (args.template && args.template !== "none") throw new Error("Story templates are only supported with the canvas layout — use template 'none' for responsive");
        const theme = args.theme === "none" ? undefined : args.theme;

        // 1. story with the table (also binds the model)
        const { storyId } = await createTableStory({
          name: args.name,
          description: args.description,
          folderId: args.folderId,
          connection: src.connection,
          space: src.space,
          model: modelName,
          // the story is created with a table; without one asked for, a stand-in is removed again below
          // technical names: captions may contain characters the table template does not take
          rowDimension: args.table
            ? resolveDimension(located.meta, args.table.dimension).name
            : [args.charts[0]?.dimension, ...located.meta.dimensions.filter((d) => !d.plain).map((d) => d.name)]
                .filter((d): d is string => Boolean(d))
                .map((d) => resolveDimension(located.meta, d).name)
                .find((n) => /^[A-Za-z0-9_.:\-/]+$/.test(n)) ?? "",
          measure: resolveMeasure(located.meta, (args.table ?? { measure: args.kpis[0]?.measure ?? args.charts[0]?.measure ?? "" }).measure),
        });

        // 2. everything else in memory, saved once
        const story = await loadStory(storyId);
        const c = story.content;
        const model = storyModel(c);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const allMeasures = meta.measures.map((m) => m.name);
        const names = appEntity(c).app.names as Record<string, string>;
        const taken = () => [...outlineNames(c).values()].map((n) => n.name);
        const lane = [...outlineNames(c).values()].find((n) => n.kind === "gridlane")?.name;
        if (!lane) throw new Error("Template story has no lane");

        // page id + table name
        const byWidget = outlineNames(c);
        for (const [id, n] of byWidget) {
          if (n.kind === "appPage") names[n.key] = PAGE_NAME(1);
          if (n.kind === "table2") {
            names[n.key] = conventionName("table", args.table?.label ?? args.table?.measure ?? "Table", taken());
            setPosition(c, id, { left: 0, top: 0, width: LANE_COLUMNS, height: 16 });
          }
        }

        const add = (frag: string, opts: { name: string; container: string; position: Position; dims?: string[]; measures?: string[]; html?: string }) =>
          insertFragment(c, fragment(frag), {
            container: opts.container,
            outlineName: opts.name,
            position: opts.position,
            model,
            dimensions: (opts.dims ?? []).map((d) => resolveDimension(meta, d)),
            measures: (opts.measures ?? []).map((m) => resolveMeasure(meta, m)),
            allMeasures,
            html: opts.html,
          });

        let top = 0;
        const created: string[] = [];
        const name = (frag: string, content: string) => {
          const n = conventionName(frag, content, taken());
          created.push(n);
          return n;
        };

        // title
        const [headline, ...sub] = args.title.split("\n");
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const titleHtml =
          `<p><span style="font-size:28px;font-weight:bold">${esc(headline)}</span></p>` +
          sub.map((l) => `<p><span style="font-size:14px;color:#556b82">${esc(l)}</span></p>`).join("");
        // a subtitle needs a fourth grid row, otherwise it is cut off
        const titleRows = sub.length ? 4 : 3;
        add("text", { name: name("text", "Title"), container: lane, position: { left: 0, top, width: LANE_COLUMNS, height: titleRows }, html: titleHtml });
        top += titleRows;

        // KPI row
        if (args.kpis.length) {
          const fp = name("flow_panel", "KPI");
          add("flow_panel", { name: fp, container: lane, position: { left: 0, top, width: LANE_COLUMNS, height: 7 } });
          const width = Math.floor(100 / args.kpis.length);
          for (const k of args.kpis) {
            const kpi = name("kpi_numeric_point", k.label ?? k.measure);
            add("kpi_numeric_point", {
              name: kpi,
              container: fp,
              position: { left: 0, top: 0, width, widthUnit: "percent", height: 130, heightUnit: "pixel" },
              measures: [k.measure],
            });
            if (k.filters?.length) applyChart(c, kpi, { type: "metric", measures: [resolveMeasure(meta, k.measure)], filters: k.filters });
            formatViz(c, kpi, { title: k.label, scale: scaleFor(k, args.scale, measureCaption(meta, k.measure)), decimals: k.decimals ?? args.decimals });
            applyMinimalStyle(c, kpi);
          }
          top += 7;
        }

        // charts, two per row
        args.charts.forEach((ch, i) => {
          const half = LANE_COLUMNS / 2;
          const last = i === args.charts.length - 1 && i % 2 === 0;
          const chart = name("chart_bar", ch.label ?? `${ch.measure} by ${ch.dimension}`);
          add("chart_bar", {
            name: chart,
            container: lane,
            position: { left: i % 2 === 0 ? 0 : half, top: top + Math.floor(i / 2) * 14, width: last ? LANE_COLUMNS : half, height: 14 },
            dims: [ch.dimension],
            measures: [ch.measure],
          });
          formatViz(c, chart, { title: ch.label, scale: scaleFor(ch, args.scale, measureCaption(meta, ch.measure)), decimals: ch.decimals ?? args.decimals });
          applyMinimalStyle(c, chart);
        });
        top += Math.ceil(args.charts.length / 2) * 14;

        // table to the bottom (or removed when none was asked for)
        for (const [id, n] of outlineNames(c))
          if (n.kind === "table2") {
            if (!args.table) {
              removeWidget(c, n.name);
              continue;
            }
            setPosition(c, id, { left: 0, top, width: LANE_COLUMNS, height: 16 });
            applyMinimalStyle(c, n.name);
            const measure = resolveMeasure(meta, args.table.measure);
            formatTableNumbers(c, n.name, [measure], { scale: scaleFor({ measure }, args.scale, measureCaption(meta, measure)), decimals: args.decimals });
          }

        if (args.filter) {
          const dim = resolveDimension(meta, args.filter.dimension);
          addStoryFilter(c, model, dim, args.filter.members.map((m) => (typeof m === "string" ? { key: m } : m)));
        }
        if (theme) {
          if (listThemeProfiles().includes(theme)) applyThemeProfile(c, theme);
          else await applyThemeResource(c, theme);
        }

        const saved = await saveStory(story);
        return toolSuccess({
          storyId,
          name: args.name,
          widgets: [...outlineNames(c).values()].map((n) => n.name),
          updateCounter: saved.updateCounter,
          openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?type=RESPONSIVE&mode=view`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_models_list",
    `Models available for new stories: Datasphere models already used in the tenant (with connection and space — usable
by sac_story_generate_dashboard) and SAC models; SAC planning (native or Seamless, kind sac/seamless) and analytic models
work with the generator, responsive and canvas. Ask the user which one to use whenever a request does not name a model.`,
    {},
    async () => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        return toolSuccess(await listModels());
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_design_assets",
    "Themes, story templates and composites available in the tenant, ranked by the rule (names, then highest version in the name, then most recently changed). The first of each list is the recommendation.",
    {},
    async () => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const a = await listDesignAssets();
        return toolSuccess({ ...a, themeProfiles: listThemeProfiles() });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_create_from_template",
    "Create a new story from a story template (see sac_design_assets → templates), like 'Templates' on the Stories start page. The template brings its pages, layout, theme and scripts.",
    {
      template: z.string().describe("Template name or resourceId"),
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string(),
      allowalteration: z.boolean().optional(),
    },
    async ({ template, name, description, folderId, allowalteration }) => {
      if (!allowalteration)
        return toolError("Security Requirement: This operation changes data. Please confirm by calling again with 'allowalteration=true'.");
      try {
        assertWritable("create story from template");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const assets = await listDesignAssets();
        const t = assets.templates.find((x) => x.resourceId === template || x.name === template);
        if (!t) throw new Error(`Template '${template}' not found. Available: ${assets.templates.map((x) => x.name).join(", ")}`);
        const user = await resolveUser(folderId);
        const { storyId, saved } = await createStoryFromTemplate({ templateId: t.resourceId, name, description, folderId, user });
        return toolSuccess({ storyId, name: saved.name, template: t.name, parentResId: saved.parentResId, openURL: `/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=view` });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
