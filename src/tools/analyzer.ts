/**
 * Data Analyzer: insights (saved analyses) and the live models they run on.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "../browser/session.js";
import { assertWritable, config, defaultOf } from "../config.js";
import { contentlib, ensureTenantPackage } from "../story/content.js";
import { createInsight, createLiveModel, describeModel, insightSource, insightUrl, updateInsight, type InsightFilter } from "../story/insight.js";
import { fetchModelMetadata, resolveDimension, resolveMeasure, type ModelMetadata } from "../story/metadata.js";

const filterSchema = z
  .array(
    z.object({
      dimension: z.string().describe("Caption or technical name"),
      members: z.array(z.string()).min(1).describe("Member ids, e.g. PC2"),
      exclude: z.boolean().optional(),
    }),
  )
  .optional()
  .describe("Member filters of the insight (Data Analyzer filter line; applies to table and chart alike). SAC models: technical dimension id (e.g. Region).");

type FilterInput = { dimension: string; members: string[]; exclude?: boolean };

/** SAC models: key field <dim>.ID, description <dim>.Description (recorded from the filter line). */
function sacModelFilters(filters: FilterInput[]): InsightFilter[] {
  return filters.map((f) => ({ dimension: f.dimension, keyField: `${f.dimension}.ID`, textField: `${f.dimension}.Description`, members: f.members.map((id) => ({ id })), exclude: f.exclude }));
}

function resolveFilters(meta: ModelMetadata, filters: FilterInput[]): InsightFilter[] {
  return filters.map((f) => {
    const d = resolveDimension(meta, f.dimension);
    return { dimension: d.name, keyField: d.key, textField: d.text || undefined, members: f.members.map((id) => ({ id })), exclude: f.exclude };
  });
}
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;


async function ready() {
  await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
  await ensureTenantPackage();
}

/** Existing live model on the same Datasphere object in the folder, if any. */
async function findLiveModel(folderId: string, src: { connection: string; space: string; model: string }): Promise<string | undefined> {
  const res = await contentlib("getSearchList", { type: "CUBE", value: "*", recentlyAccessed: 500, bIncTemporary: false, spaceId: null });
  for (const c of (Array.isArray(res) ? res : []) as Json[]) {
    if (c?.parentResId !== folderId) continue;
    const m = await describeModel(c.resourceId).catch(() => undefined);
    if (m?.live && m.live.connection === src.connection && m.live.space === src.space && m.live.model === src.model) return c.resourceId;
  }
  return undefined;
}

export function registerAnalyzerTools(server: McpServer): void {
  server.tool(
    "sac_live_model_create",
    `Create an SAC live model on a Datasphere analytic model (like New Model → Datasphere) in a folder. Needed for the
Data Analyzer on Datasphere data; stories bind models themselves.`,
    {
      name: z.string(),
      folderId: z.string(),
      connection: z.string().optional().transform((v) => v ?? defaultOf("connection")),
      space: z.string().optional().transform((v) => v ?? defaultOf("space")),
      model: z.string().describe("Datasphere analytic model technical name"),
      description: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ allowalteration, ...args }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create live model");
        await ready();
        const { cubeId } = await createLiveModel(args);
        return toolSuccess({ cubeId, name: args.name, source: `${args.connection}/${args.space}/${args.model}` });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_insight_create",
    `Create a Data Analyzer insight (saved analysis): a table with the given dimensions on the rows (and optionally columns)
and the model's measures. Model: either an SAC model (cubeId, e.g. from sac_models_list / sac_files_list) or a
Datasphere model (connection/space/model), referenced directly (no live model needed).
Dimensions accept captions or technical names for Datasphere models; SAC models take their dimension ids.
Opening Datasphere-based insights needs a Datasphere login in the browser once.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string().optional().describe("Default: defaults.folderId from the config"),
      cubeId: z.string().optional().describe("SAC model / live model resource id"),
      connection: z.string().optional(),
      space: z.string().optional(),
      model: z.string().optional().describe("Datasphere analytic model (when no cubeId)"),
      rows: z.array(z.string()).min(1),
      columns: z.array(z.string()).optional(),
      measures: z.array(z.string()).optional().describe("Only these measures (technical names); default all"),
      chart: z.enum(["Bar", "Column", "StackedBar", "StackedColumn", "Line", "Pie", "Donut"]).optional().describe("Display as chart instead of table"),
      filters: filterSchema,
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create insight");
        await ready();
        let rows = args.rows;
        let columns = args.columns ?? [];
        let measures = args.measures;
        let filters: InsightFilter[] | undefined;
        let live: { connection: string; space: string; model: string } | undefined;
        let modelName = "";
        if (args.cubeId) {
          const m = await describeModel(args.cubeId);
          live = m.live;
          modelName = `${m.name} (${args.cubeId})`;
        } else {
          if (!args.model) throw new Error("Pass cubeId or model (+ connection/space)");
          live = { connection: args.connection ?? defaultOf("connection"), space: args.space ?? defaultOf("space"), model: args.model };
        }
        if (args.filters?.length && !live) filters = sacModelFilters(args.filters);
        if (live) {
          const meta = await fetchModelMetadata(live.connection, live.space, live.model);
          rows = rows.map((d) => resolveDimension(meta, d).name);
          columns = columns.map((d) => resolveDimension(meta, d).name);
          if (measures) measures = measures.map((m) => resolveMeasure(meta, m));
          // a chart needs at least one measure to plot
          else if (args.chart && meta.measures?.[0]) measures = [meta.measures[0].name];
          if (args.filters?.length) filters = resolveFilters(meta, args.filters);
          modelName = `${live.connection}/${live.space}/${live.model} (Datasphere)`;
        }
        const folderId = args.folderId ?? config.defaults.folderId;
        if (!folderId) throw new Error("folderId missing (and no defaults.folderId in the config)");
        // SAC models: without Version on an axis or in a filter the insight adds Actual and Plan up — never meaningful
        let versionNote: string | undefined;
        if (!live && ![...rows, ...columns, ...(filters ?? []).map((f) => f.dimension)].includes("Version")) {
          filters = [...(filters ?? []), ...sacModelFilters([{ dimension: "Version", members: ["public.Actual"] }])];
          versionNote = "Version filtered to public.Actual (otherwise actual and plan would be added up). Other version: filters; comparison: columns ['Version'].";
        }
        const { insightId } = await createInsight({ name: args.name, description: args.description, folderId, cubeId: args.cubeId, live, layout: { rows, columns, measures, chart: args.chart, filters } });
        return toolSuccess({
          insightId,
          name: args.name,
          model: modelName,
          rows,
          columns,
          ...(versionNote ? { note: versionNote } : {}),
          openURL: insightUrl(insightId),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_insight_list",
    "List Data Analyzer insights visible to the user (name, id, folder, last change).",
    {},
    async () => {
      try {
        await ready();
        const res = await contentlib("getSearchList", { type: "STORY", value: "*", recentlyAccessed: 500, bIncTemporary: false, spaceId: null });
        const list = ((Array.isArray(res) ? res : []) as Json[])
          .filter((x) => x?.resourceSubtype === "INSIGHT")
          .map((x) => ({ insightId: x.resourceId, name: x.name, folderId: x.parentResId, modified: x.modifiedTime, openURL: insightUrl(x.resourceId) }));
        return toolSuccess(list);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_insight_update",
    "Change an existing insight: rows, columns, measures, filters and display (table or chart type). Pass the full layout.",
    {
      insightId: z.string(),
      rows: z.array(z.string()).min(1),
      columns: z.array(z.string()).optional(),
      measures: z.array(z.string()).optional(),
      chart: z.enum(["Bar", "Column", "StackedBar", "StackedColumn", "Line", "Pie", "Donut"]).optional().describe("Omit for a table"),
      filters: filterSchema,
      allowalteration: z.boolean().optional(),
    },
    async ({ insightId, rows, columns, measures, chart, filters, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("update insight");
        await ready();
        let resolved: InsightFilter[] | undefined;
        const live = await insightSource(insightId);
        if (live) {
          const meta = await fetchModelMetadata(live.connection, live.space, live.model);
          rows = rows.map((d) => resolveDimension(meta, d).name);
          columns = columns?.map((d) => resolveDimension(meta, d).name);
          measures = measures?.map((m) => resolveMeasure(meta, m));
          if (filters?.length) resolved = resolveFilters(meta, filters);
        } else if (filters?.length) resolved = sacModelFilters(filters);
        const r = await updateInsight(insightId, { rows, columns, measures, chart, filters: resolved });
        return toolSuccess({ insightId, ...r, openURL: insightUrl(insightId) });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
