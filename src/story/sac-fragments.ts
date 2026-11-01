/**
 * Widget fragments recorded on a Datasphere live model, rewritten for an SAC planning model (native or Seamless).
 *
 * Datasphere and SAC models differ in a story only in how the data source is named (compared on a Seamless story
 * recorded in the UI):
 *   dataset id   view:[_SYS_BIC][t.<pkg>.<cube>][<cube>]   → planning:[<SchemaName>][][<ObjectName>]
 *   DataSource   ObjectName <model>, SchemaName <space>, System <connection>, Type InAModel
 *                → the model's own DataSource (ObjectName /t.<pkg>.<cube>/<cube>_qs, SchemaName, System), Type Planning
 * Two more differences (compared with a planning table recorded on a native SAC model):
 *   - the query's Free axis lists every other dimension of the model — the recorded Datasphere list is replaced
 *   - text attributes are <Dim>.Description, not <key>∞T
 * The rewritten fragment carries the SAC values as its tokens, so insertFragment's model swap leaves them alone.
 */

import { substitute, type Fragment, type ModelRef } from "./fragments.js";
import type { ModelDimension } from "./metadata.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface SacDataSource {
  ObjectName: string;
  SchemaName: string;
  System?: string;
  Description?: string;
}

/** Dataset id of an SAC model in a story (same as bindPlanningDataSource). */
export const sacDatasetIdOf = (ds: SacDataSource): string => `planning:[${ds.SchemaName}][][${ds.ObjectName}]`;

/** Model reference for insertFragment: the SAC values, so nothing is swapped a second time. */
export function sacModelRef(cubeId: string, ds: SacDataSource): ModelRef {
  return { cubeId, model: ds.ObjectName, space: ds.SchemaName, connection: ds.System ?? "" };
}

/** Replace the Free axis dimension list of every query in a (stringified) fragment. */
export function withFreeAxis(text: string, free: string[]): string {
  return text.replace(/((\\*)"Axis\2":\2"Free\2",\2"OrderedDimensionNames\2":\[)([^\]]*)(\])/g, (_m, head, bs, _list, tail) =>
    head + free.map((n) => `${bs}"${n}${bs}"`).join(",") + tail,
  );
}

export function toSacFragment(
  frag: Fragment,
  cubeId: string,
  ds: SacDataSource,
  description: string,
  target: { dimensions: ModelDimension[]; allDimensionNames: string[] },
): Fragment {
  const t = frag.tokens.model;
  let text = JSON.stringify(frag);
  // Free axis: all model dimensions the widget does not show (as createTableStory does for Datasphere)
  const shown = new Set(target.dimensions.map((d) => d.name));
  const free = target.allDimensionNames.filter((n) => !shown.has(n) && n !== "CustomDimension1" && n !== "$$Cells$$");
  text = withFreeAxis(text, free);
  // text attribute: <recorded key>∞T → the target's text attribute (before insertFragment swaps the key)
  frag.tokens.dimensions.forEach((d, i) => {
    const to = target.dimensions[i];
    if (to?.text) text = text.split(`${d.key}\u221eT`).join(to.text);
  });
  // whole dataset ids first (they contain the cube id), any package prefix; a placeholder keeps the swaps below
  // from touching the new id (its schema contains the recorded space name)
  const DS = "\u0000DATASET\u0000";
  text = text.replace(new RegExp(`view:\\[_SYS_BIC\\]\\[[^\\]]*\\.${t.cubeId}\\]\\[${t.cubeId}\\]`, "g"), DS);
  // DataSource objects, plain and JSON-in-JSON escaped: Type InAModel → Planning, System only where present
  text = text.replace(/(\\*")Type\1:\1InAModel\1/g, (_m, q) => `${q}Type${q}:${q}Planning${q}`);
  const pairs: [string, string][] = [
    [`"Description":"${t.model}"`, `"Description":${JSON.stringify(description)}`],
    // texts shown to the user (table title, model description) get the model's description, not its object path
    ...["title", "titleDom", "text", "shortDescription", "description"].map((k): [string, string] => [`"${k}":"${t.model}"`, `"${k}":${JSON.stringify(description)}`]),
    [t.model, ds.ObjectName],
    [t.space, ds.SchemaName],
    [t.connection, ds.System ?? ""],
    [t.cubeId, cubeId],
  ];
  const out = JSON.parse(substitute(text, pairs).split(DS).join(sacDatasetIdOf(ds))) as Fragment;
  out.tokens.model = sacModelRef(cubeId, ds);
  return out;
}

export interface VizFilter {
  dimension: string;
  members?: string[];
  hierarchy?: string;
  dynamic?: { granularity: "year" | "quarter" | "month" | "day"; last?: number; next?: number };
}

/** Planning models refuse queries that aggregate over versions: Version Actual unless a Version filter is given. */
export const withVersion = (filters: VizFilter[] = []): VizFilter[] =>
  filters.some((f) => f.dimension === "Version") ? filters : [...filters, { dimension: "Version", members: ["public.Actual"] }];

/**
 * Planning models refuse queries that aggregate over versions ("'Version' is not in drill and is not filtered").
 * Tables get the filter the way a planning table recorded on an SAC model stores it: an IC_MEMBER element in the
 * table's data region plus the Version.ID selection in its query.
 */
export function addTableVersionFilter(content: Json, widgetId: string, datasetId: string, version = "public.Actual"): void {
  const ent = `[{"datasetId":"${datasetId}"}]`;
  const entity = findTableEntity(content, widgetId);
  const region = entity?.data?.content?.segments?.find((x: Json) => x?.dataRegion)?.dataRegion;
  if (!region) throw new Error("table data region not found");
  const caption = version.replace(/^public\./, "");
  region.filterICElements = [
    ...(region.filterICElements ?? []).filter((f: Json) => !String(f?.extendedSelection?.targetEntity?.dimensionEntityId ?? "").includes('"Version"')),
    {
      display: { titleHidden: false, subtitleHidden: false, warningErrorIconHidden: false, wordWrapEnabled: false, selectAllOptionHidden: false, showApplySelectionsButton: true, hideShowInactiveButton: false },
      icProps: { isViewerAllowedToDeleteIC: false, isViewerAllowedToChangeSelection: false },
      extendedSelection: {
        isCascadedOut: false,
        isDisplayAsExclude: false,
        measureContext: [],
        targetEntity: { datasetEntityId: ent, dimensionEntityId: JSON.stringify([{ datasetId }, { dimensionId: "Version" }]) },
        isAllowReset: true,
      },
      title: {},
      lovInfo: { displayAs: "1", isBookedDataOnly: true, selectionType: "multiple", staticMembers: [{ key: version, caption, displayId: "(Missing)" }] },
      sortInfo: { sortType: "no_sort" },
      schemaType: "IC_MEMBER",
      icElementStringId: crypto.randomUUID(),
      userSelection: { isAllSelected: false, selections: [[version, { selected: true, caption, children: [], depth: 0 }]] },
    },
  ];
  const story = content.entities.find((e: Json) => e?.type === "story").data;
  for (const q of story.persistedUqmQuery ?? []) {
    if (!String(q?.id).includes(widgetId)) continue;
    const def = q.inaQuery?.Analytics?.Definition;
    const sel = def?.DynamicFilter?.Selection;
    if (!sel) continue;
    const version_ = { SetOperand: { Elements: [{ Comparison: "=", Low: version }], FieldName: "Version.ID" } };
    def.DynamicFilter.Selection = sel.Operator?.Code === "And"
      ? { Operator: { ...sel.Operator, SubSelections: [version_, ...sel.Operator.SubSelections.filter((x: Json) => x?.SetOperand?.FieldName !== "Version.ID")] } }
      : { Operator: { Code: "And", SubSelections: [version_, sel] } };
  }
}

/** Title shown above a table (the recorded table shows the model name). */
export function setTableTitle(content: Json, widgetId: string, title: string): void {
  const region = findTableEntity(content, widgetId)?.data?.content?.segments?.find((x: Json) => x?.dataRegion)?.dataRegion;
  if (!region) return;
  region.title = title;
  region.titleChunks = [{ type: "string", text: title }];
  region.titleDom = title;
}

function findTableEntity(content: Json, widgetId: string): Json {
  const story = content.entities.find((e: Json) => e?.type === "story").data;
  for (const p of story.pages) {
    const w = p?.content?.widgets?.find((x: Json) => x?.id === widgetId);
    if (w) return content.entities.find((e: Json) => e?.id === w.definition?.entityId);
  }
  return undefined;
}

/** Content of the dataset entity + alias for an SAC model (see planning.ts bindPlanningDataSource). */
export function hasDataset(content: Json, id: string): boolean {
  return content.entities.some((e: Json) => e?.type === "dataset" && e.id === id);
}
