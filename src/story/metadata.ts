/**
 * Live metadata of Datasphere analytic models via InA through SAC's live-connection tunnel,
 * and resolution of user input (captions or technical names) to InA names.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "../browser/session.js";
import { dirOf } from "../paths.js";

// ── Live model metadata (InA via the SAC → Datasphere tunnel) ─────────

export interface ModelDimension {
  name: string;
  caption: string;
  key: string;
  text: string;
  /** Plain fact-column dimensions have bracketed keys ("[X].[X]") and are hidden in the story builder. */
  plain: boolean;
}

export interface ModelMetadata {
  dimensions: ModelDimension[];
  measures: { name: string; caption: string }[];
  /** All InA dimension names in metadata order (needed to rebuild the query's Free axis). */
  allDimensionNames: string[];
}

const INA_TEMPLATE_FILE = resolve(dirOf(import.meta.url), "..", "..", "templates", "ina_metadata_request.json");

export async function fetchModelMetadata(connection: string, space: string, model: string): Promise<ModelMetadata> {
  return inaMetadata(
    `/lcs/dwc/tunnel/${encodeURIComponent(connection)}/sap/bc/ina/service/v2/GetResponse`,
    { ObjectName: model, SchemaName: space, Type: "InAModel" },
    `${connection}/${space}/${model}`,
  );
}

/**
 * Metadata of an SAC planning model (native or Seamless): the same InA request with the model's own DataSource
 * (Type Planning), sent to SAC itself or — Seamless — to the Datasphere system behind it (see planwrite.ts).
 */
export async function fetchSacModelMetadata(endpoint: string, dataSource: Record<string, unknown>, label: string): Promise<ModelMetadata> {
  return inaMetadata(endpoint, dataSource, label);
}

async function inaMetadata(endpoint: string, dataSource: Record<string, unknown>, label: string): Promise<ModelMetadata> {
  const req = JSON.parse(readFileSync(INA_TEMPLATE_FILE, "utf8"));
  req.Metadata.DataSource = { InstanceId: crypto.randomUUID(), ...dataSource };
  const res = await browser.request("POST", endpoint, req, "application/json;charset=UTF-8");
  const body = res.body as { Cube?: { Dimensions?: Record<string, unknown>[] }; Messages?: unknown };
  if (res.status >= 400 || !body?.Cube?.Dimensions)
    throw new Error(`InA metadata for ${label} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 1500)}`);
  const dims = body.Cube.Dimensions;
  const measuresDim = dims.find((d) => d.Name === "CustomDimension1") as { Members?: Record<string, unknown>[] } | undefined;
  return {
    allDimensionNames: dims.map((d) => String(d.Name)),
    dimensions: dims
      .filter((d) => Number(d.DimensionType) === 3)
      .map((d) => ({
        name: String(d.Name),
        caption: String(d.Description ?? ""),
        key: String(d.KeyAttribute ?? ""),
        text: String(d.TextAttribute ?? ""),
        plain: String(d.KeyAttribute ?? "").startsWith("["),
      })),
    measures: (measuresDim?.Members ?? []).map((m) => ({
      name: String(m["[Measures].[Measures]"]),
      caption: String(m["[Measures].[Description]"] ?? ""),
    })),
  };
}

/** Match by technical name first, then caption/key (case-insensitive), preferring builder-visible dimensions. */
export function resolveDimension(meta: ModelMetadata, input: string): ModelDimension {
  const exact = meta.dimensions.find((d) => d.name === input);
  if (exact) return exact;
  const lc = input.toLowerCase();
  const hits = meta.dimensions.filter((d) => [d.caption, d.key, d.name].some((v) => v.toLowerCase() === lc));
  const hit = hits.find((d) => !d.plain) ?? hits[0];
  if (!hit)
    throw new Error(
      `Dimension '${input}' not found. Available: ${meta.dimensions.filter((d) => !d.plain).map((d) => `${d.caption} (${d.name})`).join(", ")}`,
    );
  return hit;
}

/** Caption of a measure (name or caption accepted); undefined if unknown. */
export function measureCaption(meta: ModelMetadata, input: string): string | undefined {
  const lc = input.toLowerCase();
  return meta.measures.find((m) => m.name.toLowerCase() === lc || m.caption.toLowerCase() === lc)?.caption;
}

export function resolveMeasure(meta: ModelMetadata, input: string): string {
  const lc = input.toLowerCase();
  const hit = meta.measures.find((m) => m.name.toLowerCase() === lc || m.caption.toLowerCase() === lc);
  if (!hit) throw new Error(`Measure '${input}' not found. Available: ${meta.measures.map((m) => m.name).join(", ")}`);
  return hit.name;
}

