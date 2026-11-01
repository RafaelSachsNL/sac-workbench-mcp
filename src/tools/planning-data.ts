/**
 * Plan data directly (no story, no UI): read and set values of SAC planning models (incl. Seamless Planning).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "../browser/session.js";
import { assertWritable, config } from "../config.js";
import { publishVersion, readPlanCell, revertVersion, writePlanCell } from "../story/planwrite.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";

const cell = {
  model: z.string().describe("Planning model: name or id (C…)"),
  version: z.string().describe("Version, e.g. F01.2025, Plan, Actual (description or id)"),
  measure: z.string().describe("Measure, e.g. Quantity_Sold or its description"),
  members: z
    .record(z.string(), z.union([z.string(), z.array(z.string())]))
    .describe("Dimension → member (id or description), e.g. {DJ_State: 'California', DJ_Product_Category: 'Carbonated Drinks'}; a list = their total; omitted dimensions = all"),
  period: z.string().optional().describe("Time of the planning time dimension: 'Q1 2025', '2025', '2025-03'"),
};

export function registerPlanningDataTools(server: McpServer): void {
  server.tool(
    "sac_plan_read",
    "Read the current value of a (possibly aggregated) planning cell — e.g. Quantity_Sold for California, Carbonated Drinks, F01.2025, Q1 2025.",
    cell,
    async (args) => {
      try {
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        return toolSuccess(await readPlanCell(args));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_plan_write",
    `Plan a value without opening a story: set an (aggregated) cell to a value, change it by a percentage or by a delta.
SAC distributes it to the detail level like a table entry (proportionally to existing values, e.g. a quarter to its
months and a category to its products). Public versions are put into edit mode; the change stays UNPUBLISHED (visible
to the user only) until it is published in SAC. Use dryRun to preview before/after first.
Examples: value 5000000 for Q1 2025 / California / Carbonated Drinks; percent 10 on all quantities of Nevada in 2025.`,
    {
      ...cell,
      value: z.number().optional().describe("Target value of the cell"),
      percent: z.number().optional().describe("Change in %, e.g. 10 or -5"),
      delta: z.number().optional().describe("Absolute change"),
      dryRun: z.boolean().optional().describe("Only compute before/target, write nothing"),
      allowalteration: z.boolean().optional(),
    },
    async ({ value, percent, delta, dryRun, allowalteration, ...c }) => {
      if (!dryRun && !allowalteration) return toolError(ALTERATION_MSG);
      try {
        if (!dryRun) assertWritable("plan data");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const r = await writePlanCell(c, { value, percent, delta }, dryRun);
        return toolSuccess({ ...r, note: dryRun ? "Preview – nothing written." : "Written, NOT published yet (visible to you only). Publish in SAC: Publish Data." });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_plan_publish",
    `Publish the unpublished planning changes of a version (what "Publish Data" does) — makes them visible to everyone.
Only after the user explicitly agreed to publish.`,
    { model: z.string(), version: z.string(), allowalteration: z.boolean().optional() },
    async ({ model, version, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("publish plan data");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        return toolSuccess(await publishVersion(model, version));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_plan_revert",
    "Discard all unpublished planning changes of a version (what \"Revert Data\" does).",
    { model: z.string(), version: z.string(), allowalteration: z.boolean().optional() },
    async ({ model, version, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("revert plan data");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        return toolSuccess(await revertVersion(model, version));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
