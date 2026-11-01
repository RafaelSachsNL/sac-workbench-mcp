#!/usr/bin/env node
// Long-running test harness: keeps one MCP server (and its browser session) alive.
// Drop a JSON file {"tool": "...", "args": {...}} into <dir>/in/; the result appears in <dir>/out/ with the same name.
// Usage: node scripts/mcp-daemon.mjs <dir>
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = process.argv[2];
for (const d of ["in", "out", "done"]) mkdirSync(join(dir, d), { recursive: true });
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../build/index.js", import.meta.url))],
  env: { ...process.env },
  stderr: "inherit",
});
const client = new Client({ name: "sac-mcp-daemon", version: "0.0.1" });
await client.connect(transport);
console.error("daemon ready, watching", join(dir, "in"));

for (;;) {
  for (const f of readdirSync(join(dir, "in")).filter((x) => x.endsWith(".json")).sort()) {
    const src = join(dir, "in", f);
    let req;
    try {
      req = JSON.parse(readFileSync(src, "utf8"));
    } catch (e) {
      req = { tool: "__invalid", error: String(e) };
    }
    renameSync(src, join(dir, "done", f));
    if (req.tool === "__invalid") {
      writeFileSync(join(dir, "out", f.replace(/\.json$/, ".txt")), `=== invalid request JSON\n${req.error}`);
      continue;
    }
    if (req.tool === "__exit") { await client.close(); process.exit(0); }
    const t0 = Date.now();
    let out;
    try {
      const res = await client.callTool({ name: req.tool, arguments: req.args ?? {} }, undefined, { timeout: 15 * 60_000 });
      out = `=== ${req.tool} (${Date.now() - t0}ms)${res.isError ? " ERROR" : ""}\n` + res.content
          .map((p, i) => {
            if (p.type !== "image") return p.text ?? JSON.stringify(p);
            const file = join(dir, "out", f.replace(/\.json$/, `-${i}.png`));
            writeFileSync(file, Buffer.from(p.data, "base64"));
            return `[image] ${file}`;
          })
          .join("\n");
    } catch (e) {
      out = `=== ${req.tool} EXCEPTION\n${e?.stack ?? e}`;
    }
    writeFileSync(join(dir, "out", f.replace(/\.json$/, ".txt")), out);
    console.error(`done ${f}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}
