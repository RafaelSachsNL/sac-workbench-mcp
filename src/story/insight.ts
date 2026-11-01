/**
 * Data Analyzer insights and live models, recorded from the Data Analyzer (save) and the story flow (model reference).
 *
 * An insight is a STORY resource with subtype INSIGHT. Its content holds a QueryBuilder document whose `inaRepo` is a
 * Firefly query model in INA_REPOSITORY_DELTA format: only what differs from the default query is stored, so data
 * source plus axis layout is enough. The server checks that the referenced model (CUBE) exists.
 *
 * Datasphere models are referenced directly by connection/space/model. The Data Analyzer then talks to Datasphere,
 * which needs a Datasphere login in the browser profile once (the story editor goes through the tunnel and does not).
 * createLiveModel stays for stories and other places that need an SAC model object.
 */

import { newCubeId } from "./binding.js";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentlib, tenantPackage } from "./content.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;


export interface LiveSource {
  connection: string;
  space: string;
  model: string;
}

/** SAC live model on a Datasphere analytic model, saved in a folder. */
export async function createLiveModel(opts: LiveSource & { name: string; folderId: string; description?: string }): Promise<{ cubeId: string }> {
  const cubeId = newCubeId();
  const pkg = `${tenantPackage()}.${cubeId}`;
  const description = opts.description ?? `${opts.model} (${opts.connection}/${opts.space})`;
  await contentlib("createContent", {
    parentResId: opts.folderId,
    resourceType: "CUBE",
    name: opts.name,
    description,
    cdata: JSON.stringify({
      id: `${pkg}:${cubeId}`,
      parentResourceId: opts.folderId,
      type: "Analytic",
      mode: "integrated",
      isEmbedded: false,
      shortDescription: description,
      description,
      sources: [{ connectionName: opts.connection, objectName: opts.model, objectType: "InAModel", packageName: null, schemaName: opts.space }],
    }),
    createOpt: {},
    resourceSubtype: "ANALYTIC",
    resourceId: cubeId,
    allowAuthOverride: true,
  });
  return { cubeId };
}

/** Kind and source of a model (CUBE resource): native SAC model or live model on Datasphere. */
export async function describeModel(cubeId: string): Promise<{ cubeId: string; live?: LiveSource; name: string }> {
  const res = await contentlib("getContent", { resourceType: "CUBE", resourceId: cubeId, oOpt: {} });
  const text = typeof res?.cdata === "string" ? res.cdata : JSON.stringify(res?.cdata ?? "");
  const pick = (k: string) => text.match(new RegExp(`\\\\?"${k}\\\\?":\\s*\\\\?"([^"\\\\]+)`))?.[1];
  const connection = pick("connectionName");
  const name = res?.name ?? cubeId;
  if (connection) return { cubeId, name, live: { connection, space: pick("schemaName") ?? "", model: pick("objectName") ?? "" } };
  return { cubeId, name };
}

export type InsightChart = "Bar" | "Column" | "StackedBar" | "StackedColumn" | "Line" | "Pie" | "Donut";

export interface InsightLayout {
  /** dimension names (InA names) on the rows */
  rows: string[];
  /** further dimensions on the columns, next to the measures */
  columns?: string[];
  /** only these measures (technical names); default all */
  measures?: string[];
  /** show as chart instead of table */
  chart?: InsightChart;
  /** member filters on the query (the Data Analyzer has one filter line for its single table/chart) */
  filters?: InsightFilter[];
}

export interface InsightFilter {
  /** dimension name (InA) */
  dimension: string;
  /** key field the filter compares, e.g. DJ_Product_Category_ID (metadata `key`) */
  keyField: string;
  /** text field for the member descriptions, e.g. DJ_Product_Category_ID∞T (metadata `text`) */
  textField?: string;
  members: { id: string; text?: string }[];
  exclude?: boolean;
}

const VISUALIZATION = resolve(dirOf(import.meta.url), "..", "..", "templates", "da_visualization.json");
const uuid = () => randomUUID();

function queryModel(dataSource: Json, layout: InsightLayout): Json {
  const columns = ["CustomDimension1", ...(layout.columns ?? [])];
  return {
    CType: "QueryModel",
    DataSource: dataSource,
    DimensionsRepo: {
      CType: "Dimensions",
      Elements: [
        ...layout.rows.map((Name) => ({ CType: "Dimension", Name, Axis: "Rows" })),
        ...columns.map((Name) => ({ CType: "Dimension", Name, Axis: "Columns" })),
      ],
    },
    Query: {
      AxesLayout: [
        { Axis: "Rows", OrderedDimensionNames: layout.rows },
        { Axis: "Columns", OrderedDimensionNames: columns },
      ],
    },
    ...(layout.measures?.length || layout.filters?.length ? { FilterRepo: queryFilter(layout) } : {}),
    ...(layout.chart ? { VisualizationManager: visualization(layout.chart, layout) } : {}),
  };
}

/**
 * Recorded from deselecting measures in the Data Analyzer builder (list on [Measures].[Measures]) and from the filter
 * line (Set Filter → Filter by Member: one list per dimension on its key field, descriptions as supplements).
 */
function queryFilter(layout: InsightLayout): Json {
  const op = (FieldName: string, value: Json, exclude = false) => ({
    CType: "FilterOperation",
    Comparison: "=",
    Exactness: 0,
    FieldName,
    HasDepth: false,
    HasLevelOffset: false,
    Id: uuid(),
    IsExcluding: exclude,
    Values: [value],
  });
  const lists: Json[] = [];
  if (layout.measures?.length)
    lists.push({
      CType: "FilterCartesianList",
      ConvertToFlatSelection: false,
      Elements: layout.measures.map((m) => op("[Measures].[Measures]", { FieldLiteralValue: true, Value: m, ValueType: "String" })),
      FieldName: "[Measures].[Measures]",
      Id: uuid(),
    });
  for (const f of layout.filters ?? [])
    lists.push({
      CType: "FilterCartesianList",
      ConvertToFlatSelection: false,
      Elements: f.members.map((m) =>
        op(
          f.keyField,
          {
            FieldLiteralValue: true,
            ...(f.textField && m.text ? { Supplements: [{ Key: f.textField, Value: m.text }] } : {}),
            Value: m.id,
            ValueType: "String",
          },
          f.exclude,
        ),
      ),
      FieldName: f.keyField,
      Id: uuid(),
      ...(f.textField ? { SupplementsFieldNames: [f.textField] } : {}),
    });
  return {
    CType: "Filter",
    DynamicFilter: {
      CType: "FilterExpression",
      CellValueOperand: [],
      FilterRoot: { CType: "FilterCartesianProduct", Elements: lists, Id: uuid() },
      Id: uuid(),
      IsSuppressingNulls: false,
    },
    VisibilityFilter: { CType: "FilterExpression", CellValueOperand: [], Id: uuid(), IsSuppressingNulls: false },
  };
}

/** Filter line tokens (document level): one per filtered dimension. */
function filterLine(layout: InsightLayout, base: Json): Json {
  const tokens = Object.fromEntries((layout.filters ?? []).map((f) => [f.dimension, { filterType: "List", readMode: "booked", showType: "idAndDescription" }]));
  return { ...base, ...(layout.filters?.length ? { FilterLineCascadingSetting: "None" } : {}), filterTokens: tokens };
}

/**
 * Recorded from Display Type → Bar; other chart types swap the type name. The chart's feeds (KeyFigureSelections)
 * name the category dimensions (the rows) and the value measures — the recording's Region/Umsatz are replaced.
 */
function visualization(chart: InsightChart, layout: InsightLayout): Json {
  const tpl = JSON.parse(readFileSync(VISUALIZATION, "utf8"));
  const el = JSON.parse(JSON.stringify(tpl.chartElement).split('"Bar"').join(`"${chart}"`).split("view_Bar").join(`view_${chart}`));
  const member = (DimensionName: string, id: string | null) => ({ DimensionName, Id: id, Name: id, NestedKeyFigures: [], Text: null });
  for (const sel of el.ChartDefinition?.ChartSettings?.KeyFigureSelections ?? []) {
    if (sel.VisualizationValueType === "Category") sel.Members = layout.rows.map((d) => member(d, null));
    if (sel.VisualizationValueType === "Value") sel.Members = (layout.measures ?? []).map((m) => member("CustomDimension1", m));
  }
  return { ActiveVisualizationDefinition: el.Name, CType: "VisualizationManager", Elements: [tpl.tableElement, el], Subtitle: { Priority: 0 }, Title: { Priority: 0 } };
}

/**
 * Datasphere models are referenced directly (recorded from Data Analyzer → From an Existing Model → Datasphere):
 * dataSource inamodel:[space][][model], an embedded dwcContent dataset, modelType TRANSIENT — no SAC live model needed.
 */
function datasphereEntities(live: LiveSource, layout: InsightLayout, now: string): Json[] {
  const document = {
    createDate: now,
    dataSource: `inamodel:[${live.space}][][${live.model}]`,
    docType: "QueryBuilder",
    docVersion: "0.3.1",
    fileType: "Document",
    filterLineConfig: filterLine(layout, { FilterLineCascadingSetting: "Default", filterTokens: {}, groupDimensions: true }),
    forcePrompt: false,
    inaRepo: queryModel({ Description: live.model, ObjectName: live.model, SchemaName: live.space, System: live.connection, Type: "InAModel" }, layout),
    modifiedDate: now,
    queryDetailsConfig: null,
    suppressExitVariables: false,
    system: live.connection,
  };
  const dataset = {
    data: {
      dwcContent: {
        description: live.model,
        id: "",
        isEmbedded: true,
        mode: "integrated",
        shortDescription: live.model,
        sources: [{ connectionName: live.connection, objectName: live.model, objectType: "InAModel", packageName: null, schemaName: live.space }],
        type: "Analytic",
      },
      forcePrompt: false,
    },
    isDwcModel: true,
    type: "dataset",
  };
  return [document, dataset];
}

function sacModelEntities(cubeId: string, layout: InsightLayout, now: string): Json[] {
  const pkg = `${tenantPackage()}.${cubeId}`;
  const modelId = `${pkg}:${cubeId}`;
  const schema = `TENANT_${tenantPackage().replace(/^t\./, "")}`;
  const object = `/${pkg}/${cubeId}_qs`;
  const datasetId = `planning:[${schema}][][${object}]`;
  const document = {
    createDate: now,
    dataSource: `$[][${modelId}]/${datasetId}`,
    docType: "QueryBuilder",
    docVersion: "0.3.1",
    fileType: "Document",
    filterLineConfig: filterLine(layout, { FilterLineCascadingSetting: "Default", displayDimensionMapping: {}, filterTokens: {}, groupDimensions: true }),
    forcePrompt: false,
    inaRepo: queryModel({ ObjectName: object, SchemaName: schema, System: "EHS", Type: "Planning" }, layout),
    model: modelId,
    modifiedDate: now,
    queryDetailsConfig: null,
    suppressExitVariables: false,
    system: "EHS",
  };
  const dataset = {
    data: { forcePrompt: false, id: datasetId, isRemote: "false", modelId: cubeId, packageName: pkg },
    id: datasetId,
    type: "dataset",
  };
  return [document, dataset];
}

export async function createInsight(opts: {
  name: string;
  description?: string;
  folderId: string;
  /** SAC model (or an SAC live model on Datasphere, which is then opened directly) */
  cubeId?: string;
  /** Datasphere model, referenced directly */
  live?: LiveSource;
  layout: InsightLayout;
}): Promise<{ insightId: string; live?: LiveSource }> {
  let live = opts.live;
  if (!live && !opts.cubeId) throw new Error("Pass cubeId or a Datasphere source");
  if (!live) live = (await describeModel(opts.cubeId!)).live;
  const now = new Date().toISOString();
  const entities = live ? datasphereEntities(live, opts.layout, now) : sacModelEntities(opts.cubeId!, opts.layout, now);
  const cdata = {
    content: {
      entities,
      metadata: { strategy: "Dragonfly", version: "2.1" },
      sourceTool: { metadata: { toolMetadata: { documentType: "QueryBuilder", version: "0.3.1" } }, name: "GalaxyDataStudio" },
    },
    description: opts.description ?? "",
    modelType: live ? "TRANSIENT" : "PERSISTED",
    name: opts.name,
    title: opts.name,
  };
  const res = await contentlib("createContent", {
    cdata: JSON.stringify(cdata),
    createOpt: { enhancedProperties: { DATA_ANALYZER_INFO: "DRAGONFLY" } },
    description: opts.description ?? "",
    name: opts.name,
    parentResId: opts.folderId,
    resourceSubtype: "INSIGHT",
    resourceType: "STORY",
  });
  return { insightId: res.resourceId, live };
}

/** Datasphere source of an insight (undefined for SAC models). */
export async function insightSource(insightId: string): Promise<LiveSource | undefined> {
  const res = await contentlib("getContent", { resourceType: "STORY", resourceId: insightId, oOpt: {} });
  const cdata = typeof res.cdata === "string" ? JSON.parse(res.cdata) : res.cdata;
  const ds = cdata?.content?.entities?.[0]?.inaRepo?.DataSource;
  return ds?.Type === "InAModel" ? { connection: ds.System, space: ds.SchemaName, model: ds.ObjectName } : undefined;
}

export const insightUrl = (id: string) => `/sap/fpa/ui/app.html#/dataanalyzer&/dz/${id}`;

/** Replace the layout (rows, columns, measures, chart) of an existing insight; data source stays. */
export async function updateInsight(insightId: string, layout: InsightLayout): Promise<{ updateCounter: number }> {
  const res = await contentlib("getContent", { resourceType: "STORY", resourceId: insightId, oOpt: {} });
  const cdata = typeof res.cdata === "string" ? JSON.parse(res.cdata) : res.cdata;
  const doc = cdata?.content?.entities?.[0];
  if (!doc?.inaRepo) throw new Error(`${insightId} is not a Data Analyzer insight`);
  doc.inaRepo = queryModel(doc.inaRepo.DataSource, layout);
  doc.filterLineConfig = filterLine(layout, doc.filterLineConfig ?? { FilterLineCascadingSetting: "Default", filterTokens: {}, groupDimensions: true });
  doc.modifiedDate = new Date().toISOString();
  const save = (localVer: number) =>
    contentlib("updateContent", {
      resourceId: insightId,
      name: res.name,
      description: res.description ?? "",
      cdata: JSON.stringify(cdata),
      updateOpt: { localVer, ignoreVersion: false, enhancedProperties: { DATA_ANALYZER_INFO: "DRAGONFLY" } },
    });
  let saved: Json;
  try {
    saved = await save(res.updateCounter);
  } catch (e) {
    // like the story editor: the server may expect the version after its own last touch
    if (!String(e).includes("INCONSISTENT_VERSION")) throw e;
    saved = await save(res.updateCounter + 1);
  }
  return { updateCounter: saved?.updateCounter };
}
