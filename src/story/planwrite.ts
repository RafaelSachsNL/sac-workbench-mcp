/**
 * Planning data entry without a story, recorded from typing a value into an SAC planning table.
 *
 * The table sends an InA Analytics query plus NewValues (cell coordinates, value as string, action data_entry,
 * PlanningMode ForcePlanning); SAC disaggregates the value to the leaves (e.g. quarter → months, category →
 * products, proportionally to existing values). Here the query has no row dimensions — every target member is a
 * filter — so the result is always exactly one cell [0,0], even where nothing is booked yet.
 *
 *   SAC planning model:      /sap/bc/ina/service/v2/GetResponse
 *   Seamless (Datasphere):   /lcs/dwc/<DataSource.System>/sap/bc/ina/service/v2/GetResponse
 *
 * Public versions are put into edit mode first (version-actions/start-public-edit); entries stay unpublished until
 * publishVersion (or the user publishes in SAC).
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "../browser/session.js";
import { dirOf } from "../paths.js";
import { contentlib } from "./content.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "ina_planning_query.json");
const tpl = () => JSON.parse(readFileSync(TEMPLATE, "utf8"));

export interface PlanningModel {
  cubeId: string;
  name: string;
  description: string;
  dataSource: Json;
  endpoint: string;
  timeDimension: string;
  dimensions: { name: string; description: string; type: string }[];
  measures: { name: string; description: string; calculated: boolean }[];
  /** analytic SAC model (no planning): readable like a planning model, not writable */
  analytic?: boolean;
}

async function findCubeId(model: string): Promise<{ cubeId: string; name: string }> {
  if (/^C[0-9a-z]{20,}$/.test(model)) return { cubeId: model, name: model };
  const hits: Json[] = await contentlib("getSearchList", { type: "CUBE", value: model, bIncTemporary: false, spaceId: null });
  const exact = (Array.isArray(hits) ? hits : []).filter((h) => String(h.name).toLowerCase() === model.toLowerCase());
  if (exact.length !== 1) throw new Error(exact.length ? `Model name '${model}' is ambiguous — pass the model id (C…)` : `Model '${model}' not found`);
  return { cubeId: exact[0].resourceId, name: exact[0].name };
}

export async function planningModel(model: string): Promise<PlanningModel> {
  const m = await sacModel(model);
  if (m.analytic) throw new Error(`'${m.name}' is not an SAC planning model`);
  return m;
}

/**
 * SAC model, planning or analytic. Analytic models carry no DataSource in their definition; stories address them
 * like native planning models (recorded from the UI: dataset planning:[TENANT_<pkg>][][/<model package>/<id>_qs],
 * datasetType Analytic, InA Type Planning), with the tenant's own package — not the model's — in the schema.
 */
export async function sacModel(model: string): Promise<PlanningModel> {
  const { cubeId, name } = await findCubeId(model);
  // a model created seconds ago is not readable yet (RESOURCE_NOT_EXIST) — wait like the other model tools
  let res: Json;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await contentlib("getContent", { resourceType: "CUBE", resourceId: cubeId, oOpt: {} });
      break;
    } catch (e) {
      if (attempt >= 10 || !String(e).includes("RESOURCE_NOT_EXIST")) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  const cd = typeof res.cdata === "string" ? JSON.parse(res.cdata) : res.cdata;
  const analytic = res.resourceSubtype === "ANALYTIC";
  if (!analytic && (cd?.type !== "Planning" || !cd.DataSource)) throw new Error(`'${res.name ?? name}' is not an SAC model the generator can bind`);
  const tenantPkg = String(res.sourceResource?.packageId ?? "").replace(/^t\./, "");
  if (analytic && !tenantPkg) throw new Error(`Cannot tell the tenant schema for '${res.name ?? name}'`);
  const dataSource = analytic
    ? { ObjectName: `/${res.packageId}/${cubeId}_qs`, SchemaName: `TENANT_${tenantPkg}`, Type: "Planning", Description: res.description ?? res.name }
    : cd.DataSource;
  const system = dataSource.System as string | undefined;
  return {
    cubeId,
    name: res.name ?? name,
    description: res.description ?? "",
    analytic,
    dataSource,
    endpoint: system ? `/lcs/dwc/${encodeURIComponent(system)}/sap/bc/ina/service/v2/GetResponse` : "/sap/bc/ina/service/v2/GetResponse",
    timeDimension: cd?.planningTimeDimension,
    dimensions: (cd?.dimensions ?? []).map((d: Json) => ({ name: d.name ?? d.dimensionId, description: d.description ?? "", type: d.type })),
    measures: (cd?.measures ?? []).map((m: Json) => ({ name: m.measure, description: m.description ?? m.measure, calculated: Boolean(m.calculated) || Boolean(m.formula) })),
  };
}

async function ina(m: PlanningModel, definition: Json): Promise<Json> {
  const t = tpl();
  const body = {
    Batch: [
      {
        Analytics: { Capabilities: t.Capabilities, DataSource: { ...m.dataSource, InstanceId: randomUUID() }, Definition: definition, Language: t.Language },
        Options: [],
      },
    ],
  };
  const res = await browser.request("POST", m.endpoint, body);
  const out = res.body as Json;
  if (res.status >= 400 || typeof out !== "object") throw new Error(`InA request failed (${res.status}): ${JSON.stringify(out).slice(0, 800)}`);
  const batch = out.Batch?.[0] ?? out;
  const errors = (batch.Messages ?? []).filter((x: Json) => x.Type === 2 || x.Severity === "Error" || x.MessageClass === "Error");
  if (errors.length) throw new Error(`SAC refused: ${errors.map((x: Json) => x.Text ?? JSON.stringify(x)).join("; ").slice(0, 800)}`);
  if (!batch.Grids) throw new Error(`Unexpected InA answer: ${JSON.stringify(out).slice(0, 800)}`);
  return batch.Grids[0];
}

const cellValues = (grid: Json): number[] => {
  const v = grid.Cells?.Values;
  const list = Array.isArray(v) ? v : (v?.Values ?? []);
  return list.map((x: Json) => Number(x));
};

/** Members of a dimension: id + description (master data, not only booked). */
export async function dimensionMembers(m: PlanningModel, dimension: string): Promise<{ id: string; description: string }[]> {
  const grid = await ina(m, {
    Dimensions: [
      {
        Attributes: [
          { Name: `${dimension}.ID`, Obtainability: "UserInterface" },
          { Name: `${dimension}.Description`, Obtainability: "UserInterface" },
        ],
        Axis: "Rows",
        Name: dimension,
        ReadMode: "Master",
        ResultStructure: [{ Result: "Members", Visibility: "Visible" }],
      },
      { Axis: "Columns", Name: "CustomDimension1", Members: [{ MemberName: m.measures.find((x) => !x.calculated)?.name ?? m.measures[0].name, Visibility: "Visible" }] },
    ],
    ResultSetFeatureRequest: tpl().ResultSetFeatureRequest,
  });
  const attrs = grid.Axes?.[0]?.Dimensions?.[0]?.Attributes ?? [];
  const ids: string[] = attrs.find((a: Json) => a.Name === `${dimension}.ID`)?.Values ?? [];
  const texts: string[] = attrs.find((a: Json) => a.Name === `${dimension}.Description`)?.Values ?? [];
  return ids.map((id, i) => ({ id, description: texts[i] ?? "" })).filter((x) => x.id);
}

/** "Q1 2025", "2025-Q1", "2025", "202501", "2025-01", "01.2025" → [first month, last month] as YYYYMM. */
export function monthRange(period: string): [string, string] {
  const p = period.trim().toUpperCase();
  let m = p.match(/^Q([1-4])[\s./-]*(\d{4})$/) ?? p.match(/^(\d{4})[\s./-]*Q([1-4])$/);
  if (m) {
    const [q, y] = /^Q/.test(p) ? [Number(m[1]), m[2]] : [Number(m[2]), m[1]];
    return [`${y}${String(q * 3 - 2).padStart(2, "0")}`, `${y}${String(q * 3).padStart(2, "0")}`];
  }
  if ((m = p.match(/^(\d{4})$/))) return [`${m[1]}01`, `${m[1]}12`];
  if ((m = p.match(/^(\d{4})[-./]?(\d{2})$/))) return [`${m[1]}${m[2]}`, `${m[1]}${m[2]}`];
  if ((m = p.match(/^(\d{2})[./-](\d{4})$/))) return [`${m[2]}${m[1]}`, `${m[2]}${m[1]}`];
  throw new Error(`Period '${period}' not understood — use e.g. "Q1 2025", "2025", "2025-03"`);
}

export interface PlanCell {
  model: string;
  version: string;
  measure: string;
  /** dimension (name or description) → member (id or description); several members = their total */
  members: Record<string, string | string[]>;
  /** time: "Q1 2025", "2025", "2025-03" … (planning time dimension); omitted = no time restriction */
  period?: string;
}

interface Resolved {
  model: PlanningModel;
  version: { id: string; description: string };
  measure: string;
  filters: { dimension: string; members: { id: string; description: string }[] }[];
  months?: [string, string];
}

const norm = (s: string) => s.trim().toLowerCase();

async function resolveCell(cell: PlanCell): Promise<Resolved> {
  const model = await planningModel(cell.model);
  const measure = model.measures.find((x) => norm(x.name) === norm(cell.measure) || norm(x.description) === norm(cell.measure));
  if (!measure) throw new Error(`Measure '${cell.measure}' not in ${model.name}. Available: ${model.measures.map((x) => x.name).join(", ")}`);
  if (measure.calculated) throw new Error(`'${measure.name}' is calculated and cannot be planned directly`);
  const versionDim = model.dimensions.find((d) => d.type === "VersionDim")?.name ?? "Version";
  const versions = await dimensionMembers(model, versionDim);
  const v = versions.find((x) => norm(x.id) === norm(cell.version) || norm(x.description) === norm(cell.version) || norm(x.id) === `public.${norm(cell.version)}`);
  if (!v) throw new Error(`Version '${cell.version}' not found. Available: ${versions.map((x) => x.description || x.id).join(", ")}`);
  const filters: Resolved["filters"] = [];
  for (const [dimIn, wanted] of Object.entries(cell.members)) {
    const dim = model.dimensions.find((d) => norm(d.name) === norm(dimIn) || norm(d.description) === norm(dimIn));
    if (!dim) throw new Error(`Dimension '${dimIn}' not in ${model.name}. Available: ${model.dimensions.map((d) => d.name).join(", ")}`);
    const all = await dimensionMembers(model, dim.name);
    const members = (Array.isArray(wanted) ? wanted : [wanted]).map((w) => {
      const hit = all.find((x) => norm(x.id) === norm(w)) ?? all.find((x) => norm(x.description) === norm(w));
      if (!hit) throw new Error(`'${w}' is not a member of ${dim.name}. Examples: ${all.slice(0, 12).map((x) => `${x.id} (${x.description})`).join(", ")}`);
      return hit;
    });
    filters.push({ dimension: dim.name, members });
  }
  return { model, version: v, measure: measure.name, filters, months: cell.period ? monthRange(cell.period) : undefined };
}

function cellQuery(r: Resolved): Json {
  const sel: Json[] = [
    { SetOperand: { Elements: [{ Comparison: "=", Low: r.measure }], FieldName: "[Measures].[Measures]" } },
    { SetOperand: { Elements: [{ Comparison: "=", Low: r.version.id }], FieldName: "Version.ID" } },
    ...r.filters.map((f) => ({ SetOperand: { Elements: f.members.map((x) => ({ Comparison: "=", Low: x.id })), FieldName: `${f.dimension}.ID` } })),
    ...(r.months ? [{ SetOperand: { Elements: [{ Comparison: "BETWEEN", Low: r.months[0], High: r.months[1] }], FieldName: `${r.model.timeDimension}.CALMONTH` } }] : []),
  ];
  return {
    Dimensions: [{ Axis: "Columns", Name: "CustomDimension1", Members: [{ MemberName: r.measure, Visibility: "Visible" }] }],
    DynamicFilter: { Selection: { Operator: { Code: "And", SubSelections: sel } } },
    Hints: tpl().Hints,
    ResultSetFeatureRequest: tpl().ResultSetFeatureRequest,
  };
}

const describe = (r: Resolved) => ({
  model: r.model.name,
  version: r.version.description || r.version.id,
  measure: r.measure,
  members: Object.fromEntries(r.filters.map((f) => [f.dimension, f.members.map((x) => x.description || x.id)])),
  ...(r.months ? { months: `${r.months[0]}–${r.months[1]}` } : {}),
});

/** Current value of one (aggregated) cell. */
export async function readPlanCell(cell: PlanCell): Promise<{ value: number; cell: Json }> {
  const r = await resolveCell(cell);
  const grid = await ina(r.model, cellQuery(r));
  return { value: cellValues(grid)[0] ?? 0, cell: describe(r) };
}

const versionsPath = (cubeId: string) => `/sap/fpa/services/rest/v1/internal/models/${cubeId}`;

/** Public versions are planned in an edit copy (what the table does on the first entry). */
async function ensureEditMode(m: PlanningModel, versionId: string): Promise<boolean> {
  if (!versionId.startsWith("public.")) return false;
  const list = await browser.request("GET", `${versionsPath(m.cubeId)}/versions?inputScheduleVersions=true`);
  const v = ((list.body as Json)?.versions ?? []).find((x: Json) => x.id === versionId);
  if (v?.isInPublicEditMode) return false;
  const res = await browser.request("POST", `${versionsPath(m.cubeId)}/version-actions/start-public-edit`, { versionId, enforceLimit: true, addDefaultPlanningArea: true });
  if (res.status >= 400) throw new Error(`Could not start editing ${versionId} (${res.status}): ${JSON.stringify(res.body).slice(0, 500)}`);
  return true;
}

export interface PlanWriteResult {
  cell: Json;
  before: number;
  target: number;
  after: number;
  startedEditMode: boolean;
  dryRun: boolean;
}

/**
 * Set one (aggregated) cell: absolute value, percentage change or delta. SAC distributes the change to the booked
 * leaves proportionally (or evenly where nothing is booked). Unpublished until published.
 */
export async function writePlanCell(cell: PlanCell, change: { value?: number; percent?: number; delta?: number }, dryRun = false): Promise<PlanWriteResult> {
  const given = ["value", "percent", "delta"].filter((k) => (change as Json)[k] !== undefined);
  if (given.length !== 1) throw new Error("Pass exactly one of value, percent, delta");
  const r = await resolveCell(cell);
  const before = cellValues(await ina(r.model, cellQuery(r)))[0] ?? 0;
  const target = change.value ?? (change.percent !== undefined ? before * (1 + change.percent / 100) : before + (change.delta ?? 0));
  const rounded = Math.round(target * 1e6) / 1e6;
  if (dryRun) return { cell: describe(r), before, target: rounded, after: before, startedEditMode: false, dryRun: true };
  const startedEditMode = await ensureEditMode(r.model, r.version.id);
  const t = tpl();
  const def = cellQuery(r);
  def.NewValues = [{ ...t.NewValueTemplate, Coordinates: [0, 0], NewValueAsString: String(rounded) }];
  def.PlanningExtensions = { ...t.PlanningExtensions, RefreshVersionStates: [r.version.id] };
  const grid = await ina(r.model, def);
  const after = cellValues(grid)[0] ?? cellValues(await ina(r.model, cellQuery(r)))[0] ?? 0;
  return { cell: describe(r), before, target: rounded, after, startedEditMode, dryRun: false };
}

/** Publish the edit copy of a public version (recorded: Publish Data → version-actions/save-public-edit). */
export async function publishVersion(model: string, version: string): Promise<Json> {
  const m = await planningModel(model);
  const v = await resolveVersion(m, version);
  const res = await browser.request("POST", `${versionsPath(m.cubeId)}/version-actions/save-public-edit`, {
    versionId: v.id,
    filterOutReadOnlyFacts: false,
    conflictResolution: "PRIVATE_WINS",
    runInJob: "AUTO",
  });
  if (res.status >= 400) throw new Error(`Publish failed (${res.status}): ${JSON.stringify(res.body).slice(0, 600)}`);
  return { model: m.name, version: v.description || v.id, published: true, inEditMode: (res.body as Json)?.isInPublicEditMode ?? false };
}

/** Discard unpublished changes of a public version (recorded: Revert Data → version-actions/discard-public-edit). */
export async function revertVersion(model: string, version: string): Promise<Json> {
  const m = await planningModel(model);
  const v = await resolveVersion(m, version);
  const res = await browser.request("POST", `${versionsPath(m.cubeId)}/version-actions/discard-public-edit`, { versionId: v.id });
  if (res.status >= 400) throw new Error(`Revert failed (${res.status}): ${JSON.stringify(res.body).slice(0, 600)}`);
  return { model: m.name, version: v.description || v.id, reverted: true };
}

async function resolveVersion(m: PlanningModel, version: string): Promise<{ id: string; description: string }> {
  const versionDim = m.dimensions.find((d) => d.type === "VersionDim")?.name ?? "Version";
  const versions = await dimensionMembers(m, versionDim);
  const v = versions.find((x) => norm(x.id) === norm(version) || norm(x.description) === norm(version) || norm(x.id) === `public.${norm(version)}`);
  if (!v) throw new Error(`Version '${version}' not found. Available: ${versions.map((x) => x.description || x.id).join(", ")}`);
  return v;
}
