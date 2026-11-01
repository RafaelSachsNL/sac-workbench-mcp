/**
 * Declarative chart editing: read a chart as a short description and apply a (partial) description to it.
 * Verified against SAC (copy of a demo story with all chart types):
 * - type change within the axis family (barcolumn ↔ line …) = vizDefinition.type only;
 * - a dimension in a feed must also be in the query: AxesLayout (Rows instead of Free), AxesRepo Rows layout,
 *   DimensionsRepo (a minimal element is enough, SAC completes it) and initialUQMExternalState.usedDimensions —
 *   otherwise "dimension altered in the model";
 * - measures: feed + usedMeasures + measure filter ([Measures].[Measures]) + member of CustomDimension1.
 * Feeds per type differ only in name, see FEEDS.
 */

import { randomUUID } from "node:crypto";
import { findRegistryWidget } from "./format.js";
import { calcRef, dropPreExecute, measureRef } from "./calculations.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** measure feed / main dimension feed per chart type */
const FEEDS: Record<string, { measures: string; dimensions?: string }> = {
  barcolumn: { measures: "valueAxis", dimensions: "categoryAxis" },
  stackedbar: { measures: "valueAxis", dimensions: "categoryAxis" },
  line: { measures: "valueAxis", dimensions: "categoryAxis" },
  area: { measures: "valueAxis", dimensions: "categoryAxis" },
  donut: { measures: "size", dimensions: "color" },
  pie: { measures: "size", dimensions: "color" },
  treemap: { measures: "weight", dimensions: "title" },
  metric: { measures: "valueAxis" },
};
export const CHART_TYPES = Object.keys(FEEDS);

export interface ChartSpec {
  type?: string;
  /** measures (model measure ids or calculation names/ids) on the measure feed of the type */
  measures?: string[];
  /** dimensions on the main dimension feed of the type (categoryAxis / color / title) */
  dimensions?: string[];
  /** dimension for colour (barcolumn/line/area: 'color' feed), [] = none */
  color?: string[];
  /** dimension for the pattern (e.g. Version: Actual solid, Plan hatched), [] = none */
  pattern?: string[];
  /** raw feeds {feedName: [dimension | measure | calculation]} for anything else */
  feeds?: Record<string, string[]>;
  /** donut/pie: also the dimension names in the data labels (false = percentages only) */
  legend?: boolean;
  /** hierarchy and drill level per dimension, e.g. {Produkt: {id: "H_KAT", level: 1}}; level 0 = top nodes */
  hierarchy?: Record<string, { id: string; level?: number; includeParents?: boolean }>;
  /** chart filters; members [] removes the filter of that dimension */
  filters?: ChartFilter[];
}

export interface ChartFilter {
  dimension: string;
  /** member ids (Version: "Actual" or "public.Actual"); with hierarchy the hierarchy member ids */
  members?: string[];
  hierarchy?: string;
  /** dynamic date range relative to today: current period plus 'last' periods back and 'next' ahead */
  dynamic?: { granularity: "year" | "quarter" | "month" | "day"; last?: number; next?: number };
}

/** recorded names; weeks (YWD hierarchy) are not known yet ("Unhandled granularity") */
const GRANULARITY: Record<string, string> = { year: "YEAR", quarter: "CALQUARTER", month: "CALMONTH", day: "DAY" };

interface Ctx {
  viz: Json;
  datasetId: string;
  calcs: { id: string; name: string }[];
  dims: Set<string>;
}

function ctxOf(content: Json, chart: string): Ctx {
  const viz = findRegistryWidget(content, chart).definition?.vizDefinition;
  if (!viz?.ffQuery) throw new Error(`'${chart}' is not a chart`);
  const datasetId = JSON.parse(viz.datasetEntityId)[0].datasetId;
  const calcEntity = content.entities.find((e: Json) => e.type === "calculation");
  const calcs = (calcEntity?.entities ?? []).filter((c: Json) => !c.isDeleted).map((c: Json) => ({ id: c.id?.id, name: c.name }));
  // the axes list the model dimensions known when a chart was created; dimensions added to the model later only show
  // up in newer charts → union over all charts of the same model in the story
  const dims = new Set<string>();
  const collect = (o: Json): void => {
    if (!o || typeof o !== "object") return;
    if (o.ffQuery?.Query?.AxesLayout && o.datasetEntityId === viz.datasetEntityId)
      for (const a of o.ffQuery.Query.AxesLayout) for (const d of a.OrderedDimensionNames) dims.add(d);
    for (const v of Object.values(o)) collect(v);
  };
  collect(content);
  for (const d of [...dims]) if (d.startsWith("$$") || d.startsWith("CustomDimension")) dims.delete(d);
  return { viz, datasetId, calcs, dims };
}

type Item = { kind: "dimension" | "measure" | "calculation"; id: string };

function parseSource(s: Json): Item | undefined {
  if (typeof s !== "string") return undefined;
  const parts = JSON.parse(s);
  const calc = parts.find((p: Json) => p.calculationId);
  if (calc) return { kind: "calculation", id: calc.calculationId };
  const m = parts.find((p: Json) => p.measureId);
  if (m) return { kind: "measure", id: m.measureId };
  const d = parts.find((p: Json) => p.dimensionId);
  return d ? { kind: "dimension", id: d.dimensionId } : undefined;
}

const label = (ctx: Ctx, it: Item) => (it.kind === "calculation" ? (ctx.calcs.find((c) => c.id === it.id)?.name ?? it.id) : it.id);

/** The chart as a short description (same shape sac_story_chart accepts). */
export function readChart(content: Json, chart: string): Json {
  const ctx = ctxOf(content, chart);
  const { viz } = ctx;
  const role = FEEDS[viz.type];
  const feeds: Record<string, string[]> = {};
  for (const b of viz.bindings ?? []) {
    const items = (b.source ?? []).map(parseSource).filter(Boolean) as Item[];
    if (items.length) feeds[b.feed] = items.map((it) => label(ctx, it));
    else if (b.source?.some((s: Json) => s?.measureNames)) feeds[b.feed] = ["(measures)"];
  }
  const out: Json = { chart, type: viz.type, title: viz.title };
  if (role) {
    out.measures = feeds[role.measures] ?? [];
    if (role.dimensions) out.dimensions = feeds[role.dimensions] ?? [];
    if (role.dimensions !== "color" && feeds.color) out.color = feeds.color;
    if (feeds.pattern2) out.pattern = feeds.pattern2;
    const known = new Set([role.measures, role.dimensions, "color", "pattern2"]);
    const rest = Object.fromEntries(Object.entries(feeds).filter(([f]) => !known.has(f)));
    if (Object.keys(rest).length) out.feeds = rest;
  } else out.feeds = feeds;
  out.legend = viz.properties?.legendGroup?.visible !== false;
  const hier = Object.fromEntries(
    (viz.initialUQMExternalState?.hierarchyLevels ?? []).flatMap((x: Json) => {
      const p = JSON.parse(x.dimensionId);
      const d = p.find((q: Json) => q.dimensionId)?.dimensionId;
      const id = p.find((q: Json) => q.hierarchyId)?.hierarchyId;
      return d && id && d !== "Date" ? [[d, { id, level: x.level, ...(x.includeParents ? { includeParents: true } : {}) }]] : [];
    }),
  );
  if (Object.keys(hier).length) out.hierarchy = hier;
  const filters = (viz.filters ?? []).flatMap((f: Json) => {
    const dimension = filterDim(f);
    if (f.schemaType === "IC_RANGE") {
      const r = f.ranges?.[0];
      const g = Object.entries(GRANULARITY).find(([, v]) => v === r?.selectionDefinition?.granularity)?.[0] ?? r?.selectionDefinition?.granularity;
      return [{ dimension, dynamic: { granularity: g, ...(r?.selection?.offset ?? {}) } }];
    }
    if (f.schemaType === "IC_MEMBER" && !f.selection?.isAllSelected)
      return [{ dimension, members: (f.selection?.selectedValues ?? []).map((v: Json) => v.displayId ?? v.key) }];
    return [];
  });
  if (filters.length) out.filters = filters;
  out.availableDimensions = [...ctx.dims].filter((d) => !d.includes("."));
  out.calculations = ctx.calcs.map((c) => c.name);
  return out;
}

function resolve(ctx: Ctx, name: string, measureFeed: boolean): Item {
  const calc = ctx.calcs.find((c) => c.id === name || c.name === name);
  if (calc) return { kind: "calculation", id: calc.id };
  if (!measureFeed && ctx.dims.has(name)) return { kind: "dimension", id: name };
  if (measureFeed) return { kind: "measure", id: name };
  throw new Error(`'${name}' is neither a dimension of the model nor a calculation. Dimensions: ${[...ctx.dims].filter((d) => !d.includes(".")).join(", ")}`);
}

const sourceOf = (ctx: Ctx, it: Item) =>
  it.kind === "calculation" ? calcRef(it.id) : it.kind === "measure" ? measureRef(ctx.datasetId, it.id) : JSON.stringify([{ datasetId: ctx.datasetId }, { dimensionId: it.id }]);

/** Apply a partial description. Returns what changed. */
export function applyChart(content: Json, chart: string, spec: ChartSpec): string[] {
  const ctx = ctxOf(content, chart);
  const { viz } = ctx;
  const changes: string[] = [];
  const oldRole = FEEDS[viz.type];
  if (spec.type && spec.type !== viz.type) {
    const role = FEEDS[spec.type];
    if (!role) throw new Error(`Unknown chart type '${spec.type}'. Known: ${CHART_TYPES.join(", ")}`);
    // move measures / main dimension to the feed names of the new type
    if (oldRole) {
      for (const [from, to] of [[oldRole.measures, role.measures], [oldRole.dimensions, role.dimensions]] as const) {
        if (!from || from === to) continue;
        const b = viz.bindings.find((x: Json) => x.feed === from);
        if (!b) continue;
        if (to) {
          viz.bindings = viz.bindings.filter((x: Json) => x.feed !== to || x === b);
          b.feed = to;
        } else viz.bindings = viz.bindings.filter((x: Json) => x !== b);
      }
      // a Numeric Point has only the value feed
      if (!role.dimensions) viz.bindings = viz.bindings.filter((x: Json) => x.feed === role.measures);
      // color by measures ({measureNames}) only exists for axis charts
      if (!role.dimensions || role.dimensions === "color")
        viz.bindings = viz.bindings.filter((x: Json) => !(x.feed === "color" && x.source?.some((s: Json) => s?.measureNames)));
    }
    changes.push(`type ${viz.type} → ${spec.type}`);
    viz.type = spec.type;
    const plot = ((viz.properties ??= {}).plotArea ??= {});
    // donut = pie with a hole; a chart converted from another type has none
    if (spec.type === "donut") plot.innerRadiusRatio ??= "50%";
    // treemap label layout (top left, own line for the name) breaks the labels of other types
    if (spec.type !== "treemap") {
      delete plot.dimensionLabel;
      if (plot.dataLabel) for (const k of ["align", "verticalAlign", "autoResize"]) delete plot.dataLabel[k];
    }
  }
  const role = FEEDS[viz.type];
  const feeds: Record<string, string[]> = { ...(spec.feeds ?? {}) };
  if (spec.measures) feeds[role?.measures ?? "valueAxis"] = spec.measures;
  if (spec.dimensions) {
    if (!role?.dimensions) throw new Error(`Chart type ${viz.type} has no dimension feed`);
    feeds[role.dimensions] = spec.dimensions;
  }
  if (spec.color) feeds.color = spec.color;
  if (spec.pattern) feeds.pattern2 = spec.pattern;

  const measuresBefore = (viz.bindings as Json[]).flatMap((b) => (b.source ?? []).map(parseSource)).filter((i): i is Item => !!i && i.kind !== "dimension").map((i) => i.id);
  for (const [feed, names] of Object.entries(feeds)) {
    const measureFeed = feed === role?.measures || (feed === "color" && viz.type === "treemap");
    const items = names.map((n) => resolve(ctx, n, measureFeed));
    let b = viz.bindings.find((x: Json) => x.feed === feed);
    if (!items.length) {
      if (b) viz.bindings = viz.bindings.filter((x: Json) => x !== b);
    } else {
      if (!b) viz.bindings.push((b = { feed, source: [] }));
      b.source = items.map((it) => sourceOf(ctx, it));
    }
    changes.push(`${feed}: ${names.join(", ") || "–"}`);
  }
  if (Object.keys(feeds).length || spec.type) {
    const now = new Set((viz.bindings as Json[]).flatMap((b) => (b.source ?? []).map(parseSource)).filter((i): i is Item => !!i && i.kind !== "dimension").map((i) => i.id));
    syncQuery(ctx, measuresBefore.filter((id) => !now.has(id)));
  }

  if (spec.legend !== undefined) {
    const lg = ((viz.properties ??= {}).legendGroup ??= {});
    lg.visible = spec.legend;
    // responsive legend would show up again on small widgets
    if (!spec.legend) lg.responsive = false;
    ((viz.properties.legend ??= {}).visible = spec.legend);
    changes.push(`legend ${spec.legend ? "on" : "off"}`);
  }
  for (const [dim, h] of Object.entries(spec.hierarchy ?? {})) changes.push(setHierarchy(ctx, dim, h));
  for (const f of spec.filters ?? []) changes.push(setFilter(ctx, f));
  if (changes.length) dropPreExecute(content, chart);
  return changes;
}

/**
 * Hierarchy + level (recorded from a demo story: treemap on products = level 1, InitialDrillLevel 1, offset 1; donut on
 * categories = level 0, offset -1). Lives in the query's dimension element, the external hierarchyLevels and the
 * dimension entries of usedDimensions/hierarchyOptions.
 */
function setHierarchy(ctx: Ctx, dim: string, h: { id: string; level?: number; includeParents?: boolean }): string {
  const viz = ctx.viz;
  const level = h.level ?? 0;
  const el = viz.ffQuery.DimensionsRepo.Elements.find((e: Json) => e.Name === dim);
  if (!el) throw new Error(`'${dim}' is not used in the chart; add it to a feed first`);
  el.HierarchyRepo = {
    ...(el.HierarchyRepo ?? {}),
    CType: "Hierarchy",
    ExpandBottomUp: false,
    HierarchyActive: true,
    HierarchyName: h.id,
    Name: h.id,
    InitialDrillLevel: level,
    InitialDrillOffset: level > 0 ? level : -1,
    SelectorInitialDrillLevel: 0,
  };
  const ent = dimEntity(ctx, dim, h.id);
  const isDim = (s: string) => typeof s === "string" && s.includes(`{"dimensionId":"${dim}"}`);
  const ext = (viz.initialUQMExternalState ??= {});
  const levels: Json[] = (ext.hierarchyLevels ??= []);
  const li = levels.findIndex((x) => isDim(x.dimensionId));
  const entry = { dimensionId: ent, level, includeParents: !!h.includeParents, isDefaultLevel: false };
  if (li >= 0) levels[li] = entry;
  else levels.push(entry);
  const opts: Json[] = (ext.hierarchyOptions ??= []);
  const oi = opts.findIndex((x) => isDim(x.entityId));
  if (oi >= 0) opts[oi].entityId = ent;
  else opts.push({ entityId: ent, showLeavesOnly: false });
  const used = ext.usedDimensions ?? {};
  for (const k of ["rowAxis", "columnAxis"]) used[k] = (used[k] ?? []).map((x: string) => (isDim(x) ? ent : x));
  return `hierarchy ${dim}: ${h.id} level ${level}${h.includeParents ? " with parents" : ""}`;
}

const dimEntity = (ctx: Ctx, dim: string, hier?: string) =>
  JSON.stringify([{ datasetId: ctx.datasetId }, { dimensionId: dim }, ...(hier ? [{ hierarchyId: hier }] : [])]);
const filterDim = (f: Json): string | undefined =>
  (f.extendedSelection?.targetEntity?.dimensionEntityId ?? f.dimensionEntity?.entityId ?? "").match(/"dimensionId":"([^"]+)"/)?.[1];

function setFilter(ctx: Ctx, f: ChartFilter): string {
  const viz = ctx.viz;
  const list: Json[] = (viz.filters ??= []);
  if (f.dynamic) {
    const g = GRANULARITY[f.dynamic.granularity];
    if (!g) throw new Error(`granularity: one of ${Object.keys(GRANULARITY).join(", ")}`);
    let r = list.find((x) => x.schemaType === "IC_RANGE" && filterDim(x) === f.dimension);
    if (!r) {
      r = {
        display: { iconHidden: false, isRangeSliderHidden: false, isLastOffsetHidden: false, isCurrentDateHidden: false, isNextOffsetHidden: false, isRangeInfoIconHidden: false, isRangeSliderHiddenInReadonly: false },
        icProps: { isViewerAllowedToDeleteIC: false },
        extendedSelection: { isCascadedOut: false, isAllowReset: true },
        icElementStringId: randomUUID(),
        schemaType: "IC_RANGE",
        dimensionEntity: { datasetEntityId: viz.datasetEntityId, entityId: dimEntity(ctx, f.dimension, f.hierarchy ?? "YQM") },
        lovInfo: { selectionType: "multiple" },
        subType: "DynamicTime",
        ranges: [],
      };
      list.push(r);
    }
    // year-week-day hierarchies have no quarter/month ("Unhandled granularity") → use year-quarter-month
    const ent = r.dimensionEntity?.entityId as string | undefined;
    if (f.hierarchy) r.dimensionEntity.entityId = dimEntity(ctx, f.dimension, f.hierarchy);
    else if (ent?.includes('"hierarchyId":"YWD"') && (g === "CALMONTH" || g === "CALQUARTER")) r.dimensionEntity.entityId = ent.replace('"YWD"', '"YQM"');
    const offset = { last: f.dynamic.last ?? 0, next: f.dynamic.next ?? 0 };
    // selection.offset is what SAC applies; selectionDefinition.offset alone is ignored
    r.ranges = [
      {
        selectionDefinition: { offset, granularity: g, currentDateOffset: { offset: 0, direction: "BACKWARD", granularity: "YEAR" }, rangeId: r.ranges?.[0]?.selectionDefinition?.rangeId ?? randomUUID() },
        selection: { offset: { ...offset } },
        isSelected: true,
      },
    ];
    return `filter ${f.dimension}: current ${f.dynamic.granularity}${offset.last ? ` −${offset.last}` : ""}${offset.next ? ` +${offset.next}` : ""}`;
  }
  const i = list.findIndex((x) => x.schemaType === "IC_MEMBER" && filterDim(x) === f.dimension);
  if (!f.members?.length) {
    if (i >= 0) list.splice(i, 1);
    return `filter ${f.dimension}: removed`;
  }
  const key = (m: string) => (f.dimension === "Version" && !m.includes(".") ? `public.${m}` : f.hierarchy ? `[${f.dimension}].[${f.hierarchy}].&[${m}]` : m);
  const caption = (m: string) => m.replace(/^public\./, "");
  const values = f.members.map((m) => ({ key: key(m), caption: caption(m), displayId: f.hierarchy ? m : key(m) }));
  const dimId = dimEntity(ctx, f.dimension, f.hierarchy);
  const entry = {
    display: { showApplySelectionsButton: true },
    icProps: { isViewerAllowedToDeleteIC: false, isViewerAllowedToChangeSelection: false, isViewerAllowedToChangeICHierarchy: false },
    extendedSelection: {
      isCascadedOut: false,
      targetEntity: {
        datasetEntityId: viz.datasetEntityId,
        dimensionEntityId: dimId,
        attributeEntityId: JSON.stringify([...JSON.parse(dimId), { attributeId: f.hierarchy ? `[${f.dimension}].key` : `${f.dimension}.ID` }]),
      },
      isAllowReset: true,
    },
    lovInfo: { isUseDefaultReadMode: false, isDisableMemberSelectorCascade: false, selectionMode: "dynamic", staticMembers: values },
    schemaType: "IC_MEMBER",
    icElementStringId: i >= 0 ? list[i].icElementStringId : randomUUID(),
    selection: { isAllSelected: false, isDeselection: false, selectedValues: values },
    userSelection: { isAllSelected: false, selections: values.map((v) => [v.key, { selected: true, displayId: v.displayId, caption: v.caption, children: [], depth: 0 }]) },
  };
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  return `filter ${f.dimension}: ${f.members.join(", ")}`;
}

/** Bring axes, dimension repo, measure filter and used dimensions/measures in line with the feeds. */
function syncQuery(ctx: Ctx, dropped: string[] = []) {
  const { viz } = ctx;
  const q = viz.ffQuery;
  const items = viz.bindings.flatMap((b: Json) => (b.source ?? []).map(parseSource).filter(Boolean)) as Item[];
  const rows = [...new Set(items.filter((i) => i.kind === "dimension").map((i) => i.id))];
  const measures = items.filter((i) => i.kind !== "dimension");

  // axes: axis charts keep the feed dimensions on Rows, donut/pie on Columns in front of the measures
  // (recorded: donut color dimension on Columns); measures on Columns; everything else Free
  const dimAxis = viz.type === "donut" || viz.type === "pie" ? "Columns" : "Rows";
  const layout: Record<string, string[]> = { Rows: dimAxis === "Rows" ? rows : [], Columns: [...(dimAxis === "Columns" ? rows : []), "CustomDimension1"] };
  const axes = q.Query.AxesLayout;
  const all = axes.flatMap((a: Json) => a.OrderedDimensionNames).filter((d: string) => !d.startsWith("$$") && d !== "CustomDimension1");
  for (const name of ["Columns", "Rows"])
    if (layout[name].length && !axes.some((a: Json) => a.Axis === name))
      axes.splice(axes.findIndex((a: Json) => a.Axis === "Technical"), 0, { Axis: name, OrderedDimensionNames: [] });
  for (const ax of axes) {
    if (layout[ax.Axis]) ax.OrderedDimensionNames = layout[ax.Axis];
    else if (ax.Axis === "Free") ax.OrderedDimensionNames = all.filter((d: string, i: number) => !rows.includes(d) && all.indexOf(d) === i);
  }
  q.Query.AxesLayout = axes.filter((a: Json) => a.Axis !== "Rows" || layout.Rows.length);
  const repoAxes = q.Query.AxesRepo.Elements;
  for (const [name, type] of [["Columns", 2], ["Rows", 1]] as const) {
    let el = repoAxes.find((e: Json) => e.Axis === name);
    if (!el) repoAxes.push((el = { Axis: name, CType: "Axis", Layout: [], ResultStructureRepo: { CType: "Totals", ResultAlignment: "Default", Visibility: "Default" }, Type: type, ZeroSuppressionType: 0 }));
    el.Layout = layout[name];
  }

  const els = q.DimensionsRepo.Elements;
  for (const e of els) if (e.Name !== "CustomDimension1" && e.Axis !== "None" && !rows.includes(e.Name)) e.Axis = "None";
  for (const d of rows) {
    const e = els.find((x: Json) => x.Name === d);
    if (e) e.Axis = dimAxis;
    // SAC completes the remaining fields of a minimal element when it loads the query
    else els.push({ Axis: dimAxis, CType: "Dimension", Name: d, FieldLayoutType: "FieldBased", FieldSettings: [], ReadMode: "BookedAndSpaceAndState", SelectorReadMode: "Booked" });
  }

  // measures: member of the measure structure + measure filter + used measures
  const mDim = els.find((e: Json) => e.Name === "CustomDimension1");
  const mFilter = (q.FilterRepo?.DynamicFilter?.FilterRoot?.SubSelections ?? []).find((s: Json) => s.FieldName === "[Measures].[Measures]");
  if (mDim && measures.length) {
    for (const id of dropped) {
      const i = mDim.OrderedStructureMemberNames.indexOf(id);
      if (i >= 0) mDim.OrderedStructureMemberNames.splice(i, 1);
      mDim.MembersRepo = (mDim.MembersRepo ?? []).filter((r: Json) => r.KeyRef?.ObjectName !== id);
      if (mDim.VisibilityOverride) delete mDim.VisibilityOverride[id];
    }
    for (const m of measures) {
      if (!mDim.OrderedStructureMemberNames.includes(m.id)) {
        mDim.OrderedStructureMemberNames.push(m.id);
        mDim.MembersRepo ??= [];
        mDim.MembersRepo.push(
          m.kind === "calculation"
            ? { CType: "MemberRestricted", KeyRef: { GroupName: "primaryStructure", ObjectName: m.id } }
            : { CType: "BasicMeasure", KeyRef: { GroupName: "CustomDimension1", ObjectName: m.id, StorageName: "main" } },
        );
        (mDim.VisibilityOverride ??= {})[m.id] = "Visible";
      }
    }
    if (mFilter) {
      const op = (v: string) => ({ CType: "FilterOperation", Comparison: "=", Exactness: 0, FieldName: "[Measures].[Measures]", HasDepth: false, HasLevelOffset: false, Id: randomUUID(), IsExcluding: false, Values: [{ Value: v, ValueType: "String" }] });
      const keep = new Map(mFilter.Elements.map((e: Json) => [e.Values?.[0]?.Value, e]));
      mFilter.Elements = measures.map((m) => keep.get(m.id) ?? op(m.id));
    }
  }
  const ext = (viz.initialUQMExternalState ??= {});
  if (measures.length) ext.usedMeasures = measures.map((m) => sourceOf(ctx, m));
  const used = (ext.usedDimensions ??= {});
  // keep existing entries: they carry the hierarchy ({"hierarchyId":"H_KAT"})
  const prev: string[] = [...(used.rowAxis ?? []), ...(used.columnAxis ?? [])];
  const entry = (d: string) => {
    const plain = sourceOf(ctx, { kind: "dimension", id: d });
    return prev.find((s) => s === plain || s.startsWith(plain.slice(0, -1) + ",")) ?? plain;
  };
  used.rowAxis = layout.Rows.map(entry);
  used.columnAxis = layout.Columns.map(entry);
}
