/**
 * Input controls, recorded from Insert → Input Control in the story editor:
 *   - member filter (Dimensions → <dim>): schemaType IC_MEMBER on the dimension's key attribute
 *   - measure filter (Measures → <measure>, "Set Range"): schemaType IC_RANGE, value ranges of a measure aggregated
 *     per context dimension (e.g. Gross_Sales between 0 and 100 Mio per state)
 *
 * An input control is three parts:
 *   - registry widget UQMInputControlWidget (definition.icElementStringId links it to its filter)
 *   - entity uqmInputControl
 *   - a page filter in page.content.uqmPageFilters — it filters every widget on the page using the same model
 * Show/Hide → Header Icon is display.iconHidden.
 */

import { randomUUID } from "node:crypto";
import { appEntity, dropPersistedQueries, outlineNames } from "./content.js";
import { containerLayout, type Position } from "./fragments.js";
import type { ModelDimension } from "./metadata.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MeasureRangeFilter {
  /** measure (technical name) */
  measure: string;
  /** dimension the measure is aggregated by before comparing (dimension context) */
  context: ModelDimension;
  /** value ranges (BETWEEN, inclusive) */
  ranges: { start: number; end: number }[];
}

export interface InputControlOptions {
  container: string;
  outlineName: string;
  /** member filter on this dimension (or pass range) */
  dimension?: ModelDimension;
  /** measure filter instead of a member filter */
  range?: MeasureRangeFilter;
  position?: Position;
  /** Minimal look: no header icon */
  hideIcon?: boolean;
  /** initially selected member keys; empty = all */
  members?: string[];
  /** title shown instead of the dimension caption (customTitle), e.g. "Fiscal Year" for FISCALYEAR */
  title?: string;
}

/** Section + layout entry for an input control widget (canvas: dynamicLayout in the container's units). */
export function placeInputControl(layout: Json, unit: string, widgetId: string, position?: Position) {
  const width = unit === "grid" ? 6 : 192;
  const height = unit === "grid" ? 2 : 40;

  const dynamicLayout = {
    left: 0,
    top: 0,
    width,
    height,
    leftUnit: unit,
    topUnit: unit,
    widthUnit: unit,
    heightUnit: unit,
    rightUnit: "auto",
    bottomUnit: "auto",
    minWidth: 32,
    minHeight: 32,
    ...(unit === "pixel" ? { minOccupiedWidth: 48, minOccupiedHeight: 32 } : {}),
    fixedHeight: false,
    fixedWidth: false,
    ...(position ?? {}),
  };
  const flow = layout.definition?.page?.definition?.layoutType === "FLOW";
  layout.definition.page.sections.push({
    sectionId: randomUUID(),
    definition: { x: 0, y: 0, width: 192, height: 40, title: "Section" },
    widgets: [
      {
        widgetId,
        definition: {
          removeable: true,
          x: 0,
          y: 0,
          height: flow && dynamicLayout.heightUnit === "pixel" ? dynamicLayout.height : 40,
          width: flow && dynamicLayout.widthUnit === "pixel" ? dynamicLayout.width : 192,
          border: {},
          dynamicLayout,
        },
      },
    ],
  });
}

export function datasetIdOf(content: Json): string {
  const datasets = content.entities.filter((e: Json) => e?.type === "dataset");
  if (datasets.length !== 1) throw new Error(`Input controls need exactly one dataset in the story (found ${datasets.length})`);
  return datasets[0].id;
}

export function addInputControl(content: Json, opts: InputControlOptions): { widgetId: string } {
  const names = appEntity(content).app.names as Record<string, string>;
  if ([...outlineNames(content).values()].some((n) => n.name === opts.outlineName)) throw new Error(`Name '${opts.outlineName}' is already used`);
  const { page, layout, unit } = containerLayout(content, opts.container);
  const datasetId = datasetIdOf(content);
  if (!opts.dimension === !opts.range) throw new Error("Pass either a dimension (member filter) or a range (measure filter)");

  const widgetId = randomUUID();
  const entityId = randomUUID();
  const filterId = randomUUID();
  page.content.widgets.push({
    id: widgetId,
    class: "sap.fpa.ui.story.entity.inputcontrol.UQMInputControlWidget",
    definition: { datasets: [datasetId], filterPopupOpen: false, entityId, icElementStringId: filterId, mode: "small", cacheHintEnabled: true },
    themeClasses: [],
    dimension: { height: 40, width: 192 },
    serviceValidationHashes: {},
  });
  placeInputControl(layout, unit, widgetId, opts.position);
  content.entities.push({
    type: "uqmInputControl",
    id: entityId,
    vendorId: "sap.epm.story.entity.inputcontrol.UQMInputControlVendor",
    data: { datasets: [], filterPopupOpen: false },
    datasets: [],
  });
  (page.content.uqmPageFilters ??= []).push(opts.range ? rangeFilter(datasetId, filterId, opts) : memberFilter(datasetId, filterId, opts));
  dropPersistedQueries(content);
  names[JSON.stringify([{ story: "storyID" }, { PageInputControlWidget: widgetId }])] = opts.outlineName;
  return { widgetId };
}

function memberFilter(datasetId: string, filterId: string, opts: InputControlOptions): Json {
  const dim = opts.dimension!;
  const members = opts.members ?? [];
  return {
    display: { iconHidden: opts.hideIcon ?? true, showApplySelectionsButton: true },
    icProps: { isViewerAllowedToDeleteIC: false, isViewerAllowedToChangeICHierarchy: false },
    extendedSelection: {
      targetEntity: {
        datasetEntityId: JSON.stringify([{ datasetId }]),
        dimensionEntityId: JSON.stringify([{ datasetId }, { dimensionId: dim.name }]),
        attributeEntityId: JSON.stringify([{ datasetId }, { dimensionId: dim.name }, { attributeId: dim.key }]),
      },
      isAllowReset: true,
    },
    title: { ...(opts.title ? { customTitle: opts.title } : {}), fallbackTitle: dim.caption },
    lovInfo: { isUseDefaultReadMode: false, isDisableMemberSelectorCascade: false, selectionMode: "dynamic" },
    schemaType: "IC_MEMBER",
    icElementStringId: filterId,
    selection: { isAllSelected: members.length === 0, isDeselection: false, selectedValues: members },
    userSelection: { isAllSelected: members.length === 0, selections: members },
  };
}

function rangeFilter(datasetId: string, filterId: string, opts: InputControlOptions): Json {
  const r = opts.range!;
  const ds = JSON.stringify([{ datasetId }]);
  return {
    display: { iconHidden: opts.hideIcon ?? true },
    icProps: { isViewerAllowedToDeleteIC: false },
    extendedSelection: { isAllowReset: true },
    title: { fallbackTitle: r.context.caption, placeholderCaptions: { dimensions: r.context.caption, measure: r.measure } },
    icElementStringId: filterId,
    schemaType: "IC_RANGE",
    dimensionEntity: { datasetEntityId: ds, entityId: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { measureId: r.measure }]) },
    lovInfo: { selectionType: "multiple" },
    subType: "Numeric",
    ranges: r.ranges.map((x) => ({
      selectionDefinition: { rangeId: randomUUID(), start: x.start, end: x.end, operator: "BETWEEN" },
      selection: { start: x.start, end: x.end },
      isSelected: true,
    })),
    aggregationDimensionEntities: [{ datasetEntityId: ds, entityId: JSON.stringify([{ datasetId }, { dimensionId: r.context.name }]) }],
  };
}

/** Show/hide the header icon of existing input controls (all of the story when no name is given). */
export function setInputControlIcon(content: Json, visible: boolean, outlineName?: string) {
  const names = outlineNames(content);
  for (const page of content.entities.find((e: Json) => e?.type === "story")?.data?.pages ?? []) {
    for (const w of page?.content?.widgets ?? []) {
      if (w?.class !== "sap.fpa.ui.story.entity.inputcontrol.UQMInputControlWidget") continue;
      if (outlineName && names.get(w.id)?.name !== outlineName) continue;
      const f = (page.content.uqmPageFilters ?? []).find((x: Json) => x?.icElementStringId === w.definition?.icElementStringId);
      if (f) (f.display ??= {}).iconHidden = !visible;
    }
  }
}
