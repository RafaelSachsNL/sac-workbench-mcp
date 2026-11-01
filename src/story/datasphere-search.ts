/**
 * Datasphere repository search through SAC (GitLab issue #1). SAC's dwcDataRepository/searchLcs passes OData
 * parameters on to Datasphere /repository/search/$all over the live connection, so a model name resolves to its space
 * without a Datasphere login. The response carries a Datasphere JWT in `token` — it is dropped here and never
 * returned or logged.
 */

import { browser } from "../browser/session.js";
import { config } from "../config.js";
import { listModels } from "./models.js";
import { fetchModelMetadata } from "./metadata.js";

export interface DatasphereObject {
  name: string;
  businessName: string;
  space: string;
  kind: string;
  connection: string;
}

/** Datasphere connections the tenant has used (model references) plus the configured default. */
export async function datasphereConnections(): Promise<string[]> {
  const used = (await listModels()).filter((m) => m.kind === "datasphere" && m.connection).map((m) => m.connection!);
  return [...new Set([config.defaults.connection, ...used].filter((c): c is string => !!c))];
}

export async function searchDatasphere(opts: { query: string; connection?: string; kind?: "analyticModel" | "all"; top?: number }): Promise<DatasphereObject[]> {
  const connections = opts.connection ? [opts.connection] : await datasphereConnections();
  if (!connections.length) throw new Error("No Datasphere connection known — pass connection");
  // the search syntax treats quotes and parentheses specially
  const term = opts.query.replace(/['()]/g, " ").trim();
  const out: DatasphereObject[] = [];
  const errors: string[] = [];
  for (const connection of connections) {
    const params = [
      `connection=${encodeURIComponent(connection)}`,
      `tenant=${encodeURIComponent(browser.tenantId ?? "")}`,
      `$top=${opts.top ?? 20}`,
      `$select=${encodeURIComponent("space_name,business_name,name,id,kind")}`,
      `$apply=${encodeURIComponent(`filter(Search.search(query='SCOPE:SEARCH_DESIGN ${term}'))`)}`,
    ].join("&");
    const res = await browser.request("GET", `/sap/fpa/services/rest/fpa/dwcDataRepository/searchLcs?${params}`);
    const body = res.body as { result?: { value?: Record<string, unknown>[] }; message?: string } | undefined;
    if (res.status >= 400 || !body?.result) {
      // only status and message — the body may contain the token
      errors.push(`${connection}: ${res.status} ${String(body?.message ?? "").slice(0, 200)}`);
      continue;
    }
    for (const v of body.result.value ?? [])
      out.push({ name: String(v.name ?? ""), businessName: String(v.business_name ?? ""), space: String(v.space_name ?? ""), kind: String(v.kind ?? ""), connection });
  }
  if (!out.length && errors.length === connections.length) throw new Error(`Datasphere search failed: ${errors.join("; ")}`);
  return opts.kind === "all" ? out : out.filter((o) => !opts.kind || o.kind === "sap.dwc.analyticModel" || o.kind === "analyticModel");
}

/**
 * Space (and connection) of a model: the given one, else the Datasphere search (exact technical name), else the
 * configured default. `resolved` tells whether the search decided.
 */
export async function locateModel(model: string, connection?: string, space?: string): Promise<{ connection: string; space: string; resolved: boolean }> {
  if (space && connection) return { connection, space, resolved: false };
  const hits = (await searchDatasphere({ query: model, connection, kind: "all" }).catch(() => [])).filter((h) => h.name.toUpperCase() === model.toUpperCase());
  const spaces = [...new Set(hits.map((h) => h.space))];
  if (spaces.length > 1) throw new Error(`'${model}' exists in several spaces (${hits.map((h) => `${h.connection}/${h.space}`).join(", ")}) — pass space`);
  if (spaces.length === 1) {
    // the same model can be reachable over several connections (same tenant) → the configured one, else the first
    const c = connection ?? hits.find((h) => h.connection === config.defaults.connection)?.connection ?? hits[0].connection;
    return { connection: c, space: space ?? spaces[0], resolved: true };
  }
  const c = connection ?? config.defaults.connection;
  const s = space ?? config.defaults.space;
  if (!c || !s) throw new Error(`'${model}' not found by the Datasphere search and no default connection/space configured — pass them`);
  return { connection: c, space: s, resolved: false };
}

/** Model metadata with the space located; a wrong given space is corrected once via the search. */
export async function metadataFor(model: string, connection?: string, space?: string) {
  const loc = await locateModel(model, connection, space);
  try {
    return { ...loc, meta: await fetchModelMetadata(loc.connection, loc.space, model) };
  } catch (err) {
    if (loc.resolved) throw err;
    const hit = (await searchDatasphere({ query: model, connection: loc.connection, kind: "all" }).catch(() => [])).find(
      (h) => h.name.toUpperCase() === model.toUpperCase() && h.space !== loc.space,
    );
    if (!hit) throw err;
    return { connection: hit.connection, space: hit.space, resolved: true, meta: await fetchModelMetadata(hit.connection, hit.space, model) };
  }
}
