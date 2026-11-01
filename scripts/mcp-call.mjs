#!/usr/bin/env node
// Test driver: spawns the MCP server over stdio and runs a sequence of tool calls.
// Usage: node scripts/mcp-call.mjs '[{"tool":"sac_browser_status","args":{}}]'
//    or: node scripts/mcp-call.mjs calls.json
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const arg = process.argv[2] ?? "[]";
const calls = JSON.parse(existsSync(arg) ? readFileSync(arg, "utf8") : arg);
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "sac-mcp-test", version: "0.0.1" });
await client.connect(transport);
if (calls.length === 0) {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools:\n` + tools.map((t) => " - " + t.name).join("\n"));
}
for (const c of calls) {
  const t0 = Date.now();
  const res = await client.callTool({ name: c.tool, arguments: c.args ?? {} }, undefined, { timeout: 15 * 60_000 });
  console.log(`\n=== ${c.tool} (${Date.now() - t0}ms)${res.isError ? " ERROR" : ""}`);
  for (const part of res.content) console.log(part.text ?? JSON.stringify(part));
}
await client.close();
