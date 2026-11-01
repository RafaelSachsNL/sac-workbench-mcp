#!/usr/bin/env node
// Smoke test before a demo: runs the core flows against the configured tenant and removes what it created.
// Usage: npm run smoke -- <folderId> [model] [connection] [space]
// Needs: logged-in browser profile (npm run login); writes only into <folderId>.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [folderId, model = "DEMO_SALES_MODEL", connection, space] = process.argv.slice(2);
if (!folderId) {
  console.error("Usage: npm run smoke -- <folderId> [model] [connection] [space]");
  process.exit(2);
}
const src = { model, ...(connection ? { connection } : {}), ...(space ? { space } : {}) };
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");

const client = new Client({ name: "sac-mcp-smoke", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../build/index.js", import.meta.url))], env: { ...process.env }, stderr: "inherit" }),
);

const results = [];
const created = [];
async function step(name, tool, args, check) {
  const t0 = Date.now();
  try {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10 * 60_000 });
    const text = res.content.map((p) => p.text ?? "").join("");
    const data = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })();
    if (res.isError) throw new Error(text.slice(0, 300));
    const note = check ? check(data) : "";
    results.push({ step: name, ok: true, ms: Date.now() - t0, note });
    return data;
  } catch (e) {
    results.push({ step: name, ok: false, ms: Date.now() - t0, note: String(e.message ?? e).slice(0, 300) });
    return undefined;
  }
}

await step("login", "sac_browser_login", {});
const meta = await step("model metadata", "sac_model_metadata", src, (d) => `${d.dimensions?.length} dims, ${d.measures?.length} measures`);
// Datasphere search must find the model's space and never return the Datasphere token
await step("datasphere search", "sac_datasphere_search", { query: model }, (d) => {
  if (JSON.stringify(d).match(/"token"|eyJ[A-Za-z0-9_-]{10,}/)) throw new Error("token leaked");
  return `${d.count} hits, space ${d.results?.find((r) => r.name === model)?.space ?? "?"}`;
});
const dim = meta?.dimensions?.find((d) => !/date|month|year|version|currency|∞/i.test(d.caption))?.caption;
const measure = meta?.measures?.[0]?.name;

const dash = await step(
  "canvas dashboard",
  "sac_story_generate_dashboard",
  {
    name: `SMOKE_${stamp}`,
    folderId,
    ...src,
    title: "Smoke Test",
    filters: dim ? [dim] : [],
    kpis: [{ measure }],
    charts: [{ dimension: dim, measure }],
    table: { dimension: dim, measure },
    theme: "none",
    template: "Horizon Template (2.0.1)",
    layout: "canvas",
    headerInverted: false,
    allowalteration: true,
  },
  (d) => `${d.widgets?.length} widgets`,
);
const runtimeOk = (d) => {
  if (!d.ok) throw new Error(JSON.stringify(d).slice(0, 300));
  return `loaded in ${d.loadMs} ms`;
};
if (dash?.storyId) {
  created.push(dash.storyId);
  await step("runtime check", "sac_story_check_runtime", { storyId: dash.storyId }, runtimeOk);
  // input controls of every kind on the control bar
  const names = (dash.widgets ?? []).map((w) => w.name ?? w);
  const bar = names.find((n) => /^FP_CONTROL_ITEMS/.test(n)) ?? "PAGE_1";
  const chart = names.find((n) => /^CH_(BAR|COL|LINE)/.test(n));
  const measures = (meta?.measures ?? []).slice(0, 2).map((m) => m.name);
  const ic = { storyId: dash.storyId, container: bar, width: 200, height: 52, allowalteration: true };
  await step("IC measure filter", "sac_story_add_input_control", { ...ic, kind: "measureRange", dimension: dim, measure, ranges: [{ start: 0, end: 1e12 }] }, (d) => d.name);
  if (chart && measures.length > 1) {
    await step("IC measure swap", "sac_story_add_input_control", { ...ic, kind: "measureSwap", dimension: "-", title: "Measure", options: measures, charts: [chart] }, (d) => d.name);
    const dims = (meta?.dimensions ?? []).filter((d) => !/date|month|year|version|currency/i.test(d.caption)).slice(0, 2).map((d) => d.caption);
    if (dims.length > 1)
      await step("IC dimension swap", "sac_story_add_input_control", { ...ic, kind: "dimensionSwap", dimension: "-", title: "Aufriss", options: dims, charts: [chart] }, (d) => d.name);
  }
  await step("runtime with ICs", "sac_story_check_runtime", { storyId: dash.storyId }, runtimeOk);
}
const insight = await step("insight", "sac_insight_create", { name: `SMOKE_DA_${stamp}`, folderId, ...src, rows: [dim], allowalteration: true }, (d) => d.insightId);
if (insight?.insightId) created.push(insight.insightId);
const chartInsight = await step(
  "insight chart+filter",
  "sac_insight_create",
  { name: `SMOKE_DA_CHART_${stamp}`, folderId, ...src, rows: [dim], measures: [measure], chart: "Bar", filters: [], allowalteration: true },
  (d) => d.insightId,
);
if (chartInsight?.insightId) created.push(chartInsight.insightId);

// guard: red/green series palettes are refused until confirmed
await step("signal colour guard", "sac_theme_update", { themeId: "none", palette: ["#D32F2F"], allowalteration: true }, (d) => {
  if (!d.needsInput) throw new Error("red palette was not refused");
  return "red palette refused";
});

// planning chain: model → data action → multi action (run) → planning story with data action button
const W = { allowalteration: true };
const plan = await step("planning model", "sac_planning_model_create", {
  name: `SMOKE_PLAN_${stamp}`, folderId, measures: [{ name: "Umsatz" }, { name: "Menge", decimals: 0 }], dimensions: [{ name: "Region" }], ...W,
}, (d) => d.cubeId);
if (plan?.cubeId) {
  created.push(plan.cubeId);
  await step("members", "sac_model_members_set", { cubeId: plan.cubeId, dimension: "Region", members: [{ id: "DE", description: "Germany" }, { id: "AT", description: "Austria" }], ...W });
  // plan data without a story: write → read → revert → read (the fresh model is empty)
  const cell = { model: plan.cubeId, version: "Plan", measure: "Umsatz", members: { Region: "Germany" }, period: "2026-01" };
  await step("plan write", "sac_plan_write", { ...cell, value: 1234, ...W }, (d) => {
    if (d.after !== 1234) throw new Error(`after = ${d.after}`);
    return `${d.before} → ${d.after}`;
  });
  await step("plan revert", "sac_plan_revert", { model: plan.cubeId, version: "Plan", ...W });
  await step("plan read after revert", "sac_plan_read", cell, (d) => {
    if (d.value !== 0) throw new Error(`value = ${d.value} (expected 0)`);
    return "0 again";
  });
  const da = await step("data action", "sac_dataaction_create", {
    name: `SMOKE_DA_${stamp}`, folderId, cubeId: plan.cubeId,
    steps: [{ name: "Plan aus Ist + 5 %", script: 'DATA() = RESULTLOOKUP([d/Version] = "public.Actual") * 1.05' }], ...W,
  }, (d) => d.dataActionId);
  if (da?.dataActionId) {
    created.push(da.dataActionId);
    await step("data action run", "sac_dataaction_run", { dataActionId: da.dataActionId, targetVersion: "public.Plan", ...W });
    const ma = await step("multi action", "sac_multiaction_create", {
      name: `SMOKE_MA_${stamp}`, folderId, steps: [{ name: "Plan + 5 %", dataActionId: da.dataActionId, targetVersion: "public.Plan" }], ...W,
    }, (d) => d.multiActionId);
    if (ma?.multiActionId) {
      created.push(ma.multiActionId);
      const run = await step("multi action run", "sac_multi_action_execute", { multiActionId: ma.executeId, parameterValues: [], ...W }, (d) => d.executionId);
      if (run?.executionId) {
        let status = "running";
        for (let i = 0; i < 30 && /running|pending|queued/i.test(status); i++) {
          await new Promise((r) => setTimeout(r, 2000));
          status = (await client.callTool({ name: "sac_multi_action_get_status", arguments: { multiActionId: ma.executeId, executionId: run.executionId } })).content[0].text;
          status = JSON.parse(status.slice(status.indexOf("{"))).status ?? status;
        }
        results.push({ step: "multi action finished", ok: status === "successful", ms: 0, note: status });
      }
    }
    const ps = await step("planning story", "sac_planning_story_create", {
      name: `SMOKE_PS_${stamp}`, folderId, cubeId: plan.cubeId, title: "Smoke Planung", rowDimension: "Region", measures: ["Umsatz", "Menge"],
      tableTitle: "Umsatz je Region", template: "Horizon Template (2.0.1)", headerInverted: false, ...W,
    }, (d) => d.storyId);
    if (ps?.storyId) {
      created.push(ps.storyId);
      const titleRow = ps.widgets?.map((w) => w.name ?? w).find((n) => /^PA_.*TITLE/.test(n));
      await step("story data action", "sac_story_add_dataaction", { storyId: ps.storyId, name: "DA_PLAN", dataActionId: da.dataActionId, targetVersion: "public.Plan", ...W });
      await step("button", "sac_story_add_button", {
        storyId: ps.storyId, container: titleRow ?? "PAGE_1", text: "Plan + 5 %", onClick: "DA_PLAN.execute();", right: 12, top: 8, width: 160, height: 32, ...W,
      }, (d) => d.name);
      await step("planning runtime", "sac_story_check_runtime", { storyId: ps.storyId }, (d) => {
        if (!d.ok) throw new Error(JSON.stringify(d).slice(0, 300));
        return `loaded in ${d.loadMs} ms`;
      });
    }
  }
}

// forecast planning story — only with a Seamless planning model of your own:
// SMOKE_FORECAST="<model>,<rowDimension>,<measure>"
if (process.env.SMOKE_FORECAST) {
  const [fcModel, rowDimension, fcMeasure] = process.env.SMOKE_FORECAST.split(",");
  const fc = await step("forecast story", "sac_planning_forecast_story_create", {
    name: `SMOKE_FC_${stamp}`, folderId, title: "Smoke Forecast", model: fcModel, rowDimension, measure: fcMeasure, allowalteration: true,
  }, (d) => d.storyId);
  if (fc?.storyId) created.push(fc.storyId);
}

// responsive dashboard on an SAC planning model (generator path for SAC models) + runtime check — with
// SMOKE_SAC_MODEL="<model>,<dimension>,<measure>"
if (process.env.SMOKE_SAC_MODEL) {
  const [sacModel, sacDim, sacMeasure] = process.env.SMOKE_SAC_MODEL.split(",");
  const sacDash = await step("dashboard (SAC model)", "sac_story_generate_dashboard", {
    name: `SMOKE_SACDASH_${stamp}`, folderId, model: sacModel, title: "Smoke SAC model", layout: "responsive", template: "none", theme: "none",
    scale: "Unformatted", decimals: 0,
    kpis: [{ measure: sacMeasure, label: "Actual" }, { measure: sacMeasure, label: "Plan", filters: [{ dimension: "Version", members: ["public.Plan"] }] }],
    charts: [{ dimension: sacDim, measure: sacMeasure }], table: { dimension: sacDim, measure: sacMeasure }, allowalteration: true,
  }, (d) => d.storyId);
  if (sacDash?.storyId) {
    created.push(sacDash.storyId);
    await step("dashboard (SAC model) runtime", "sac_story_check_runtime", { storyId: sacDash.storyId }, (d) => {
      if (!d.ok) throw new Error(JSON.stringify(d.console ?? d).slice(0, 300));
      return `loaded in ${d.loadMs} ms`;
    });
  }
  // canvas with the Horizon template on the same model, no table
  const sacCanvas = await step("canvas (SAC model, no table)", "sac_story_generate_dashboard", {
    name: `SMOKE_SACCANVAS_${stamp}`, folderId, model: sacModel, title: "Smoke SAC canvas", layout: "canvas", template: "Horizon Template (2.0.1)",
    theme: "none", headerInverted: false,
    kpis: [{ measure: sacMeasure, label: "Actual" }, { measure: sacMeasure, label: "This year", filters: [{ dimension: "Date", dynamic: { granularity: "year" } }] }],
    charts: [{ dimension: sacDim, measure: sacMeasure }], filters: [sacDim], allowalteration: true,
  }, (d) => d.storyId);
  if (sacCanvas?.storyId) {
    created.push(sacCanvas.storyId);
    await step("canvas (SAC model) runtime", "sac_story_check_runtime", { storyId: sacCanvas.storyId }, (d) => {
      if (!d.ok) throw new Error(JSON.stringify(d.console ?? d).slice(0, 300));
      return `loaded in ${d.loadMs} ms`;
    });
  }
}

// responsive on the Datasphere model without a table (the stand-in table is removed again)
const noTable = await step("responsive (no table)", "sac_story_generate_dashboard", {
  name: `SMOKE_NOTABLE_${stamp}`, folderId, ...src, title: "Smoke no table", layout: "responsive", template: "none", theme: "none",
  kpis: [{ measure }], charts: [{ dimension: dim, measure }], allowalteration: true,
}, (d) => {
  if (d.widgets.some((w) => w.startsWith("TA_"))) throw new Error("table left in the story");
  return d.storyId;
});
if (noTable?.storyId) created.push(noTable.storyId);

// one by one (newest first), so a single failure does not keep the rest
for (const id of created.reverse()) await step(`cleanup ${id}`, "sac_resource_delete", { resourceIds: [id], ...W });
await client.close();

console.log("\nSmoke test");
for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.step.padEnd(22)} ${String(r.ms).padStart(6)} ms  ${r.note ?? ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} step(s) failed` : "\nall green");
process.exitCode = failed ? 1 : 0;
