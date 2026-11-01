/**
 * Widget fragments: everything SAC stores for one widget, lifted out of a story so it can be inserted into another.
 *
 * A widget in an optimized story is spread over:
 *   - the page's widget registry (class + definition, e.g. the chart's vizDefinition)
 *   - a section in its container's layout (position)
 *   - its own entity (+ helper entities created with it)
 *   - its persisted InA query (persistedUqmQuery) and the pre-execute list
 *   - dimension metadata in persistedUdm
 *   - its outline name in the application entity
 * Extraction collects these parts from a story where the widget was built once in the UI; insertion re-ids them and
 * swaps model, dimensions, measures, position and name.
 */

import { randomUUID } from "node:crypto";
import { appEntity, outlineNames, RECORDED_PACKAGE, storyEntity, tenantPackage } from "./content.js";
import type { ModelDimension } from "./metadata.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface ModelRef {
  cubeId: string;
  model: string;
  space: string;
  connection: string;
}

export interface Fragment {
  name: string;
  description: string;
  /** outline kind, e.g. "viz2", "table2" */
  kind: string;
  tokens: {
    widgetId: string;
    sectionId: string;
    entityIds: string[];
    outlineName: string;
    model: ModelRef;
    dimensions: { name: string; key: string; caption: string }[];
    measures: string[];
    /** marker text typed into a text widget when it was recorded; stored as <p>marker</p> */
    textMarker?: string;
  };
  parts: {
    registry: Json;
    section: Json;
    entities: Json[];
    queries: Json[];
    preExecute: string[];
    udm: Json[];
    /** inner layouts of container widgets (flow panel, panel), emptied */
    layouts?: Json[];
  };
}

// ── Model of a story ───────────────────────────────────────────────

/** Model behind a dataset of the story (cube id from the dataset entity; model/space/connection from its queries). */
export function storyModel(content: Json, datasetId?: string): ModelRef {
  const datasets = content.entities.filter((e: Json) => e.type === "dataset");
  const ds = datasetId ? datasets.find((d: Json) => d.id === datasetId) : datasets[0];
  if (!ds) throw new Error(datasetId ? `Dataset ${datasetId} not found` : "Story has no dataset");
  if (!datasetId && datasets.length > 1)
    throw new Error(`Story has ${datasets.length} datasets; pass datasetId (${datasets.map((d: Json) => d.id).join(", ")})`);
  const cubeId = ds.data?.model?.id?.name ?? ds.data?.modelId;
  const text = JSON.stringify(content);
  const src = text.match(/ObjectName\\*":\\*"([^"\\]+)\\*",\\*"SchemaName\\*":\\*"([^"\\]+)/);
  const sys = text.match(/systemName\\*":\\*"([^"\\]+)/);
  if (!cubeId || !src || !sys) throw new Error("Could not determine model/space/connection of the story's dataset");
  return { cubeId, model: src[1], space: src[2], connection: sys[1] };
}


/**
 * Where children of a container go: a page (its root layout, e.g. the canvas) or a lane/panel/flow panel by
 * outline name. Lanes place children on a grid, everything else in pixels.
 */
export function containerLayout(content: Json, container: string): { page: Json; layout: Json; unit: "grid" | "pixel" } {
  const byWidget = outlineNames(content);
  const cont = [...byWidget.entries()].find(([, n]) => n.name === container);
  if (!cont) throw new Error(`Container '${container}' not found. Widgets: ${[...byWidget.values()].map((n) => n.name).join(", ")}`);
  let page: Json;
  let layoutId: string | undefined;
  if (cont[1].kind === "appPage") {
    page = storyEntity(content).data.pages.find((p: Json) => p?.id === cont[0]);
    layoutId = page?.definition?.layoutId;
  } else {
    page = findPageWithWidget(content, cont[0]);
    layoutId = page.content.widgets.find((w: Json) => w?.id === cont[0])?.definition?.layoutIds?.[0];
  }
  // composites keep their page widgets in "boxlayout"; the page's layoutId points to no layout there
  const layout =
    page?.content?.layouts?.find((l: Json) => l?.id === layoutId) ??
    (cont[1].kind === "appPage" ? page?.content?.layouts?.find((l: Json) => l?.id === "boxlayout") : undefined);
  if (!layout) throw new Error(`'${container}' is not a container with an inner layout`);
  return { page, layout, unit: cont[1].kind === "gridlane" ? "grid" : "pixel" };
}

// ── Extraction ─────────────────────────────────────────────────────

function findPageWithWidget(content: Json, widgetId: string): Json {
  const page = storyEntity(content).data.pages.find((p: Json) => p?.content?.widgets?.some((w: Json) => w?.id === widgetId));
  if (!page) throw new Error(`Widget ${widgetId} is not on any page`);
  return page;
}

export function extractFragment(
  before: Json,
  after: Json,
  opts: {
    widgetName: string;
    name: string;
    description: string;
    dimensions: ModelDimension[];
    measures: string[];
    textMarker?: string;
  },
): Fragment {
  const names = outlineNames(after);
  const hit = [...names.entries()].find(([, n]) => n.name === opts.widgetName);
  if (!hit) throw new Error(`No widget named '${opts.widgetName}' in the story`);
  const [widgetId, { kind }] = hit;

  const page = findPageWithWidget(after, widgetId);
  const registry = page.content.widgets.find((w: Json) => w.id === widgetId);
  let section: Json;
  for (const l of page.content.layouts)
    for (const s of l.definition?.page?.sections ?? []) if (s.widgets?.some((w: Json) => w.widgetId === widgetId)) section = s;
  if (!section) throw new Error("Layout section of the widget not found");

  const beforeIds = new Set(before.entities.map((e: Json) => e.id));
  const entities = after.entities.filter((e: Json) => !beforeIds.has(e.id));
  const sa = storyEntity(after).data;
  const sb = storyEntity(before).data;
  const queries = (sa.persistedUqmQuery ?? []).filter((q: Json) => String(q.id).includes(widgetId));
  const preExecute = (sa.preExecuteUqmQueryIds ?? []).filter((q: string) => q.includes(widgetId));
  const beforeUdm = new Set((sb.persistedUdm ?? []).map((u: Json) => u.id));
  const udm = (sa.persistedUdm ?? []).filter((u: Json) => !beforeUdm.has(u.id));
  // a container brings its inner layout(s); children are not part of the fragment
  const layouts = (registry.definition?.layoutIds ?? []).map((id: string) => {
    const l = structuredClone(page.content.layouts.find((x: Json) => x.id === id));
    if (l?.definition?.page) l.definition.page.sections = [];
    return l;
  });

  return {
    name: opts.name,
    description: opts.description,
    kind,
    tokens: {
      widgetId,
      sectionId: section.sectionId,
      entityIds: entities.map((e: Json) => e.id),
      outlineName: opts.widgetName,
      model: storyModel(after),
      dimensions: opts.dimensions.map((d) => ({ name: d.name, key: d.key, caption: d.caption })),
      measures: opts.measures,
      ...(opts.textMarker ? { textMarker: opts.textMarker } : {}),
    },
    parts: { registry, section, entities, queries, preExecute, udm, layouts },
  };
}

// ── Insertion ──────────────────────────────────────────────────────

/** Replace all values at once (longest first via tokens) so overlapping values cannot collide. */
export function substitute(json: string, pairs: [string, string][]): string {
  if (tenantPackage() !== RECORDED_PACKAGE)
    pairs = [
      ...pairs,
      [RECORDED_PACKAGE + ".", tenantPackage() + "."],
      [`"${RECORDED_PACKAGE}"`, `"${tenantPackage()}"`],
      // SAC models live in the tenant schema TENANT_<id>
      [`TENANT_${RECORDED_PACKAGE.slice(2)}`, `TENANT_${tenantPackage().slice(2)}`],
    ];
  const sorted = pairs.filter(([a, b]) => a && a !== b).sort((x, y) => y[0].length - x[0].length);
  sorted.forEach(([from], i) => (json = json.split(from).join(`\u0000${i}\u0000`)));
  sorted.forEach(([, to], i) => (json = json.split(`\u0000${i}\u0000`).join(to)));
  return json;
}

export interface Position {
  left?: number;
  top?: number;
  right?: number;
  bottom?: number;
  width?: number;
  height?: number;
  rightUnit?: string;
  bottomUnit?: string;
  leftUnit?: string;
  topUnit?: string;
  widthUnit?: string;
  heightUnit?: string;
}

export interface InsertOptions {
  container: string;
  outlineName: string;
  position?: Position;
  model: ModelRef;
  dimensions: ModelDimension[];
  measures: string[];
  /** all measure names of the model (queries list them as members of the measure dimension) */
  allMeasures: string[];
  /** HTML content for text widgets (replaces the fragment's <p>marker</p>) */
  html?: string;
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Plain text → the paragraph HTML SAC's text widget stores. */
export function textToHtml(text: string): string {
  return text
    .split(/\n/)
    .map((line) => `<p>${line ? escapeHtml(line) : "<br>"}</p>`)
    .join("");
}

/** Rebuild member lists of the measure dimension (CustomDimension1) — text substitution would duplicate entries. */
function fixMeasureMembers(node: Json, measures: string[]) {
  if (Array.isArray(node)) return node.forEach((n) => fixMeasureMembers(n, measures));
  if (!node || typeof node !== "object") return;
  if (node.Name === "CustomDimension1" && Array.isArray(node.Members) && node.Members.every((m: Json) => typeof m?.MemberName === "string"))
    node.Members = measures.map((m) => ({ MemberName: m }));
  for (const v of Object.values(node)) fixMeasureMembers(v, measures);
}

export function insertFragment(content: Json, frag: Fragment, opts: InsertOptions): { widgetId: string } {
  const t = frag.tokens;
  if (opts.dimensions.length !== t.dimensions.length)
    throw new Error(`Fragment '${frag.name}' needs ${t.dimensions.length} dimension(s), got ${opts.dimensions.length}`);
  if (opts.measures.length !== t.measures.length)
    throw new Error(`Fragment '${frag.name}' needs ${t.measures.length} measure(s), got ${opts.measures.length}`);

  const names = appEntity(content).app.names as Record<string, string>;
  if (Object.values(names).includes(opts.outlineName)) throw new Error(`Name '${opts.outlineName}' is already used`);

  const { page, layout, unit } = containerLayout(content, opts.container);

  const widgetId = randomUUID();
  const pairs: [string, string][] = [
    [t.widgetId, widgetId],
    [t.sectionId, randomUUID()],
    ...(frag.parts.layouts ?? []).map((l: Json): [string, string] => [l.id, randomUUID()]),
    ...t.entityIds.map((id): [string, string] => [id, randomUUID()]),
    [t.model.cubeId, opts.model.cubeId],
    [t.model.model, opts.model.model],
    [t.model.space, opts.model.space],
    [t.model.connection, opts.model.connection],
    ...t.dimensions.flatMap((d, i): [string, string][] => [
      [d.name, opts.dimensions[i].name],
      [d.key, opts.dimensions[i].key],
      [d.caption, opts.dimensions[i].caption],
    ]),
    ...t.measures.map((m, i): [string, string] => [m, opts.measures[i]]),
    // inserted into a JSON string, so it must be JSON-escaped
    ...(t.textMarker && opts.html !== undefined
      ? [[`<p>${t.textMarker}</p>`, JSON.stringify(opts.html).slice(1, -1)] as [string, string]]
      : []),
  ];
  const parts = JSON.parse(substitute(JSON.stringify(frag.parts), pairs)) as Fragment["parts"];

  fixMeasureMembers(parts.queries, opts.allMeasures);

  // position: lanes place children on a grid, flow panels in pixels (or percent)
  const dyn = parts.section.widgets?.[0]?.definition?.dynamicLayout;
  if (dyn) {
    const flow = layout.definition?.page?.definition?.layoutType === "FLOW";
    // lanes place on a grid; elsewhere keep the fragment's anchoring (auto/percent) but turn grid units into pixels
    for (const k of ["leftUnit", "topUnit", "widthUnit", "heightUnit"])
      if (unit === "grid" || dyn[k] === undefined || dyn[k] === "grid") dyn[k] = unit;
    Object.assign(dyn, opts.position ?? {});
    // lane children get their minimum from the grid; anchored (auto-sized) canvas widgets need it
    if (unit === "grid") for (const k of ["minOccupiedWidth", "minOccupiedHeight"]) delete dyn[k];
    else {
      // values recorded in a lane would keep the widget from shrinking into its panel
      dyn.minOccupiedWidth = 48;
      dyn.minOccupiedHeight = 32;
    }
    if (flow) {
      const w = parts.section.widgets[0].definition;
      for (const k of ["width", "height"] as const) if (typeof dyn[k] === "number" && dyn[`${k}Unit`] === "pixel") w[k] = dyn[k];
    }
  }

  const story = storyEntity(content).data;
  page.content.widgets.push(parts.registry);
  page.content.layouts.push(...(parts.layouts ?? []));
  layout.definition.page.sections.push(parts.section);
  content.entities.push(...parts.entities);
  (story.persistedUqmQuery ??= []).push(...parts.queries);
  // Pre-executed queries are replayed verbatim in view mode; for dimensions without a text attribute the recorded
  // query references a non-existent "<key>∞T" field, so let SAC build those queries at runtime instead.
  if (opts.dimensions.every((d) => d.text)) (story.preExecuteUqmQueryIds ??= []).push(...parts.preExecute);
  const udmIds = new Set((story.persistedUdm ??= []).map((u: Json) => u.id));
  for (const u of parts.udm) if (!udmIds.has(u.id)) story.persistedUdm.push(u);
  names[JSON.stringify([{ story: "storyID" }, { [frag.kind]: widgetId }])] = opts.outlineName;
  return { widgetId };
}

/**
 * Drop every reference to a widget from the application entity: object keys that contain its id (widgetAddOns,
 * events, allReferencedWidgetIdsForInit, invalidPersistedInAWidgets …) and array entries that contain it
 * (appPages[].payload.referencedWidgetInstanceIds, allReferencedWidgetIds). Left-overs keep a story from loading.
 */
function purgeAppReferences(node: Json, widgetId: string): void {
  if (Array.isArray(node)) {
    for (let i = node.length - 1; i >= 0; i--) {
      const v = node[i];
      if (typeof v === "string" ? v.includes(widgetId) : JSON.stringify(v ?? null).length < 400 && JSON.stringify(v ?? null).includes(widgetId)) node.splice(i, 1);
      else purgeAppReferences(v, widgetId);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const k of Object.keys(node)) {
    if (k.includes(widgetId)) delete node[k];
    else purgeAppReferences(node[k], widgetId);
  }
}

/** Remove a widget (and, for containers, everything inside it) with all its parts. */
export function removeWidget(content: Json, outlineName: string): string[] {
  const names = outlineNames(content);
  const hit = [...names.entries()].find(([, n]) => n.name === outlineName);
  if (!hit) throw new Error(`No widget named '${outlineName}'`);
  const page = findPageWithWidget(content, hit[0]);
  const removed: string[] = [];
  const story = storyEntity(content).data;
  const app = appEntity(content).app.names as Record<string, string>;

  const drop = (widgetId: string) => {
    const reg = page.content.widgets.find((w: Json) => w?.id === widgetId);
    for (const layoutId of reg?.definition?.layoutIds ?? []) {
      const inner = page.content.layouts.find((l: Json) => l?.id === layoutId);
      for (const s of inner?.definition?.page?.sections ?? []) for (const w of s?.widgets ?? []) if (w) drop(w.widgetId);
      page.content.layouts = page.content.layouts.filter((l: Json) => l && l.id !== layoutId);
    }
    page.content.widgets = page.content.widgets.filter((w: Json) => w && w.id !== widgetId);
    for (const l of page.content.layouts)
      if (l?.definition?.page?.sections)
        l.definition.page.sections = l.definition.page.sections.filter((s: Json) => s && !s.widgets?.some((w: Json) => w?.widgetId === widgetId));
    // widgets duplicated in the editor share one entity (e.g. text) — keep it while another widget still uses it
    const entityId = reg?.definition?.entityId;
    const shared = entityId && storyEntity(content).data.pages.some((p: Json) => p?.content?.widgets?.some((w: Json) => w?.definition?.entityId === entityId));
    if (entityId && !shared) content.entities = content.entities.filter((e: Json) => e && e.id !== entityId);
    purgeAppReferences(appEntity(content), widgetId);
    story.persistedUqmQuery = (story.persistedUqmQuery ?? []).filter((q: Json) => q && !String(q.id).includes(widgetId));
    story.preExecuteUqmQueryIds = (story.preExecuteUqmQueryIds ?? []).filter((q: string) => !q.includes(widgetId));
    const n = names.get(widgetId);
    if (n) {
      removed.push(n.name);
      delete app[n.key];
    }
  };
  drop(hit[0]);
  return removed;
}
