/**
 * Measure-vs-measure variance on an axis chart (Builder → Chart Add-Ons → Variance), recorded from the UI.
 * The variance is a calculated member of the measure dimension (CustomDimension1) inside the widget's own query
 * (vizDefinition.ffQuery) plus a declarative vizDefinition.variances entry.
 * Compare A (reference, usually the plotted measure) to B (base): variance = A − B.
 */

import { randomUUID } from "node:crypto";
import { findRegistryWidget } from "./format.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** A measure operand: a model measure or a story calculation (ref = entity id, member = member name in the query). */
export interface MeasureOperand {
  ref: string;
  member: string;
  caption: string;
}

export const modelMeasure = (datasetId: string, m: string): MeasureOperand => ({
  ref: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { measureId: m }]),
  member: m,
  caption: m,
});

export const calculation = (id: string, name: string): MeasureOperand => ({
  ref: JSON.stringify([{ calculationId: id }]),
  member: id,
  caption: name,
});

export function addMeasureVariance(content: Json, widgetName: string, a: MeasureOperand, b: MeasureOperand) {
  const viz = findRegistryWidget(content, widgetName).definition?.vizDefinition;
  if (!viz?.ffQuery) throw new Error(`'${widgetName}' is not a chart widget`);
  const calcId = randomUUID();
  const varId = randomUUID();

  viz.variances = [
    ...(viz.variances ?? []),
    {
      id: varId,
      calculations: [
        {
          id: JSON.stringify([{ calculationId: calcId }]),
          varianceId: varId,
          base: { measureId: b.ref },
          reference: { measureId: a.ref },
          nullHandling: "null",
          calculationType: "absolute",
          isAbsBasePercentage: false,
        },
      ],
      calculationType: ["absolute"],
      base: { isAllMeasure: false, measureId: b.ref, measureCaption: b.caption },
      reference: { isAllMeasure: false, measureId: a.ref, measureCaption: a.caption },
      invertColors: false,
      colorVarianceByAccType: true,
      disableVarianceChartScaling: false,
      nullHandling: "null",
      axisLabel: "",
      viewType: "classic",
      signType: "Default",
      percentagePointUnit: "",
      dateModified: Date.now(),
    },
  ];
  (viz.properties ??= {}).dataLabelVariance ??= { visible: false };

  const used = ((viz.initialUQMExternalState ??= {}).usedMeasures ??= []);
  if (!used.includes(b.ref)) used.push(b.ref);

  const measureDim = viz.ffQuery.DimensionsRepo?.Elements?.find((e: Json) => e.Name === "CustomDimension1");
  if (!measureDim) throw new Error("Measure dimension not found in the widget query");
  (measureDim.MembersRepo ??= []).push({
    AutoSignFlip: true,
    BaseMeasureName: b.member,
    CType: "Variance",
    CalculationType: "absolute",
    ComponentTags: [{ KEY: "nonShareableCalcType", VALUE: "variance" }],
    Description: calcId,
    ExceptionsRepo: { CType: "Exceptions", ComponentTags: [{ KEY: "nonShareableCalcType", VALUE: "variance" }] },
    FlattenBaseFilter: true,
    FlattenReferenceFilter: true,
    MemberType: "VarianceMeasure",
    Name: calcId,
    NullHandling: "nullAsNullReferenceMinusBase",
    NumericScale: 7,
    ReferenceMeasureName: a.member,
    ShowMixedUnitCurrency: false,
    Visibility: "Visible",
  });
  (measureDim.OrderedStructureMemberNames ??= []).push(calcId);

  // the measure filter of the chart selects the plotted measures; the variance member must be selected too
  const measureFilter = (viz.ffQuery.FilterRepo?.DynamicFilter?.FilterRoot?.SubSelections ?? []).find(
    (s: Json) => s.FieldName === "[Measures].[Measures]",
  );
  if (!measureFilter) throw new Error("Measure filter not found in the widget query");
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
  return { varianceId: varId, calculationId: calcId };
}
