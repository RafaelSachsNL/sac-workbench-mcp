/**
 * Story-defined thresholds (More → Conditional Formatting): story.data.thresholds.story[datasetId][measure][id].
 * Tables and charts showing the measure pick them up automatically.
 */

import { randomUUID } from "node:crypto";
import { storyEntity } from "./content.js";
import { findRegistryWidget } from "./format.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type Semantic = "ok" | "warning" | "critical";

const SEMANTICS: Record<Semantic, { icon: string; color: string }> = {
  ok: { icon: "sap-icon://fpa/threshold-good", color: "#00bb2d" },
  warning: { icon: "sap-icon://fpa/threshold-warning", color: "#E76500" },
  critical: { icon: "sap-icon://fpa/threshold-alert", color: "#D00A0A" },
};

export interface ThresholdRange {
  name: string;
  semantic: Semantic;
  /** inclusive lower bound; omit for -∞ */
  low?: number;
  /** exclusive upper bound; omit for +∞ */
  high?: number;
  color?: string;
}

export function addThreshold(content: Json, datasetId: string, measure: string, ranges: ThresholdRange[], title = "Threshold"): string {
  const id = randomUUID();
  const threshold = {
    id,
    modelId: datasetId,
    accountId: measure,
    accountEntityId: {
      id: measure,
      type: "member",
      parentKey: { id: "CustomDimension1", type: "dimension", parentKey: { id: datasetId, type: "dataset" } },
    },
    type: "1",
    intervals: ranges.map((r) => ({
      low: r.low ?? null,
      high: r.high ?? null,
      lowInclusive: true,
      highInclusive: false,
      colorSwatchId: "",
      icon: SEMANTICS[r.semantic].icon,
      color: r.color ?? SEMANTICS[r.semantic].color,
      name: r.name,
      id: randomUUID(),
      semanticType: r.semantic,
    })),
    enabled: true,
    editable: true,
    dimension: "CustomDimension1",
    filters: [],
    customTitle: title,
    compareType: "Number Range",
    setNoDataAsZero: false,
  };
  const s = storyEntity(content).data;
  s.thresholds ??= { model: {}, story: {} };
  s.thresholds.story ??= {};
  ((s.thresholds.story[datasetId] ??= {})[measure] ??= {})[id] = threshold;
  return id;
}

function findThreshold(content: Json, thresholdId: string) {
  const story = storyEntity(content).data.thresholds?.story ?? {};
  for (const [ds, byMeasure] of Object.entries<Json>(story))
    for (const [measure, byId] of Object.entries<Json>(byMeasure))
      if (byId[thresholdId])
        return {
          t: byId[thresholdId],
          dsE: JSON.stringify([{ datasetId: ds }]),
          mE: JSON.stringify([{ datasetId: ds }, { dimensionId: "CustomDimension1" }, { measureId: measure }]),
        };
  throw new Error(`Threshold ${thresholdId} not found`);
}

/** Show a story threshold on a chart/KPI widget (Builder → Color → Add Threshold). */
export function attachThresholdToViz(content: Json, widgetName: string, thresholdId: string) {
  const { t, dsE, mE } = findThreshold(content, thresholdId);

  const viz = findRegistryWidget(content, widgetName).definition?.vizDefinition;
  if (!viz) throw new Error(`'${widgetName}' is not a chart/KPI widget`);
  const fem = ((viz.ffQuery ??= {}).FormulaExceptionManager ??= { CType: "FormulaExceptionManager", FormulaExceptions: [] });
  fem.FormulaExceptions = (fem.FormulaExceptions ?? []).filter((e: Json) => e?.KeyRef?.ObjectName !== thresholdId);
  fem.FormulaExceptions.push({ CType: "FormulaException", KeyRef: { GroupName: "formulaException", ObjectName: thresholdId } });
  fem.FormulaResultVisible = true;
  ((viz.userPreferences ??= {}).threshold ??= {})[dsE] = { [mE]: { selectedDimensions: [], thresholdSource: "story" } };
  viz.threshold = { colorBinding: { ...t, modelId: dsE, accountId: mE, accountEntityId: mE } };
}

/** Show a story threshold in a table (Builder → Table Add-Ons → Threshold); display via Styling → Threshold Style. */
export function attachThresholdToTable(content: Json, widgetName: string, thresholdId: string) {
  const reg = findRegistryWidget(content, widgetName);
  const entity = content.entities.find((e: Json) => e.id === reg.definition?.entityId);
  if (entity?.type !== "analyticgrid.table") throw new Error(`'${widgetName}' is not a table`);
  const { dsE, mE } = findThreshold(content, thresholdId);
  const tdef = (reg.definition.tableDefinition ??= {});
  ((tdef.userPreferences ??= {}).threshold ??= {})[dsE] = {
    ...(tdef.userPreferences.threshold[dsE] ?? {}),
    [mE]: { selectedDimensions: [], thresholdSource: "story", isCrossCalcThreshold: false },
  };
  let done = false;
  for (const seg of entity.data?.content?.segments ?? []) {
    const dr = seg.dataRegion;
    if (!dr?.ffQuery) continue;
    const ff = typeof dr.ffQuery === "string" ? JSON.parse(dr.ffQuery) : dr.ffQuery;
    const fem = (ff.FormulaExceptionManager ??= { ActiveStatusModelExceptions: [], CType: "FormulaExceptions", FormulaExceptions: [] });
    fem.FormulaExceptions = (fem.FormulaExceptions ?? []).filter((e: Json) => e?.KeyRef?.ObjectName !== thresholdId);
    fem.FormulaExceptions.push({ CType: "FormulaException", KeyRef: { GroupName: "formulaException", ObjectName: thresholdId } });
    dr.ffQuery = typeof dr.ffQuery === "string" ? JSON.stringify(ff) : ff;
    done = true;
  }
  if (!done) throw new Error(`No query found in table '${widgetName}'`);
}

/** Charts/KPIs and tables keep the threshold link in different places. */
export function attachThreshold(content: Json, widgetName: string, thresholdId: string) {
  const reg = findRegistryWidget(content, widgetName);
  if (reg.definition?.vizDefinition) attachThresholdToViz(content, widgetName, thresholdId);
  else attachThresholdToTable(content, widgetName, thresholdId);
}
