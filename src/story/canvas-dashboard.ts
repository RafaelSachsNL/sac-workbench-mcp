/**
 * canvas schablone (docs/STORY_GUIDELINES.md §2) on a blank canvas page:
 *
 *   PA_HEADER                     fixed, full width, 72 px, card_Header, no radius
 *   FP_KPI → PA_KPI_… → PA_CARD_… fixed KPI row, up to 5 tiles à 20 %
 *   FP_BODY                       fills the rest and scrolls; wrapper panels (50 % / 100 %) hold the cards
 *
 * Spacing: flow panels sit 5 px from the page edge, every card is inset 5 px in its wrapper → 10 px between all
 * cards and to the edge. Cards: CSS class "card" (shadow from the Horizon theme CSS) and radius 12.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { outlineNames } from "./content.js";
import { insertFragment, type Fragment, type ModelRef, type Position } from "./fragments.js";
import { resolveDimension, resolveMeasure, measureCaption, type ModelDimension, type ModelMetadata } from "./metadata.js";
import { conventionName } from "./naming.js";
import { applyMinimalStyle, formatTableNumbers, formatViz, scaleFor, type Scale } from "./format.js";
import { setBreakpoints, styleWidget } from "./canvas.js";
import { addInputControl } from "./inputcontrols.js";
import { addPlanningTable, type SacModelRef } from "./planning.js";
import { insertComposite } from "./composite.js";
import { applyChart } from "./chart.js";
import { addTableVersionFilter, withVersion, type VizFilter } from "./sac-fragments.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const FRAGMENT_DIR = resolve(dirOf(import.meta.url), "..", "..", "templates", "fragments");
const fragment = (name: string) => JSON.parse(readFileSync(join(FRAGMENT_DIR, `${name}.json`), "utf8")) as Fragment;

export const HEADER_HEIGHT = 72;
/** Lean header composite: title only. */
export const HEADER_COMPOSITE_HEIGHT = 40;
/** Every panel used as a tile keeps 4 px to all sides: 8 px between tiles, 4 px to the page edge. */
const TILE_MARGIN = 4;
/** Filter bar: one 40 px tile; 4 px padding centres the 32 px input controls vertically. */
const FILTER_BAR_HEIGHT = 40;
const FILTER_BAR_PADDING = 4;
const CONTROL_HEIGHT = FILTER_BAR_HEIGHT - 2 * FILTER_BAR_PADDING;
const MOBILE_BREAKPOINT = 768;
const KPI_ROW_HEIGHT = 130;
const CONTROL_WIDTH = 200;
const CONTROL_GAP = 8;
const CHART_ROW_HEIGHT = 400;
const TABLE_ROW_HEIGHT = 440;
const HEADER_DARK = "#1d2d3e";
const CARD_TITLE_HEIGHT = 48;

/** Stretch between fixed pixel sides. */
const inset = (l: number, t: number, r: number, b: number): Position => ({
  left: l,
  top: t,
  right: r,
  bottom: b,
  leftUnit: "pixel",
  topUnit: "pixel",
  rightUnit: "pixel",
  bottomUnit: "pixel",
  widthUnit: "auto",
  heightUnit: "auto",
});

/** Fixed top band: left/right pinned, fixed height. */
const band = (top: number, height: number, side: number): Position => ({
  left: side,
  top,
  right: side,
  height,
  leftUnit: "pixel",
  topUnit: "pixel",
  rightUnit: "pixel",
  bottomUnit: "auto",
  widthUnit: "auto",
  heightUnit: "pixel",
});

/** Element of a flow panel. */
const flowItem = (widthPercent: number, height: number, heightUnit: "pixel" | "percent"): Position => ({
  left: 0,
  top: 0,
  width: widthPercent,
  height,
  leftUnit: "pixel",
  topUnit: "pixel",
  rightUnit: "auto",
  bottomUnit: "auto",
  widthUnit: "percent",
  heightUnit,
});

export interface CanvasSpec {
  title: string;
  headerInverted: boolean;
  /** header composite (40 px) instead of the built-in header; property values already resolved */
  headerComposite?: { compositeId: string; interfaceProperty: Json[] };
  /** dimensions with an input control in the fixed control bar */
  filters?: (string | { dimension: string; label?: string })[];
  kpis: { measure: string; label?: string; scale?: Scale; decimals?: number; filters?: VizFilter[] }[];
  charts: { dimension: string; measure: string; label?: string; scale?: Scale; decimals?: number }[];
  table?: { dimension: string; measure: string; label?: string };
  scale: Scale;
  decimals: number;
  /** SAC planning model: fragments rewritten for it, every widget filtered to a version (see sac-fragments.ts) */
  planning?: { rewrite: (frag: Fragment, dimensions: ModelDimension[]) => Fragment; datasetId: string };
}

const tile = inset(TILE_MARGIN, TILE_MARGIN, TILE_MARGIN, TILE_MARGIN);

export function buildCanvasDashboard(content: Json, page: string, model: ModelRef, meta: ModelMetadata, spec: CanvasSpec): string[] {
  const allMeasures = meta.measures.map((m) => m.name);
  const created: string[] = [];
  let lastWidgetId = "";
  const taken = () => [...outlineNames(content).values()].map((n) => n.name);
  const add = (frag: string, label: string, container: string, position: Position, data: { dims?: string[]; measures?: string[]; html?: string } = {}) => {
    const name = conventionName(frag, label, taken());
    const dimensions = (data.dims ?? []).map((d) => resolveDimension(meta, d));
    lastWidgetId = insertFragment(content, spec.planning ? spec.planning.rewrite(fragment(frag), dimensions) : fragment(frag), {
      container,
      outlineName: name,
      position,
      model,
      dimensions,
      measures: (data.measures ?? []).map((m) => resolveMeasure(meta, m)),
      allMeasures,
      html: data.html,
    }).widgetId;
    created.push(name);
    return name;
  };
  const card = (container: string, label: string, position: Position = tile) => {
    const name = add("panel_card", `CARD_${label}`, container, position);
    styleWidget(content, name, { cssClass: "card", radius: 12, background: "#ffffff" });
    return name;
  };

  let top = buildHeader(content, page, spec, (frag, label, container, position, html) => add(frag, label, container, position, { html }), created);

  // filter bar (fixed): one 40 px tile; inside a flow panel whose 4 px padding centres the 32 px input controls
  if (spec.filters?.length) {
    const c = card(page, "CONTROL", {
      ...band(top + TILE_MARGIN, FILTER_BAR_HEIGHT, TILE_MARGIN),
    });
    const items = add("flowpanel_inner", "CONTROL_ITEMS", c, inset(0, 0, 0, 0));
    flowLayout(content, items, { gap: CONTROL_GAP, padding: FILTER_BAR_PADDING });
    for (const f of spec.filters) {
      const item = typeof f === "string" ? { dimension: f } : f;
      const dim = resolveDimension(meta, item.dimension);
      const name = conventionName("input_control", item.label ?? dim.caption, taken());
      addInputControl(content, {
        container: items,
        outlineName: name,
        dimension: dim,
        title: item.label,
        hideIcon: true,
        position: { left: 0, top: 0, width: CONTROL_WIDTH, height: CONTROL_HEIGHT, widthUnit: "pixel", heightUnit: "pixel" },
      });
      created.push(name);
    }
    setBreakpoints(content, items, [{ maxWidth: MOBILE_BREAKPOINT, width: 50 }]);
    top += FILTER_BAR_HEIGHT + 2 * TILE_MARGIN;
  }

  // KPI row (fixed)
  if (spec.kpis.length) {
    const row = add("flowpanel_inner", "KPI", page, band(top, KPI_ROW_HEIGHT, 0));
    const kpiWraps: string[] = [];
    for (const k of spec.kpis.slice(0, 5)) {
      const label = k.label ?? k.measure;
      const wrap = add("panel_flow_item", `KPI_${label}`, row, flowItem(20, 100, "percent"));
      kpiWraps.push(wrap);
      const c = card(wrap, `KPI_${label}`);
      const kpi = add("kpi_numeric_point", label, c, inset(8, 4, 8, 4), { measures: [k.measure] });
      const filters = spec.planning ? withVersion(k.filters) : k.filters;
      if (filters?.length) applyChart(content, kpi, { type: "metric", measures: [resolveMeasure(meta, k.measure)], filters });
      formatViz(content, kpi, { title: k.label, scale: scaleFor(k, spec.scale, measureCaption(meta, k.measure)), decimals: k.decimals ?? spec.decimals });
      applyMinimalStyle(content, kpi);
    }
    // phones/tablets: two KPIs side by side, the rest hidden (the KPI band keeps its fixed height)
    setBreakpoints(content, row, [{ maxWidth: MOBILE_BREAKPOINT, width: 50, hide: kpiWraps.slice(2) }]);
    top += KPI_ROW_HEIGHT;
  }

  // body (scrolls): charts two per row, then the table
  const body = add("flowpanel_inner", "BODY", page, inset(0, top, 0, 0));
  spec.charts.forEach((ch, i) => {
    const label = ch.label ?? `${ch.measure} by ${ch.dimension}`;
    const alone = i === spec.charts.length - 1 && i % 2 === 0;
    const wrap = add("panel_flow_item", `CHART_${label}`, body, flowItem(alone ? 100 : 50, CHART_ROW_HEIGHT, "pixel"));
    const c = card(wrap, label);
    const chart = add("chart_bar", label, c, inset(8, 8, 8, 8), { dims: [ch.dimension], measures: [ch.measure] });
    if (spec.planning) applyChart(content, chart, { filters: withVersion([]) });
    formatViz(content, chart, { title: ch.label, scale: scaleFor(ch, spec.scale, measureCaption(meta, ch.measure)), decimals: ch.decimals ?? spec.decimals });
    applyMinimalStyle(content, chart);
  });
  // phones/tablets: one card per row
  setBreakpoints(content, body, [{ maxWidth: MOBILE_BREAKPOINT, width: 100 }]);
  if (spec.table) {
    const label = spec.table.label ?? measureCaption(meta, resolveMeasure(meta, spec.table.measure)) ?? spec.table.measure;
    const wrap = add("panel_flow_item", `TABLE_${label}`, body, flowItem(100, TABLE_ROW_HEIGHT, "pixel"));
    const c = card(wrap, `TABLE_${label}`);
    cardTitle(content, c, label, created);
    const table = add("table", label, c, inset(8, CARD_TITLE_HEIGHT + 8, 8, 8), { dims: [spec.table.dimension], measures: [spec.table.measure] });
    if (spec.planning) addTableVersionFilter(content, lastWidgetId, spec.planning.datasetId);
    applyMinimalStyle(content, table);
    const measure = resolveMeasure(meta, spec.table.measure);
    formatTableNumbers(content, table, [measure], { scale: scaleFor({ measure }, spec.scale, measureCaption(meta, measure)), decimals: spec.decimals });
  }
  collapseSidePanel(content);
  return created;
}

type AddFn = (frag: string, label: string, container: string, position: Position, html?: string) => string;

/**
 * Page header: the lean 40 px composite (title only, Title property) or the built-in 72 px header (title, optional
 * subtitle after "\n", inverted or not). Returns the height it takes.
 */
function buildHeader(
  content: Json,
  page: string,
  spec: { title: string; headerInverted: boolean; headerComposite?: { compositeId: string; interfaceProperty: Json[] } },
  add: AddFn,
  created: string[],
): number {
  if (spec.headerComposite) {
    const name = conventionName("composite", "HEADER", [...outlineNames(content).values()].map((n) => n.name));
    insertComposite(content, { ...spec.headerComposite, container: page, outlineName: name, position: band(0, HEADER_COMPOSITE_HEIGHT, 0) });
    created.push(name);
    return HEADER_COMPOSITE_HEIGHT;
  }
  const header = add("panel_card", "HEADER", page, band(0, HEADER_HEIGHT, 0));
  styleWidget(content, header, { cssClass: "card_Header", radius: 0, ...(spec.headerInverted ? { background: HEADER_DARK } : {}) });
  const [headline, ...sub] = spec.title.split("\n");
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // inverted = own dark background; otherwise no inline colour → text follows the story theme (light or dark)
  const color = spec.headerInverted ? ";color:#ffffff" : "";
  const subColor = spec.headerInverted ? ";color:#d1e8ff" : "";
  add(
    "text",
    "TITLE",
    header,
    inset(16, 8, 16, 8),
    `<p><span style="font-size:22px;font-weight:bold${color}">${esc(headline)}</span></p>` +
      sub.map((l) => `<p><span style="font-size:13px${subColor}">${esc(l)}</span></p>`).join(""),
  );
  return HEADER_HEIGHT;
}

/** Spacing of a flow panel: gap between its children and padding to its own edges. */
function flowLayout(content: Json, flowPanel: string, opts: { gap?: number; padding?: number }) {
  const id = [...outlineNames(content).entries()].find(([, n]) => n.name === flowPanel)?.[0];
  for (const page of content.entities.find((e: Json) => e?.type === "story").data.pages) {
    const reg = page?.content?.widgets?.find((w: Json) => w?.id === id);
    const entity = reg && content.entities.find((e: Json) => e?.id === reg.definition?.entityId);
    if (!entity?.data) continue;
    if (opts.gap !== undefined) entity.data.panelSpacing = { ...(entity.data.panelSpacing ?? {}), horizontalSpacing: opts.gap, verticalSpacing: opts.gap };
    if (opts.padding !== undefined) {
      const v = { value: opts.padding, unit: "pixel" };
      entity.data.panelPadding = { topPadding: v, bottomPadding: v, leftPadding: v, rightPadding: v };
    }
  }
}

export interface PlanningCanvasSpec {
  title: string;
  headerInverted: boolean;
  headerComposite?: { compositeId: string; interfaceProperty: Json[] };
  model: SacModelRef;
  row: { name: string; caption?: string };
  measures: [string, string];
  tableLabel?: string;
}

/** Canvas schablone for planning: header + one card with an input-ready table on an SAC planning model. */
export function buildPlanningCanvas(content: Json, page: string, spec: PlanningCanvasSpec): string[] {
  const created: string[] = [];
  const taken = () => [...outlineNames(content).values()].map((n) => n.name);
  const none = { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" };
  const add = (frag: string, label: string, container: string, position: Position, html?: string) => {
    const name = conventionName(frag, label, taken());
    insertFragment(content, fragment(frag), { container, outlineName: name, position, model: none, dimensions: [], measures: [], allMeasures: [], html });
    created.push(name);
    return name;
  };
  const top = buildHeader(content, page, spec, add, created);
  const body = add("flowpanel_inner", "BODY", page, inset(0, top, 0, 0));
  const label = spec.tableLabel ?? "PLANUNG";
  const wrap = add("panel_flow_item", `TABLE_${label}`, body, flowItem(100, TABLE_ROW_HEIGHT, "pixel"));
  const c = add("panel_card", `CARD_TABLE_${label}`, wrap, tile);
  styleWidget(content, c, { cssClass: "card", radius: 12, background: "#ffffff" });
  const table = conventionName("table", label, taken());
  cardTitle(content, c, spec.tableLabel ?? "Planung", created);
  addPlanningTable(content, { container: c, outlineName: table, model: spec.model, row: spec.row, measures: spec.measures, position: inset(8, CARD_TITLE_HEIGHT + 8, 8, 8) });
  created.push(table);
  applyMinimalStyle(content, table);
  collapseSidePanel(content);
  return created;
}

/** Horizon title row (48 px, logicGroupHeader) at the top of a card; content below starts at 56 px. */
function cardTitle(content: Json, card: string, text: string, created: string[]) {
  const none = { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" };
  const taken = () => [...outlineNames(content).values()].map((n) => n.name);
  const base = card.replace(/^PA_CARD_/, "");
  const header = conventionName("panel_group_header", `TITLE_${base}`, taken());
  insertFragment(content, fragment("panel_group_header"), {
    container: card,
    outlineName: header,
    position: band(0, CARD_TITLE_HEIGHT, 0),
    model: none,
    dimensions: [],
    measures: [],
    allMeasures: [],
  });
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const title = conventionName("text", `TITLE_${base}`, taken());
  insertFragment(content, fragment("text"), {
    container: header,
    outlineName: title,
    position: inset(16, 12, 16, 4),
    model: none,
    dimensions: [],
    measures: [],
    allMeasures: [],
    // no inline colour: card titles follow the theme (readable on dark themes too)
    html: `<p><span style="font-size:14px;font-weight:bold">${esc(text)}</span></p>`,
  });
  styleWidget(content, title, { cssClass: "logicGroupTitle" });
  created.push(header, title);
}

/**
 * Clean runtime chrome: side panel collapsed and the filter bar hidden (filtering happens in the control bar) — the
 * filter panel would otherwise open on load and cover half the screen on small devices.
 */
export function collapseSidePanel(content: Json) {
  const story = content.entities.find((e: Json) => e?.type === "story").data;
  story.filterBarSettings = { layoutType: "vertical", runtimeToolbarEnabled: true, ...(story.filterBarSettings ?? {}), runtimeVisibility: "hidden" };
  const pm = (story.presentationModel ??= { presentationItems: [], orderedTopicPageList: [] });
  pm.sidePanelSettings = {
    panelPlacement: "PinnedLeft",
    autoShowAndHidePanel: true,
    isHeaderHidden: false,
    ...(pm.sidePanelSettings ?? {}),
    defaultSidePanelExpanded: "presentNavPanelCollapsed",
  };
}

export { FILTER_BAR_HEIGHT, TILE_MARGIN };

/**
 * Page header as composite content, 40 px: only the title (bold 18 px), vertically centred. "Title" is a composite
 * property linked to the text content, so each story sets its own.
 */
export function buildHeaderComposite(content: Json, page: string, opts: { title: string; inverted?: boolean }): string[] {
  const created: string[] = [];
  const none = { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" };
  const taken = () => [...outlineNames(content).values()].map((n) => n.name);
  const add = (frag: string, label: string, container: string, position: Position, html?: string) => {
    const name = conventionName(frag, label, taken());
    insertFragment(content, fragment(frag), { container, outlineName: name, position, model: none, dimensions: [], measures: [], allMeasures: [], html });
    created.push(name);
    return name;
  };
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const panel = add("panel_card", "HEADER", page, inset(0, 0, 0, 0));
  styleWidget(content, panel, { cssClass: "card_Header", radius: 0, ...(opts.inverted ? { background: HEADER_DARK } : {}) });
  // inverted = own dark background → white; otherwise no inline colour so the text follows the story theme
  // (a fixed dark blue was unreadable on dark themes)
  const color = opts.inverted ? ";color:#ffffff" : "";
  const title = add("text", "TITLE", panel, { left: 16, right: 16, top: 6, height: 28, leftUnit: "pixel", rightUnit: "pixel", topUnit: "pixel", heightUnit: "pixel", widthUnit: "auto", bottomUnit: "auto" },
    `<p><span style="font-size:18px;font-weight:bold${color}">${esc(opts.title)}</span></p>`);
  const app = content.entities.find((e: Json) => String(e?.id ?? "").endsWith(":application")).app;
  const idOf = (name: string) => [...outlineNames(content).entries()].find(([, n]) => n.name === name)![0];
  app.composite = { payload: { properties: { Title: { id: crypto.randomUUID(), type: "string", linkedToWidgets: [{ widgetId: idOf(title), properties: ["content"] }] } } } };
  return created;
}

export interface SkeletonSpec {
  title: string;
  headerInverted?: boolean;
  headerComposite?: { compositeId: string; interfaceProperty: Json[] };
  /** reserve the 40 px filter bar (an empty tile; input controls go into its flow panel FP_FILTERBAR_ITEMS) */
  filterBar?: boolean;
  /** body cards (one per row, full width), each with a title row; content goes inside the card below the title */
  cards: { title: string; height?: number }[];
  /** optional SAC planning model bound to the story (dataset only, no widgets) */
}

/**
 * Empty canvas schablone: header, optional filter bar, cards with title rows — for content added afterwards
 * (planning tables, charts, scripts). Returns the container names, the cards' inner area starts below their title.
 */
export function buildCanvasSkeleton(content: Json, page: string, spec: SkeletonSpec): { widgets: string[]; filterBar?: string; cards: string[] } {
  const created: string[] = [];
  const none = { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" };
  const taken = () => [...outlineNames(content).values()].map((n) => n.name);
  const add: AddFn = (frag, label, container, position, html) => {
    const name = conventionName(frag, label, taken());
    insertFragment(content, fragment(frag), { container, outlineName: name, position, model: none, dimensions: [], measures: [], allMeasures: [], html });
    created.push(name);
    return name;
  };
  let top = buildHeader(content, page, { title: spec.title, headerInverted: spec.headerInverted ?? false, headerComposite: spec.headerComposite }, add, created);
  let filterBar: string | undefined;
  if (spec.filterBar) {
    const bar = add("panel_card", "CARD_FILTERBAR", page, band(top + TILE_MARGIN, FILTER_BAR_HEIGHT, TILE_MARGIN));
    styleWidget(content, bar, { cssClass: "card", radius: 12, background: "#ffffff" });
    filterBar = add("flowpanel_inner", "FILTERBAR_ITEMS", bar, inset(0, 0, 0, 0));
    flowLayout(content, filterBar, { gap: CONTROL_GAP, padding: FILTER_BAR_PADDING });
    top += FILTER_BAR_HEIGHT + 2 * TILE_MARGIN;
  }
  const body = add("flowpanel_inner", "BODY", page, inset(0, top, 0, 0));
  const cards: string[] = [];
  for (const c of spec.cards) {
    const wrap = add("panel_flow_item", `CARD_${c.title}`, body, flowItem(100, c.height ?? TABLE_ROW_HEIGHT, "pixel"));
    const card = add("panel_card", `CARD_${c.title}`, wrap, tile);
    styleWidget(content, card, { cssClass: "card", radius: 12, background: "#ffffff" });
    cardTitle(content, card, c.title, created);
    cards.push(card);
  }
  collapseSidePanel(content);
  return { widgets: created, filterBar, cards };
}

export { CARD_TITLE_HEIGHT };
