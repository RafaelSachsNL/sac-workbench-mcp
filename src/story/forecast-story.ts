/**
 * Planning story with forecast layouts, generated from a recorded story (templates/planning_forecast_story.json,
 * built in the SAC editor on MCP_SP_DEMOCOOKIE and stored without query caches):
 *
 *   header composite (title) · filter bar with the calculation input control CIC_PLANVERSION
 *   card 1  Forecast layout, months: Actual up to today (cut-over), plan version up to year end, sum of the year
 *   card 2  Forecast layout, quarters + 1 year look-ahead: the current year's quarters hidden (date-only hidden
 *           tuples), so only "<year> (actual + plan)" and the next year's quarters (expanded) remain
 *
 * Both tables take Look Ahead On from CIC_PLANVERSION; Actual stays fixed. The recorded story is re-targeted by text
 * substitution: model, data source, rows dimension, measure, titles and years (relative to the recorded year).
 * Seamless planning models only for now (the recorded data source is a Datasphere one).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirOf } from "../paths.js";
import { substitute } from "./fragments.js";
import type { PlanningModel } from "./planwrite.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "planning_forecast_story.json");

/** Shift years that stand in date member ids, captions and names (never inside hex ids or timestamps). */
function shiftYears(text: string, delta: number): string {
  if (!delta) return text;
  return text.replace(/(?<![0-9A-Fa-f-])(20\d\d)(?=\d{0,2}[\]\)\s_"\\,.])/g, (y) => String(Number(y) + delta));
}

/**
 * Queries list every model dimension (and attribute) on the Free axis. After re-targeting, the recorded rows dimension
 * may now collide with a dimension already listed there, or a dimension of the recorded model may not exist in the
 * target model — either makes the query invalid (e.g. the version control shows "no longer usable").
 */
function normalizeAxes(node: Json, dims: Set<string>): Json {
  if (typeof node === "string") {
    if (!node.includes("OrderedDimensionNames")) return node;
    try {
      return JSON.stringify(normalizeAxes(JSON.parse(node), dims));
    } catch {
      return node;
    }
  }
  if (Array.isArray(node)) return node.map((n) => normalizeAxes(n, dims));
  if (!node || typeof node !== "object") return node;
  for (const k of Object.keys(node)) node[k] = normalizeAxes(node[k], dims);
  if (Array.isArray(node.AxesLayout)) {
    const placed = new Set(node.AxesLayout.filter((a: Json) => a.Axis !== "Free").flatMap((a: Json) => a.OrderedDimensionNames ?? []));
    const known = (n: string) => n.startsWith("$$") || n.startsWith("CustomDimension") || dims.has(n.split(".")[0]);
    for (const a of node.AxesLayout)
      if (a.Axis === "Free" && Array.isArray(a.OrderedDimensionNames)) {
        const free = [...new Set<string>(a.OrderedDimensionNames)].filter((n) => known(n) && !placed.has(n));
        // dimensions of the target model that no axis mentions any more (e.g. the recorded rows dimension's partner)
        const missing = [...dims].filter((d) => !placed.has(d) && !free.includes(d) && free.some((n) => n.startsWith(`${d}.`) || dims.has(n)));
        a.OrderedDimensionNames = [...missing, ...free];
      }
  }
  return node;
}

export function buildForecastStoryContent(opts: {
  model: PlanningModel;
  title: string;
  rowDimension: string;
  measure: string;
  year?: number;
}): { content: Json; cards: string[]; tables: string[] } {
  const { recorded: r, content } = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const m = opts.model;
  if (!m.dataSource?.System) throw new Error(`'${m.name}' is not a Seamless planning model — this story type is recorded on Seamless planning only`);
  if (m.timeDimension !== "Date") throw new Error(`Time dimension of '${m.name}' is '${m.timeDimension}', the recorded story needs 'Date'`);
  if (!m.dimensions.some((d) => d.name === "Version")) throw new Error(`'${m.name}' has no Version dimension`);
  const dim = m.dimensions.find((d) => d.name === opts.rowDimension || d.description === opts.rowDimension);
  if (!dim) throw new Error(`Dimension '${opts.rowDimension}' not found. Available: ${m.dimensions.map((d) => d.name).join(", ")}`);
  const meas = m.measures.find((x) => x.name === opts.measure || x.description === opts.measure);
  if (!meas) throw new Error(`Measure '${opts.measure}' not found. Available: ${m.measures.map((x) => x.name).join(", ")}`);

  const year = opts.year ?? new Date().getFullYear();
  const delta = year - r.year;
  const cardMonths = `Forecast ${year} – actuals to date, plan to year end`;
  const cardQuarters = `Plan ${year + 1} – quarters`;
  const shifted = (s: string) => shiftYears(s, delta);

  let text = shiftYears(JSON.stringify(content), delta);
  text = substitute(text, [
    [r.objectName, m.dataSource.ObjectName],
    [r.cubeId, m.cubeId],
    [r.schema, m.dataSource.SchemaName],
    [r.system, m.dataSource.System],
    [r.modelDescription, m.description || m.name],
    [r.storyName, opts.title],
    [r.title, opts.title],
    [shifted(r.cardMonths), cardMonths],
    [shifted(r.cardMonthsStem), "FORECAST_CURRENT_YEAR"],
    [shifted(r.cardQuarters), cardQuarters],
    [shifted(r.cardQuartersStem), "PLAN_NEXT_YEAR"],
    [shifted(r.sumCaption), `${year} (actual + plan)`],
    [r.measureCaption, meas.description || meas.name],
    [r.rowDimensionCaption, dim.description || dim.name],
    [`"${r.model}"`, `"${m.name}"`],
    [`\\"${r.model}\\"`, `\\"${m.name}\\"`],
    // names inside InA JSON strings and member keys: "Cookie", Cookie.ID, [Cookie]
    [`"${r.rowDimension}"`, `"${dim.name}"`],
    [`\\"${r.rowDimension}\\"`, `\\"${dim.name}\\"`],
    [`${r.rowDimension}.`, `${dim.name}.`],
    [`[${r.rowDimension}]`, `[${dim.name}]`],
    [`"${r.measure}"`, `"${meas.name}"`],
    [`\\"${r.measure}\\"`, `\\"${meas.name}\\"`],
  ]);
  return {
    content: normalizeAxes(JSON.parse(text), new Set(m.dimensions.map((d) => d.name))),
    cards: [`PA_CARD_FORECAST_CURRENT_YEAR_001`, `PA_CARD_PLAN_NEXT_YEAR_001`],
    tables: [`TA_FORECAST_${year}_001`, `TA_PLAN_${year + 1}_001`],
  };
}

