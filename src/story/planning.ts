/**
 * Planning stories on SAC models (recorded from a planning table in a test story).
 *
 * An SAC model enters a story as a dataset entity `planning:[TENANT_<id>][][/<pkg>/<cube>_qs]` (datasetType Planning,
 * systemType ORCA_MAIN) plus a dataset alias. Tables on planning models are input-ready by default; values typed in
 * view mode go to a private version until published.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { insertFragment, substitute, type Fragment, type Position } from "./fragments.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATES = resolve(dirOf(import.meta.url), "..", "..", "templates");

export interface SacModelRef {
  cubeId: string;
  /** model name as shown in SAC (dataset modelId / alias) */
  name: string;
}

export function sacDatasetId(content: Json, cubeId: string): string | undefined {
  return content.entities.find((e: Json) => e?.type === "dataset" && String(e.id).includes(`/${cubeId}_qs]`))?.id;
}

/** Add the dataset + alias of an SAC model to the story (no-op if present). */
export function bindSacModel(content: Json, model: SacModelRef): string {
  const existing = sacDatasetId(content, model.cubeId);
  if (existing) return existing;
  const tpl = JSON.parse(readFileSync(join(TEMPLATES, "sac_model_binding.json"), "utf8"));
  const entities = JSON.parse(substitute(JSON.stringify(tpl.entities), [[tpl.cubeId, model.cubeId], ["MCP_PLAN_API", model.name]])) as Json[];
  for (const e of entities) if (e.type === "datasetAlias") e.id = crypto.randomUUID();
  content.entities.push(...entities);
  return entities.find((e) => e.type === "dataset").id;
}

export function addPlanningTable(
  content: Json,
  opts: {
    container: string;
    outlineName: string;
    model: SacModelRef;
    row: { name: string; caption?: string };
    measures: [string, string];
    position?: Position;
  },
): { widgetId: string } {
  bindSacModel(content, opts.model);
  const frag = JSON.parse(readFileSync(join(TEMPLATES, "fragments", "table_planning.json"), "utf8")) as Fragment;
  // the recorded model name appears in the table (data source) — swap it like the cube id
  const renamed = JSON.parse(substitute(JSON.stringify(frag), [["MCP_PLAN_API", opts.model.name]])) as Fragment;
  renamed.tokens.model.model = opts.model.name;
  return insertFragment(content, renamed, {
    container: opts.container,
    outlineName: opts.outlineName,
    position: opts.position,
    model: { cubeId: opts.model.cubeId, model: opts.model.name, space: "\u0000none", connection: "\u0000none" },
    dimensions: [{ name: opts.row.name, key: "\u0000nokey", caption: opts.row.caption ?? opts.row.name, text: "", plain: false }],
    measures: opts.measures,
    allMeasures: opts.measures,
  });
}

/**
 * Bind any SAC planning model (native or Seamless) by its DataSource from the model definition. Seamless models
 * (recorded from a story on a Datasphere-stored model): dataset planning:[<space schema>][][<object>], systemType
 * HANA, isRemote true, no package.
 */
export function bindPlanningDataSource(content: Json, model: { name: string; dataSource: { SchemaName: string; ObjectName: string; System?: string }; analytic?: boolean }): string {
  const id = `planning:[${model.dataSource.SchemaName}][][${model.dataSource.ObjectName}]`;
  if (content.entities.some((e: Json) => e?.type === "dataset" && e.id === id)) return id;
  const seamless = Boolean(model.dataSource.System);
  const pkg = model.dataSource.ObjectName.split("/")[1] ?? "";
  content.entities.push(
    {
      id,
      type: "dataset",
      data: seamless
        ? { id, modelId: model.name, packageName: "", systemType: "HANA", isRemote: true }
        : { id, isPrivate: false, isRemote: false, packageName: pkg, datasetType: model.analytic ? "Analytic" : "Planning", modelId: model.name, systemType: "ORCA_MAIN" },
      ...(seamless ? {} : { bSuppressPromptDialog: false }),
    },
    { datasetId: id, alias: JSON.stringify(model.name), type: "datasetAlias", id: crypto.randomUUID() },
  );
  return id;
}
