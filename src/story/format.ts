/**
 * Formatting of chart/KPI widgets (vizDefinition in the page widget registry): title, subtitle, number scale, decimals.
 * Recorded from the styling panel: htmlTitle/htmlSubtitle + headerProperties flags; userDefinedNumberScales
 * ({valueAxis} for axis charts, {measureSelections} for numeric points) and userDefinedDecimalFormat.
 */

import { storyEntity, outlineNames } from "./content.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type Scale = "Default" | "Unformatted" | "Thousand" | "Million" | "Billion" | "Auto-Formatted";

/**
 * Stored value per UI label (recorded from the styling panel). "Default" is no entry at all;
 * any other unknown text is rendered literally as the unit ("49.1 Unformatted"). undefined = remove.
 */
const SCALE_KEY: Record<Scale, string | undefined> = {
  Default: undefined,
  Unformatted: "",
  Thousand: "Thousand",
  Million: "Million",
  Billion: "Billion",
  "Auto-Formatted": "auto",
};

/**
 * Scale for one KPI/chart: its own value, else Default for percentages (name/caption with %, PCT, PERCENT — a
 * margin of 49 % must not become "0.0 Million"), else the dashboard-wide scale.
 */
export function scaleFor(item: { measure: string; label?: string; scale?: Scale }, global: Scale, caption?: string): Scale {
  if (item.scale) return item.scale;
  return [item.measure, item.label, caption].some((t) => t && /%|PCT|PERCENT|PROZENT/i.test(t)) ? "Default" : global;
}

export interface VizFormat {
  title?: string;
  subtitle?: string;
  scale?: Scale;
  decimals?: number;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const html = (t: string) => `<p><span>${esc(t)}</span></p>`;

export function findRegistryWidget(content: Json, outlineName: string): Json {
  const hit = [...outlineNames(content).entries()].find(([, n]) => n.name === outlineName);
  if (!hit) throw new Error(`No widget named '${outlineName}'`);
  for (const page of storyEntity(content).data.pages) {
    const w = page.content?.widgets?.find((x: Json) => x.id === hit[0]);
    if (w) return w;
  }
  throw new Error(`Widget '${outlineName}' not found on any page`);
}

/** Measure entity ids used by the widget ([{"datasetId":…},{"dimensionId":"CustomDimension1"},{"measureId":…}]). */
function measureIds(viz: Json): string[] {
  const text = JSON.stringify(viz);
  const re = /\[\{\\"datasetId\\":\\"([^"\\]+)\\"\},\{\\"dimensionId\\":\\"CustomDimension1\\"\},\{\\"measureId\\":\\"([^"\\]+)\\"\}\]/g;
  const ids = new Set<string>();
  for (const m of text.matchAll(re)) ids.add(JSON.stringify([{ datasetId: m[1] }, { dimensionId: "CustomDimension1" }, { measureId: m[2] }]));
  return [...ids];
}

export function formatViz(content: Json, outlineName: string, f: VizFormat) {
  const w = findRegistryWidget(content, outlineName);
  const viz = w.definition?.vizDefinition;
  if (!viz) {
    // tables: scale and decimals only (the title is the table's own header)
    if (f.title !== undefined || f.subtitle !== undefined) throw new Error(`'${outlineName}' is not a chart/KPI widget — tables take scale and decimals only`);
    return formatTableNumbers(content, outlineName, undefined, f);
  }
  viz.headerProperties ??= { isTitleExpanded: true };
  if (f.title !== undefined) {
    viz.htmlTitle = html(f.title);
    viz.headerProperties.hasUserModifiedTitle = true;
  }
  if (f.subtitle !== undefined) {
    viz.htmlSubtitle = html(f.subtitle);
    viz.subtitle = f.subtitle;
    viz.headerProperties.hasUserModifiedSubtitle = true;
  }
  const label = (((viz.userPreferences ??= {}).general ??= {}).label ??= {});
  // charts honour the per-measure entries, KPIs the "all" entry — write both like the styling panel does
  const ids = [...measureIds(viz), "all"];
  // axis charts (bar, line, …) read valueAxis; numeric points read measureSelections
  if (f.scale) {
    const key = SCALE_KEY[f.scale];
    if (key === undefined) delete label.userDefinedNumberScales;
    else
      label.userDefinedNumberScales = {
        // the styling panel writes valueAxis only for the fixed scales
        ...(key && key !== "auto" ? { valueAxis: key } : {}),
        measureSelections: ids.map((id) => ({ id, scale: key, showCurrencyUnit: true, showScale: true })),
      };
  }
  if (f.decimals !== undefined) {
    const dec = { measureSelections: ids.map((id) => ({ id, decimalPlaces: f.decimals })) };
    label.userDefinedDecimalFormat = dec;
    ((viz.properties ??= {}).general ??= {}).userDefinedDecimalFormat = structuredClone(dec);
  }
}

/**
 * Minimal look: no generic widget information, only the content.
 *   charts/KPIs: subtitle (unit/scale line) hidden — errors and warnings still show; KPIs without measure label
 *   tables:      header area (title, subtitle, details) and dimension headers hidden
 * Recorded from Show/Hide in the story editor.
 */
export function applyMinimalStyle(content: Json, outlineName: string) {
  const w = findRegistryWidget(content, outlineName);
  const viz = w.definition?.vizDefinition;
  if (viz) {
    ((viz.userPreferences ??= {}).subtitle ??= {}).visible = false;
    // numeric point: no measure label under the value (Show/Hide → Primary Value Labels)
    if (viz.type === "metric") (((viz.properties ??= {}).primaryDatapoint ??= {}).categoryAxis ??= {}).visible = false;
    return;
  }
  const entity = content.entities.find((e: Json) => e?.id === w.definition?.entityId);
  const regions = (entity?.data?.content?.segments ?? []).map((s: Json) => s?.dataRegion).filter(Boolean);
  if (!regions.length) throw new Error(`'${outlineName}' is neither a chart nor a table`);
  for (const r of regions) Object.assign(r, { showTitle: false, showTitleText: false, showSubtitle: false, showDetails: false, showDimensionHeaders: false });
}

/**
 * Number scale and decimals of a table, per measure. Recorded from Styling → Data cell → Number Format:
 * a style in the table's styleLib ({number: {scale, decimalPlaces}}) referenced from
 * dataRegion.styles with the measure as member context. The styleHashMap entry only deduplicates styles.
 */
export function formatTableNumbers(content: Json, outlineName: string, measures: string[] | undefined, f: { scale?: Scale; decimals?: number }) {
  const w = findRegistryWidget(content, outlineName);
  const tableContent = content.entities.find((e: Json) => e?.id === w.definition?.entityId)?.data?.content;
  const region = tableContent?.segments?.find((s: Json) => s?.dataRegion)?.dataRegion;
  if (!region) throw new Error(`'${outlineName}' is not a table`);
  // default: every measure of the table's query
  const targets: string[] = measures ?? JSON.parse(region.ffQuery ?? "{}").DimensionsRepo?.Elements?.find((e: Json) => e?.Name === "CustomDimension1")?.OrderedStructureMemberNames ?? [];
  const scale = f.scale === undefined ? undefined : SCALE_KEY[f.scale];
  if (scale === undefined && f.decimals === undefined) return;
  const lib = (tableContent.styleLib ??= { key: `styleLib_${Date.now()}`, syncUpdateTime: Date.now(), stylesMeta: {} });
  const meta = lib.stylesMeta;
  meta.stylesKeyHashMap ??= {};
  meta.styleHashMap ??= {};
  lib.styles ??= [];
  region.styles ??= [];
  for (const measure of targets) {
    // one style per measure: replace an earlier one written for the same measure
    const old = region.styles.find((s: Json) => s?.memberContext?.CustomDimension1?.id === measure && Object.keys(s.memberContext).length === 1);
    const style: Json = old ? lib.styles.find((s: Json) => s.key === old.styleKey) : undefined;
    const number = {
      scale: scale ?? null, scaleFormat: null, showSignAs: null, arrowPosition: null, scaleChildren: null,
      scaleFormatChildren: null, showSignAsChildren: null, arrowPositionChildren: null, decimalPlacesChildren: null,
      decimalPlaces: f.decimals ?? null,
    };
    if (style) {
      style.number ??= number;
      if (scale !== undefined) style.number.scale = scale;
      if (f.decimals !== undefined) style.number.decimalPlaces = f.decimals;
      continue;
    }
    const key = `${Date.now()}${String(lib.styles.length).padStart(3, "0")}`;
    const hash = String(javaHash(JSON.stringify({ number, measure })));
    lib.styles.push({ key, wordWrap: false, isNone: false, number, border: { lineStyle: 1, type: [-1], width: 2 }, font: {} });
    meta.stylesKeyHashMap[key] = { index: lib.styles.length - 1, hash, refCount: 1 };
    meta.styleHashMap[hash] = key;
    region.styles.push({ memberContext: { CustomDimension1: { id: measure } }, styleKey: key });
  }
  lib.syncUpdateTime = Date.now();
}

function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
