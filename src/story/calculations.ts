/**
 * Story calculations (Calculation Editor) and their use in charts.
 * Recorded from the UI: a restricted measure is an entry in the story's calculation entity; charts reference it by
 * [{"calculationId": id}] in bindings/usedMeasures and as a MemberRestricted member of the measure dimension.
 */

import { randomUUID } from "node:crypto";
import { findRegistryWidget } from "./format.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const calcRef = (id: string) => JSON.stringify([{ calculationId: id }]);
export const measureRef = (datasetId: string, m: string) =>
  JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { measureId: m }]);

function calcEntity(content: Json): Json {
  const e = content.entities.find((x: Json) => x.type === "calculation");
  if (!e) throw new Error("Story has no calculation entity");
  return (e.entities ??= []) && e;
}

/** Restricted measure: `measure` filtered to members of `dimension` whose key begins with `beginsWith` (e.g. a year). */
export function addRestrictedMeasure(
  content: Json,
  datasetId: string,
  opts: { name: string; measure: string; dimension: string; beginsWith: string; modelName?: string },
): string {
  const id = randomUUID();
  // the story editor names the dataset alias after the model and refers to it from calculations
  const aliasEntity = content.entities.find((e: Json) => e.type === "datasetAlias" && e.datasetId === datasetId);
  if (aliasEntity && opts.modelName) aliasEntity.alias = JSON.stringify(opts.modelName);
  const datasetAlias = aliasEntity?.alias;
  const ds = { id: datasetId, type: "dataset" };
  const dsEntity = JSON.stringify([{ datasetId }]);
  const now = Date.now();
  const measureKey = { id: opts.measure, type: "member", parentKey: { id: "CustomDimension1", type: "dimension", parentKey: ds } };
  calcEntity(content).entities.push({
    id: { id, type: "restrictedMeasure", parentKey: { type: "datasets", ids: [ds] } },
    dateCreated: now,
    dateModified: now,
    isDeleted: false,
    isHiddenCalculation: false,
    name: opts.name,
    description: null,
    format: {
      options: { maximumFractionDigits: 2, minimumFractionDigits: 2 },
      scale: { multiplier: "1", prefix: "", suffix: "", symbolSuffix: "", symbolPrefix: "", toUse: "", spaceSeparated: false },
      unit: { symbol: "", prefix: "", suffix: "", toUse: "", symbolSuffix: "", symbolPrefix: "", spaceSeparated: false },
      plusSign: { symbol: "", isPrefix: true },
      minusSign: { symbol: "-", isPrefix: true },
      showSignAs: "Default",
    },
    version: "1.6",
    isDynamicDescription: false,
    shouldSuppressTranslation: false,
    measureId: measureKey,
    selections: [
      {
        entityId: [{ id: opts.dimension, type: "dimension", parentKey: ds }],
        exclude: false,
        answers: [{ function: "BEGINS_WITH", arguments: [[opts.beginsWith], [""]], exclude: false }],
        originalValues: [
          { type: "range_filter", func: "BEGINS_WITH", displayName: `Begins with "${opts.beginsWith}"`, start: opts.beginsWith, end: "", isExclude: false },
        ],
        bookedDataOnly: true,
        isMemberRange: true,
        staleMemberInfo: {},
        targetAttribute: "ID+DESC",
        attributeId: [opts.dimension],
        type: "Calculation_Selections",
        filterId: randomUUID(),
      },
    ],
    ignoreChartContext: false,
    ignoreAllSelectionContext: false,
    externalDimensionsToIgnore: null,
    selectedExternalDimensionsToIgnore: null,
    _calculationVariableIdMap: {
      [JSON.stringify(measureKey)]: { keyName: opts.measure, caption: opts.measure, entityType: "member", datasetId, ...(datasetAlias ? { datasetAlias } : {}) },
    },
    isInheritFormat: false,
    uqmIsInheritUnit: true,
    qmfSelections: [
      {
        selectionSchema: "COMPLEX",
        datasetEntityId: dsEntity,
        complexFilterTree: {
          exclude: false,
          func: "AND",
          selectionSchema: "COMPLEX",
          filterNodeChildren: [
            {
              exclude: false,
              func: "OR",
              selectionSchema: "COMPLEX",
              filterNodeChildren: [
                {
                  selectionSchema: "MEMBER_RANGE",
                  operator: "LIKE",
                  memberKeys: [`${opts.beginsWith}*`],
                  targetedEntity: {
                    datasetEntityId: dsEntity,
                    entityId: JSON.stringify([{ datasetId }, { dimensionId: opts.dimension }, { attributeId: opts.dimension }]),
                  },
                  setSign: "INCLUDING",
                },
              ],
            },
          ],
        },
      },
    ],
    uqmVersion: "1.1",
    validationErrors: [],
  });
  // calculations are only evaluated when listed in the story's load order
  const story = content.entities.find((e: Json) => e.type === "story");
  const order = ((story.calculationsLoadOrder ??= { calculationsLoadOrder: [], uqmVersion: "1.0" }).calculationsLoadOrder ??= []);
  if (!order.includes(id)) order.push(id);
  return id;
}

function vizOf(content: Json, widgetName: string) {
  const viz = findRegistryWidget(content, widgetName).definition?.vizDefinition;
  if (!viz?.ffQuery) throw new Error(`'${widgetName}' is not a chart widget`);
  const measureDim = viz.ffQuery.DimensionsRepo?.Elements?.find((e: Json) => e.Name === "CustomDimension1");
  const measureFilter = (viz.ffQuery.FilterRepo?.DynamicFilter?.FilterRoot?.SubSelections ?? []).find(
    (s: Json) => s.FieldName === "[Measures].[Measures]",
  );
  if (!measureDim || !measureFilter) throw new Error(`Unexpected query structure in '${widgetName}'`);
  return { viz, measureDim, measureFilter };
}

/** Plot a calculation (e.g. a restricted measure) on a chart's value axis. */
export function addCalcToViz(content: Json, widgetName: string, calcId: string) {
  const { viz, measureDim, measureFilter } = vizOf(content, widgetName);
  const ref = calcRef(calcId);
  const value = viz.bindings.find((b: Json) => b.feed === "valueAxis");
  if (!value.source.includes(ref)) value.source.push(ref);
  const used = ((viz.initialUQMExternalState ??= {}).usedMeasures ??= []);
  if (!used.includes(ref)) used.push(ref);
  measureDim.MembersRepo.push({ CType: "MemberRestricted", KeyRef: { GroupName: "primaryStructure", ObjectName: calcId } });
  measureDim.OrderedStructureMemberNames.push(calcId);
  (measureDim.NumericScaleOverride ??= {})[calcId] = 7;
  (measureDim.VisibilityOverride ??= {})[calcId] = "Visible";
  measureFilter.Elements.push({
    CType: "FilterOperation",
    Comparison: "=",
    Exactness: 0,
    FieldName: "[Measures].[Measures]",
    HasDepth: false,
    HasLevelOffset: false,
    Id: randomUUID(),
    IsExcluding: false,
    Values: [{ Value: calcId, ValueType: "String" }],
  });
}

/** Remove a model measure from a chart's value axis (bindings, used measures, measure filter). */
export function removeMeasureFromViz(content: Json, widgetName: string, datasetId: string, measure: string) {
  const { viz, measureFilter } = vizOf(content, widgetName);
  const ref = measureRef(datasetId, measure);
  for (const b of viz.bindings) if (Array.isArray(b.source)) b.source = b.source.filter((s: Json) => s !== ref);
  if (viz.initialUQMExternalState?.usedMeasures)
    viz.initialUQMExternalState.usedMeasures = viz.initialUQMExternalState.usedMeasures.filter((s: string) => s !== ref);
  measureFilter.Elements = measureFilter.Elements.filter((e: Json) => !e.Values?.some((v: Json) => v.Value === measure));
}

/** The recorded query of a widget no longer matches after structural changes; let SAC rebuild it at runtime. */
export function dropPreExecute(content: Json, widgetName: string) {
  const reg = findRegistryWidget(content, widgetName);
  const story = content.entities.find((e: Json) => e.type === "story").data;
  story.preExecuteUqmQueryIds = (story.preExecuteUqmQueryIds ?? []).filter((q: string) => !q.includes(reg.id));
}
