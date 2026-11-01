/**
 * Reload the fact data of an SAC model with a derived column (previously done by hand with
 * browser fetches on /api/v1/dataexport + /api/v1/dataimport). Steps: export all facts (paged) → CSV backup →
 * derive the column from another one (mapping) → CleanAndReplace per version → re-export and compare rows and
 * totals per version. Empty (null) dimension values — e.g. rows from before a dimension was added without default
 * member — become "#".
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sacGet, sacPost } from "../auth/sac-client.js";
import { getConfig } from "../tools/_helpers.js";
import { getDesignTime } from "./model-create.js";
import { config } from "../config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
type Row = Record<string, string | number | null>;

const PAGE = 10_000;
/** one import request; larger models would need chunked jobs (CleanAndReplace must not run per chunk) */
const MAX_ROWS = 200_000;

export interface DeriveRule {
  /** new (or existing) dimension column to fill */
  column: string;
  /** source dimension column */
  from: string;
  /** source member → target member */
  map: Record<string, string>;
  /** target for source members not in map (default "#") */
  otherwise?: string;
}

async function exportFacts(cubeId: string): Promise<Row[]> {
  const cfg = getConfig();
  const rows: Row[] = [];
  for (let skip = 0; ; skip += PAGE) {
    const res = (await sacGet(cfg, `/api/v1/dataexport/providers/sac/${cubeId}/FactData?$top=${PAGE}&$skip=${skip}`)) as { value?: Row[] };
    const page = res?.value ?? [];
    rows.push(...page);
    if (page.length < PAGE) return rows;
    if (rows.length > MAX_ROWS) throw new Error(`More than ${MAX_ROWS} fact rows — too large for one import request`);
  }
}

function totals(rows: Row[], measures: string[]) {
  const out: Record<string, { rows: number } & Record<string, number>> = {};
  for (const r of rows) {
    const v = String(r.Version);
    const t = (out[v] ??= { rows: 0 } as { rows: number } & Record<string, number>);
    t.rows++;
    for (const m of measures) t[m] = Math.round(((t[m] ?? 0) + Number(r[m] ?? 0)) * 1e6) / 1e6;
  }
  return out;
}

const csv = (rows: Row[]) => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v: unknown) => (v == null ? "" : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
};

export async function reloadWithColumn(cubeId: string, rule: DeriveRule, opts: { dryRun?: boolean } = {}) {
  const { cube } = await getDesignTime(cubeId);
  const dims: string[] = cube.dimensions.map((d: Json) => d.name);
  const measures: string[] = cube.measures.map((m: Json) => m.name);
  for (const c of [rule.column, rule.from]) if (!dims.includes(c)) throw new Error(`'${c}' is not a dimension of the model (${dims.join(", ")})`);

  const before = await exportFacts(cubeId);
  const dir = join(config.captureDir, "backups");
  mkdirSync(dir, { recursive: true });
  const backup = resolve(dir, `${cubeId}_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  writeFileSync(backup, csv(before));

  const derived = before.map((r) => {
    const row: Row = { ...r };
    for (const d of dims) if (row[d] == null || row[d] === "") row[d] = "#";
    const src = String(row[rule.from]);
    row[rule.column] = rule.map[src] ?? rule.otherwise ?? "#";
    return row;
  });
  const distribution: Record<string, number> = {};
  for (const r of derived) distribution[String(r[rule.column])] = (distribution[String(r[rule.column])] ?? 0) + 1;
  const sumsBefore = totals(before, measures);
  if (opts.dryRun) return { dryRun: true, rows: before.length, backup, distribution, totals: sumsBefore };

  const versions = Object.keys(sumsBefore);
  const jobs: Json[] = [];
  for (const v of versions) {
    // CleanAndReplace scoped to Version: only this version's facts are replaced
    const data = derived.filter((r) => String(r.Version) === v);
    const res = (await sacPost(getConfig(), `/api/v1/dataimport/import/${cubeId}/factData`, {
      Data: data,
      JobSettings: { importMethod: "CleanAndReplace", dimensionScope: ["Version"], executeWithFailedRows: false },
    })) as Json;
    jobs.push({ version: v, status: res?.jobStatus, failedRows: res?.additionalInformation?.failedNumberRows, rows: data.length });
    if (res?.jobStatus !== "COMPLETED" || res?.additionalInformation?.failedNumberRows)
      return { ok: false, backup, jobs, note: `Import for ${v} did not complete — restore from the backup CSV if needed` };
  }
  const after = await exportFacts(cubeId);
  const sumsAfter = totals(after, measures);
  // totals must match; the row count may drop when the new column makes rows collapse into the same key
  const mismatch = versions.filter((v) => measures.some((m) => Math.abs((sumsBefore[v]?.[m] ?? 0) - (sumsAfter[v]?.[m] ?? 0)) > 1e-6));
  const distAfter: Record<string, number> = {};
  for (const r of after) distAfter[String(r[rule.column])] = (distAfter[String(r[rule.column])] ?? 0) + 1;
  return { ok: !mismatch.length, backup, jobs, totalsBefore: sumsBefore, totalsAfter: sumsAfter, mismatch, distribution: distAfter };
}
