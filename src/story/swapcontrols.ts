/**
 * Measure and dimension input controls ("swap" controls), recorded from the chart builder:
 * Add Measure → Add Measure Input Control / Add Dimension → Add Dimension Input Control.
 *
 * Unlike member/measure filters (page filters in uqmPageFilters) they are field selections:
 *   - story entity <storyId>:fieldSelection holds one entry per control (MEASURE_SELECTION / DIMENSION_SELECTION)
 *   - registry widget UQMFieldSelectionInputControlWidget carries the same entry (fieldSelectionEntity)
 *   - entity uqmFieldSelectionInputControl (measure controls keep their member list and selection there)
 *   - measure controls only: an entry in story.uqmFieldSelectionFilters (without it the control is not shown)
 *   - every linked chart binds the axis to the selection: bindings[feed].source = [{"fieldSelectionId": …}] and
 *     usedFSCurrentSelections[fieldSelectionId] = the currently shown measure/dimension
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { appEntity, dropPersistedQueries, outlineNames, storyEntity } from "./content.js";
import { containerLayout, type Position } from "./fragments.js";
import { datasetIdOf, placeInputControl } from "./inputcontrols.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface SwapControlOptions {
  kind: "measure" | "dimension";
  container: string;
  outlineName: string;
  /** shown in the control */
  title: string;
  /** measure ids or dimension (InA) names the viewer can choose from; the first is shown initially */
  options: string[];
  /** captions for the options (measure controls), default the ids */
  captions?: string[];
  /** chart widget ids whose axis follows the control */
  charts: string[];
  position?: Position;
  hideIcon?: boolean;
}

const LOV_TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "measure_swap_lov.json");

/**
 * List-of-values query of a measure control (the measures it can offer), recorded; data source, measure structure and
 * free axis come from an existing widget query of the story (same model).
 */
function measureLovQuery(content: Json, datasetId: string): Json {
  const q = structuredClone(JSON.parse(readFileSync(LOV_TEMPLATE, "utf8")).query);
  let source: Json;
  for (const page of storyEntity(content).data.pages ?? [])
    for (const w of page?.content?.widgets ?? []) {
      const ff = w?.definition?.vizDefinition?.ffQuery;
      if (!source && ff?.DimensionsRepo?.Elements?.some((e: Json) => e.Name === "CustomDimension1")) source = ff;
    }
  if (!source) throw new Error("No chart query in the story to derive the measure list from");
  q.DataSource = structuredClone(source.DataSource);
  const struct = source.DimensionsRepo.Elements.find((e: Json) => e.Name === "CustomDimension1");
  const target = q.DimensionsRepo.Elements.find((e: Json) => e.Name === "CustomDimension1");
  target.MembersRepo = structuredClone(struct.MembersRepo ?? []);
  target.OrderedStructureMemberNames = structuredClone(struct.OrderedStructureMemberNames ?? []);
  const free = source.Query?.AxesLayout?.find((a: Json) => a.Axis === "Free");
  const qFree = q.Query.AxesLayout.find((a: Json) => a.Axis === "Free");
  if (free && qFree) qFree.OrderedDimensionNames = [...free.OrderedDimensionNames.filter((n: string) => n !== "CustomDimension1")];
  const local = datasetId;
  return JSON.parse(JSON.stringify(q).replace(/"KEY":"localId","VALUE":"[^"]*"/g, `"KEY":"localId","VALUE":${JSON.stringify(local)}`));
}

function widgetById(content: Json, id: string): Json {
  for (const page of storyEntity(content).data.pages ?? []) {
    const w = page?.content?.widgets?.find((x: Json) => x?.id === id);
    if (w) return w;
  }
  throw new Error(`No widget with id ${id}`);
}

export function addSwapControl(content: Json, opts: SwapControlOptions): { widgetId: string; fieldSelectionId: string } {
  if (!opts.options.length) throw new Error("A swap control needs at least one option");
  if ([...outlineNames(content).values()].some((n) => n.name === opts.outlineName)) throw new Error(`Name '${opts.outlineName}' is already used`);
  const { page, layout, unit } = containerLayout(content, opts.container);
  const datasetId = datasetIdOf(content);
  const ds = JSON.stringify([{ datasetId }]);
  const measure = opts.kind === "measure";
  const valueId = (o: string) =>
    measure ? JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { measureId: o }]) : JSON.stringify([{ datasetId }, { dimensionId: o }]);

  const widgetId = randomUUID();
  const entityId = measure ? widgetId : randomUUID();
  const fsId = JSON.stringify([{ fieldSelectionId: randomUUID() }]);
  const icId = randomUUID();
  const initial = valueId(opts.options[0]);
  const lov = measure ? measureLovQuery(content, datasetId) : undefined;

  const selection: Json = measure
    ? {
        source: widgetId,
        pageICStringId: widgetId,
        id: fsId,
        entityType: "MEASURE_SELECTION",
        widgetId,
        datasetId: ds,
        possibleValues: [],
        title: opts.title,
        selectionType: "single",
        originalValue: initial,
      }
    : {
        id: fsId,
        entityType: "DIMENSION_SELECTION",
        title: opts.title,
        datasetId: ds,
        allSelected: false,
        bookedDataOnly: true,
        displayAs: "1",
        possibleValues: opts.options.map(valueId),
        entityFormatInfoMap: {},
        originalValue: initial,
        source: widgetId,
        // Show/Hide → Header Icon etc. (recorded)
        titleHidden: false,
        iconHidden: opts.hideIcon ?? true,
        warningErrorIconHidden: false,
        subtitleHidden: false,
      };

  // 1. field selection collection of the story
  const storyId = storyEntity(content).id;
  let fs = content.entities.find((e: Json) => e?.type === "fieldSelection");
  if (!fs) content.entities.push((fs = { id: `${storyId}:fieldSelection`, type: "fieldSelection", entities: [], version: "1.0" }));
  fs.entities.push(structuredClone(selection));

  // 2. registry widget + layout
  page.content.widgets.push({
    id: widgetId,
    class: "sap.fpa.ui.story.entity.inputcontrol.UQMFieldSelectionInputControlWidget",
    definition: {
      datasets: measure ? [ds] : [],
      entityId,
      fieldSelectionEntity: structuredClone(selection),
      fieldSelectionEntityId: fsId,
      ...(measure
        ? {
            // the chart the control was created for (builder: Add Measure → Measure Input Control)
            widgetInfo: {
              instanceId: {
                idStr: JSON.stringify([{ app: "MAIN_APPLICATION" }, { story: "storyID" }, { viz2: opts.charts[0] }]),
                lastPair: { storeEntityType: "viz2", relativeId: opts.charts[0] },
                debugKey: JSON.stringify([{ viz2: opts.charts[0] }, { app: "MAIN_APPLICATION" }, { story: "storyID" }]),
              },
              axis: "COLUMNS",
              isAdd: true,
              bindingType: "valueAxis",
              isMigration: false,
            },
            icElementStringId: icId,
            cacheHintEnabled: true,
            LOVFFQuery: lov,
          }
        : {}),
      mode: "small",
      icUISettings: {
        title: opts.title,
        ...(measure ? {} : { wrapText: true, iconHidden: opts.hideIcon ?? true, warningErrorIconHidden: false, titleHidden: false, subtitleHidden: false }),
      },
    },
    themeClasses: [],
    dimension: { height: 40, width: 192 },
    serviceValidationHashes: {},
  });
  placeInputControl(layout, unit, widgetId, opts.position);

  // 3. control entity
  const captions = opts.captions ?? opts.options;
  content.entities.push({
    type: "uqmFieldSelectionInputControl",
    id: entityId,
    vendorId: "sap.epm.story.entity.inputcontrol.UQMFieldSelectionInputControlVendor",
    data: measure
      ? {
          icPersistedState: {
            display: {
              titleHidden: false,
              iconHidden: opts.hideIcon ?? true,
              subtitleHidden: false,
              warningErrorIconHidden: false,
              wordWrapEnabled: false,
              selectAllOptionHidden: true,
              showApplySelectionsButton: true,
              hideShowInactiveButton: false,
            },
            icProps: { isViewerAllowedToDeleteIC: false, isViewerAllowedToChangeSelection: true, isViewerAllowedToChangeICHierarchy: false },
            extendedSelection: {
              isCascadedOut: false,
              isDisplayAsExclude: false,
              measureContext: [],
              targetEntity: {
                datasetEntityId: ds,
                dimensionEntityId: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }]),
                attributeEntityId: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { attributeId: "[Measures].[Measures]" }]),
              },
              isAllowReset: true,
            },
            title: { customTitle: opts.title, fallbackTitle: "Measures" },
            lovInfo: {
              displayAs: "1",
              isBookedDataOnly: true,
              isUseDefaultReadMode: false,
              isDisableMemberSelectorCascade: false,
              selectionMode: "dynamic",
              selectionType: "single",
              staticMembers: opts.options.map((o, i) => ({ key: o, caption: captions[i] ?? o, displayId: o })),
            },
            subType: "Field_Selection",
            sortInfo: { sortType: "no_sort" },
            schemaType: "IC_MEMBER",
            icElementStringId: icId,
            userSelection: {
              isAllSelected: false,
              selections: [[opts.options[0], { selected: true, displayId: opts.options[0], caption: captions[0] ?? opts.options[0], children: [], depth: 0 }]],
            },
          },
          widgetSettings: { tokenMode: true, customFormatting: {}, unifiedSettings: {}, cacheHintEnabled: true },
          ffQueries: { subtitle: JSON.stringify(lov) },
        }
      : { widgetSettings: { tokenMode: true, customFormatting: {}, unifiedSettings: {}, cacheHintEnabled: false }, ffQueries: {} },
    datasets: [],
  });

  // 4. measure controls are also story-level field selection filters (what the viewer's selection drives)
  if (measure) {
    const members = opts.options.map((o, i) => ({ key: o, caption: captions[i] ?? o, displayId: o }));
    (storyEntity(content).data.uqmFieldSelectionFilters ??= []).push({
      display: { iconHidden: opts.hideIcon ?? true, selectAllOptionHidden: true, showApplySelectionsButton: true },
      icProps: { isViewerAllowedToDeleteIC: false, isViewerAllowedToChangeICHierarchy: false },
      extendedSelection: {
        isCascadedOut: false,
        targetEntity: {
          datasetEntityId: ds,
          dimensionEntityId: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }]),
          attributeEntityId: JSON.stringify([{ datasetId }, { dimensionId: "CustomDimension1" }, { attributeId: "[Measures].[Measures]" }]),
        },
        isAllowReset: true,
      },
      title: { customTitle: opts.title, fallbackTitle: "Measures" },
      lovInfo: { isUseDefaultReadMode: false, isDisableMemberSelectorCascade: false, selectionMode: "dynamic", selectionType: "single", staticMembers: members },
      subType: "Field_Selection",
      schemaType: "IC_MEMBER",
      icElementStringId: icId,
      selection: { isAllSelected: false, isDeselection: false, selectedValues: [members[0]] },
      userSelection: { isAllSelected: false, selections: [[members[0].key, { selected: true, displayId: members[0].key, caption: members[0].caption, children: [], depth: 0 }]] },
    });
  }

  // 5. charts follow the selection
  for (const chartId of opts.charts) {
    const viz = widgetById(content, chartId).definition?.vizDefinition;
    const bindings: Json[] = viz?.bindings ?? [];
    const binding = measure
      ? bindings.find((b) => b.source?.some((s: string) => s.includes('"measureId"')))
      : bindings.find((b) => b.feed === "categoryAxis") ?? bindings.find((b) => b.source?.some((s: string) => s.includes('"dimensionId"') && !s.includes("CustomDimension1")));
    if (!binding) throw new Error(`Chart ${chartId} has no ${measure ? "measure" : "dimension"} binding to replace`);
    binding.source = [fsId];
    (viz.usedFSCurrentSelections ??= {})[fsId] = initial;
    if (measure) Object.assign((viz.userPreferences ??= {}).measure ??= {}, { colors: [], showAs: [] });
  }

  appEntity(content).app.names[JSON.stringify([{ story: "storyID" }, { PageInputControlWidget: widgetId }])] = opts.outlineName;
  dropPersistedQueries(content);
  return { widgetId, fieldSelectionId: fsId };
}
