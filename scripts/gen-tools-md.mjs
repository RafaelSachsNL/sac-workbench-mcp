#!/usr/bin/env node
// Writes TOOLS.md to stdout from the tools the built server registers (npm run docs:tools). Needs no SAC tenant.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const AREAS = [
  ["Stories & widgets", /^sac_(story_(generate|create|canvas|add_(widget|kpi|filter|input|composite|button|dataaction)|duplicate|remove|set_(text|layout|position)|rename|get|patch|transform|restore|snapshot|diff)|fragment_|stories_|composite_)/],
  ["Charts & calculations", /^sac_story_(chart|set_colors|calculation|add_(variance|threshold|year_comparison)|format)/],
  ["Themes & CSS", /^sac_(theme_|story_(css|style|set_theme|apply_theme))|^sac_design_assets/],
  ["Scripting & checks", /^sac_(script|scripts_|story_(check_runtime|inspect))/],
  ["Planning & models", /^sac_(planning_|plan_|model_|dataaction_|multiaction_|public_dimension_|multi_action_)/],
  ["Data Analyzer & live models", /^sac_(insight_|live_model|models_list|datasphere_search)/],
  ["Files & content", /^sac_(files_|folder_|resource_|resources_|filerepository|repositories|widget_get_data|metadata_get)/],
  ["Data import & export (public API)", /^sac_(import_|export_)/],
  ["Users, teams & administration (public API)", /^sac_(users_|teams_|audit_|monitoring_|transport_|schedule_|calendar_|translation_)/],
  ["Browser session, recording & raw requests", /^sac_(browser_|capture_|replay|api_request|contentlib)|^smart_query$|^ping$/],
];

// expert tools included, marked 🔧 in the list
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
  env: { ...process.env, SAC_EXPERT_TOOLS: "true" },
  stderr: "ignore",
});
const EXPERT = new Set(["sac_browser_eval", "sac_api_request", "sac_replay"]);
const client = new Client({ name: "gen-tools-md", version: "0.0.1" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const area = (name) => AREAS.find(([, re]) => re.test(name))?.[0] ?? "Other";
const groups = new Map(AREAS.map(([a]) => [a, []]).concat([["Other", []]]));
for (const t of tools.sort((a, b) => a.name.localeCompare(b.name))) groups.get(area(t.name)).push(t);

const writes = (t) => "allowalteration" in (t.inputSchema?.properties ?? {});
const params = (t) =>
  Object.entries(t.inputSchema?.properties ?? {})
    .filter(([k]) => k !== "allowalteration")
    .map(([k]) => ((t.inputSchema.required ?? []).includes(k) ? `**${k}**` : k))
    .join(", ");
const oneLine = (s) => (s ?? "").replace(/\s+/g, " ").trim();

const out = [];
out.push("# Tools reference", "");
out.push(`Every tool the server registers — ${tools.length - EXPERT.size} tools plus ${EXPERT.size} expert tools — generated from the server itself (\`npm run docs:tools\`).`);
out.push("Tools marked ✏️ change something in SAC and only run with `allowalteration: true`; the others only read.");
out.push("Tools marked 🔧 are expert tools, only loaded with `expertTools: true` / `SAC_EXPERT_TOOLS=true`.");
out.push("Required parameters are **bold**. For what the server does as a whole see the [README](README.md).", "");
out.push("## Contents", "");
for (const [a, list] of groups) if (list.length) out.push(`- [${a}](#${a.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-")}) — ${list.length} tools`);
out.push("");
for (const [a, list] of groups) {
  if (!list.length) continue;
  out.push(`## ${a}`, "", "| Tool | What it does | Parameters |", "|---|---|---|");
  for (const t of list) out.push(`| \`${t.name}\`${writes(t) ? " ✏️" : ""}${EXPERT.has(t.name) ? " 🔧" : ""} | ${oneLine(t.description).replace(/\|/g, "\\|")} | ${params(t)} |`);
  out.push("");
}
process.stdout.write(out.join("\n"));
