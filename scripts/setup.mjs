#!/usr/bin/env node
import { fileURLToPath } from "node:url";
// Interactive setup: asks for the tenant, writes the config, then opens Chrome for the SSO login.
// Git clone: <repo>/sac-mcp.config.json. npm install: ~/.sac-mcp/config.json (the package folder is replaced on updates).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installed = /[\\/]node_modules[\\/]/.test(root);
const file = installed ? join(homedir(), ".sac-mcp", "config.json") : join(root, "sac-mcp.config.json");
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : JSON.parse(readFileSync(join(root, "sac-mcp.config.example.json"), "utf8"));
// line queue instead of rl.question: also works when the answers are piped in
const rl = createInterface({ input: process.stdin });
const lines = [];
const waiting = [];
rl.on("line", (l) => (waiting.length ? waiting.shift()(l) : lines.push(l)));
rl.on("close", () => waiting.splice(0).forEach((w) => w("")));
const ask = async (q, def) => {
  process.stdout.write(def ? `${q} [${def}]: ` : `${q}: `);
  const answer = lines.length ? lines.shift() : await new Promise((r) => waiting.push(r));
  return answer.trim() || def || "";
};

console.log("sac-workbench-mcp – setup (no passwords are stored; you sign in via SSO in the browser)\n");
let url = await ask("SAC address (e.g. https://mytenant.eu10.hcs.cloud.sap)", current.tenantUrl?.includes("<") ? "" : current.tenantUrl);
url = url.replace(/\/sap\/fpa\/.*$/, "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(url)) {
  console.error("Invalid address – expected https://<host>");
  process.exit(1);
}
const user = await ask("SAC user id (empty = automatic)", current.user);
const connection = await ask("Default Datasphere connection (optional)", current.defaults?.connection);
const space = await ask("Default Datasphere space (optional)", current.defaults?.space);
const folderId = await ask("Default folder for new stories (resource id, optional)", current.defaults?.folderId);
const desktopConfig =
  platform() === "darwin"
    ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : platform() === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
      : undefined;
const register = desktopConfig ? /^j|^y/i.test(await ask("Register the server in Claude Desktop? (y/N)", "N")) : false;
rl.close();

const config = { ...current, tenantUrl: url, user, defaults: { ...(current.defaults ?? {}), connection, space, folderId } };
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
console.log(`\nSaved: ${file}`);

if (!existsSync(join(root, "build", "index.js"))) spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
console.log("\nChrome opens now – please sign in to SAC once.");
spawnSync(process.execPath, [join(root, "scripts", "login.mjs")], { cwd: root, stdio: "inherit" });

// Claude Desktop does not see the shell PATH (e.g. Homebrew's node), so the absolute node path is written
// prefer the stable link over the versioned Homebrew path (…/Cellar/node/<version>/…), which breaks on node updates
const nodePath = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].find((p) => existsSync(p)) ?? process.execPath;
const entry = { command: nodePath, args: [join(root, "build", "index.js")] };
if (register && desktopConfig) {
  const existing = existsSync(desktopConfig) ? JSON.parse(readFileSync(desktopConfig, "utf8")) : {};
  if (existsSync(desktopConfig)) copyFileSync(desktopConfig, `${desktopConfig}.bak`);
  existing.mcpServers = { ...(existing.mcpServers ?? {}), sac: entry };
  mkdirSync(dirname(desktopConfig), { recursive: true });
  writeFileSync(desktopConfig, JSON.stringify(existing, null, 2) + "\n");
  console.log(`\nRegistered in Claude Desktop (${desktopConfig}, backup: .bak). Please restart Claude Desktop.`);
} else {
  console.log("\nFor Claude Desktop add this to claude_desktop_config.json under mcpServers:");
  console.log(JSON.stringify({ sac: entry }, null, 2));
}
console.log(`
Notes:
- For Data Analyzer insights on Datasphere, sign in to Datasphere once in the server's Chrome
  and tick "Stay signed in" (otherwise the login is gone after a restart).
- Sign in again later: ${installed ? "sac-workbench-mcp login" : "npm run login"}`);
