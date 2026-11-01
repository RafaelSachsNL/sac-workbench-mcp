/**
 * Claude only accepts tool parameter names matching ^[a-zA-Z0-9_.-]{1,64}$. The official SAC APIs use OData names like
 * $top / $filter / $select, which made those tools disappear in Claude. Tool registration is wrapped once: "$top"
 * is offered as "top" (or "odata_top" if "top" exists) and translated back before the tool's own handler runs.
 *
 * The same wrapper enforces readOnly for every tool: a call with allowalteration=true is refused before the tool runs,
 * so no write tool depends on calling assertWritable() itself.
 *
 * Expert tools (raw JS in the SAC page, any API path, replaying recorded calls) are only registered with expertTools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const VALID = /^[a-zA-Z0-9_.-]{1,64}$/;

export const EXPERT_TOOLS = new Set(["sac_browser_eval", "sac_api_request", "sac_replay"]);

function isShape(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every((v: Json) => v && typeof v === "object" && "_def" in v);
}

function readOnlyGuard(name: string, handler: Json) {
  return (input: Json, extra: Json) => {
    if (config.readOnly && input?.allowalteration === true) {
      return { content: [{ type: "text", text: `Blocked: readOnly is set, refusing write operation (${name}).` }], isError: true };
    }
    return handler(input, extra);
  };
}

export function withSafeParamNames(server: McpServer): McpServer {
  const original = (server.tool as Json).bind(server);
  (server as Json).tool = (...args: Json[]) => {
    if (EXPERT_TOOLS.has(String(args[0])) && !config.expertTools) return undefined;
    const shapeIndex = args.findIndex((a, i) => i > 0 && isShape(a));
    const handlerIndex = args.length - 1;
    if (shapeIndex < 0 || typeof args[handlerIndex] !== "function") return original(...args);
    const shape = args[shapeIndex] as Record<string, unknown>;
    const renamed = new Map<string, string>(); // safe → original
    const safeShape: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(shape)) {
      if (VALID.test(key)) {
        safeShape[key] = schema;
        continue;
      }
      const base = key.replace(/^\$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");
      const safe = base in shape || base in safeShape ? `odata_${base}` : base;
      renamed.set(safe, key);
      safeShape[safe] = schema;
    }
    const handler = args[handlerIndex];
    const next = [...args];
    next[shapeIndex] = safeShape;
    next[handlerIndex] = readOnlyGuard(String(args[0]), renamed.size
      ? (input: Json, extra: Json) => {
          const back = Object.fromEntries(Object.entries(input ?? {}).map(([k, v]) => [renamed.get(k) ?? k, v]));
          return handler(back, extra);
        }
      : handler);
    return original(...next);
  };
  return server;
}
