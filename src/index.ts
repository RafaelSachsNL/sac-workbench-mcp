#!/usr/bin/env node

/**
 * SAP Analytics Cloud — MCP Server
 *
 * Entry point.  Boots the MCP server over stdio transport,
 * registers all tool and resource handlers, then listens.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/index.js";
import { withSafeParamNames } from "./tools/_param-names.js";
import { registerResources } from "./resources/index.js";
import { registerPrompts } from "./prompts/index.js";
import { readFileSync } from "node:fs";

// ── Server metadata ────────────────────────────────────────────────
const SERVER_NAME = "sac-workbench-mcp";
const SERVER_VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// `sac-workbench-mcp setup` / `login`: the npm-installed command runs the setup scripts instead of the server
const COMMANDS: Record<string, string> = { setup: "../scripts/setup.mjs", login: "../scripts/login.mjs" };

async function main(): Promise<void> {
  // 1. Create the MCP server instance
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  // 2. Register tool handlers  (src/tools/index.ts)
  registerTools(withSafeParamNames(server));


  // 3. Register resource handlers  (src/resources/index.ts)
  registerResources(server);

  // 4. Register prompt templates (src/prompts/index.ts)
  registerPrompts(server);

  // 4. Connect via stdio transport (the standard for local MCP servers)
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The server is now running — the SDK handles the JSON-RPC loop.
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

const command = COMMANDS[process.argv[2] ?? ""];
(command ? import(new URL(command, import.meta.url).href).then(() => undefined) : main()).catch((error) => {
  console.error("Fatal error starting MCP server:", error);
  process.exit(1);
});
