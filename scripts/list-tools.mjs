#!/usr/bin/env node
// Starts the built server over stdio and lists its tools — a smoke check that needs no SAC tenant (used in CI).
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../build/index.js", import.meta.url))], stderr: "ignore" });
const client = new Client({ name: "list-tools", version: "0.0.1" });
await client.connect(transport);
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
console.log(`${tools.length} tools, ${prompts.length} prompts`);
if (tools.length < 100) throw new Error("too few tools registered");
const guide = await client.getPrompt({ name: "story_guidelines" });
if (!guide.messages[0]?.content?.text?.includes("Story guidelines")) throw new Error("story_guidelines prompt is broken");
await client.close();
