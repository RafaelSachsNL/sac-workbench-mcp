/**
 * "Hack" tools — everything beyond the documented REST API:
 *   - raw requests against any endpoint (OAuth session or logged-in browser session)
 *   - SAC internal content library (/sap/fpa/services/rest/epm/contentlib)
 *   - record & replay of the SAC UI's own XHR traffic
 *   - JS evaluation inside the SAC page (UI5 / FPA runtime)
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { oauthConfigured, sacRaw, type RawResponse } from "../auth/sac-client.js";
import { browser, BrowserSession, type CapturedCall } from "../browser/session.js";
import { assertWritable, config } from "../config.js";
import { ALTERATION_MSG, getConfig, toolError, toolSuccess } from "./_helpers.js";


const allowalteration = z.boolean().optional().describe("Must be true for anything that changes data");

function truncate(data: unknown, max = config.maxOutputChars) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return text.length > max ? text.slice(0, max) + `\n…[truncated, ${text.length} chars total]` : text;
}

const KEEP_HEADERS = /^(content-type|location|x-csrf-token|content-disposition|x-sap-.*error.*|retry-after)$/i;

/** Drop the noisy infrastructure headers from a response unless the caller wants them. */
function compact(res: RawResponse, allHeaders = false): RawResponse {
  if (allHeaders) return res;
  return { ...res, headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => KEEP_HEADERS.test(k))) };
}

function withQuery(path: string, query?: Record<string, string>) {
  if (!query || Object.keys(query).length === 0) return path;
  const qs = new URLSearchParams(query).toString();
  return path + (path.includes("?") ? "&" : "?") + qs;
}

function isReadAction(action: string) {
  return /^(get|find|search|list|check|read|is|has|load|fetch|resolve)/i.test(action);
}

function captureSummary(c: CapturedCall) {
  let action: string | undefined;
  try {
    const j = JSON.parse(c.postData ?? "");
    action = j?.action ?? j?.Analytics?.Actions?.[0]?.Type ?? (j?.Metadata ? "InA:Metadata" : j?.Analytics ? "InA:Analytics" : undefined);
  } catch {
    /* not json */
  }
  const u = new URL(c.url);
  return {
    index: c.index,
    method: c.method,
    path: u.pathname + (u.search.length > 120 ? u.search.slice(0, 120) + "…" : u.search),
    action,
    status: c.status,
    requestBytes: c.postData?.length ?? 0,
    responseBytes: c.responseBody?.length ?? 0,
  };
}

function loadSaved(name: string): CapturedCall[] {
  return JSON.parse(readFileSync(join(config.captureDir, `${name.replace(/[^\w.-]/g, "_")}.json`), "utf8")).calls;
}

function applyReplacements(s: string, reps: { from: string; to: string; regex?: boolean }[]) {
  return reps.reduce((acc, r) => (r.regex ? acc.replace(new RegExp(r.from, "g"), r.to) : acc.split(r.from).join(r.to)), s);
}

export function registerHackTools(server: McpServer): void {
  // ── Browser session ──────────────────────────────────────────────

  server.tool(
    "sac_browser_login",
    `Open a Chrome window (persistent profile) on the SAC tenant ${config.sacUrl} and wait until the user has completed SSO login.
Required once before any via="browser" call, contentlib, capture/replay or eval. The profile is reused, so later starts usually skip the login.`,
    {
      timeoutSeconds: z.number().optional().default(300).describe("How long to wait for the user to log in"),
      headless: z.boolean().optional().default(false).describe("Headless only works once the profile has a valid session"),
    },
    async ({ timeoutSeconds, headless }) => {
      try {
        await browser.ensureLoggedIn({ headless, timeoutMs: timeoutSeconds * 1000 });
        return toolSuccess(browser.status());
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool("sac_browser_status", "State of the browser session (login, tenant id, CSRF, capture).", {}, async () =>
    toolSuccess(browser.status()),
  );

  server.tool("sac_browser_close", "Close the browser session (profile/login is kept on disk).", {}, async () => {
    await browser.close();
    return toolSuccess({ closed: true });
  });

  // ── Raw request ──────────────────────────────────────────────────

  server.tool(
    "sac_api_request",
    `Send an arbitrary HTTP request to the SAC tenant — documented or undocumented endpoints.
via="oauth": Bearer token of the OAuth client (works for /api/v1/...).
via="browser": executed inside the logged-in SAC page (works for internal /sap/fpa/services/..., /sap/bc/ina/..., and /api/v1/... with user rights).
CSRF tokens and cookies are handled automatically. Non-GET requests require allowalteration=true.`,
    {
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).describe("HTTP method"),
      path: z.string().describe("Path relative to the tenant, e.g. /api/v1/stories or /sap/fpa/services/rest/epm/contentlib"),
      query: z.record(z.string(), z.string()).optional().describe("Query parameters"),
      body: z.unknown().optional().describe("Request body: JSON object/array, or a string (e.g. CSV)"),
      contentType: z.string().optional().describe("Content-Type override, e.g. text/csv"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
      via: z.enum(["oauth", "browser"]).optional().describe("Default: oauth if an OAuth client is configured, else browser"),
      maxChars: z.number().optional().describe("Truncate the response output"),
      allHeaders: z.boolean().optional().describe("Return all response headers (default: only the relevant ones)"),
      allowalteration,
    },
    async ({ method, path, query, body, contentType, headers, via, maxChars, allHeaders, allowalteration }) => {
      const mutating = !["GET", "HEAD"].includes(method);
      if (mutating && !allowalteration) return toolError(ALTERATION_MSG);
      try {
        if (mutating) assertWritable(`${method} ${path}`);
        const p = withQuery(path, query);
        const res =
          (via ?? (oauthConfigured() ? "oauth" : "browser")) === "browser"
            ? await browser.request(method, p, body, contentType, headers)
            : await sacRaw(getConfig(), method, p, body, contentType, headers);
        return toolSuccess(truncate(compact(res, allHeaders), maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── Internal content library ─────────────────────────────────────

  server.tool(
    "sac_contentlib",
    `Call SAC's internal content library service (POST /sap/fpa/services/rest/epm/contentlib?tenant=<id>) via the browser session.
This is what the Files area of the SAC UI uses: browse folders, read/write resource metadata and content, copy, move, share, delete.
Body is {action, data}. Payload shapes are undocumented — use sac_capture_* while doing the action in the UI to learn the exact shape, then call it here.
Actions starting with get/find/search/list/check/read/load are treated as read-only; all others require allowalteration=true.`,
    {
      action: z.string().describe("contentlib action, e.g. getResourceEx, findResources, getContent, updateContent, copyResource, moveResource, deleteResource"),
      data: z.unknown().optional().describe("The 'data' part of the payload"),
      extra: z.record(z.string(), z.unknown()).optional().describe("Additional top-level payload fields besides action/data"),
      maxChars: z.number().optional(),
      allowalteration,
    },
    async ({ action, data, extra, maxChars, allowalteration }) => {
      const read = isReadAction(action);
      if (!read && !allowalteration) return toolError(ALTERATION_MSG);
      try {
        if (!read) assertWritable(`contentlib ${action}`);
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const tenant = browser.tenantId;
        if (!tenant) throw new Error("Internal tenant id unknown — set SAC_TENANT_ID or open any story in the browser once.");
        const res = await browser.request("POST", `/sap/fpa/services/rest/epm/contentlib?tenant=${encodeURIComponent(tenant)}`, {
          action,
          data: data ?? {},
          ...extra,
        });
        return toolSuccess(truncate(compact(res), maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── Record & replay ──────────────────────────────────────────────

  server.tool(
    "sac_capture_start",
    `Start recording the SAC UI's XHR/fetch traffic in the browser session. Then perform the action in the SAC window
(e.g. save a story, enter planning data, publish a version, create a folder) and call sac_capture_stop.
Default filter: /sap/fpa/services, /api/v1, /sap/bc/ina.`,
    {
      urlFilter: z.string().optional().describe("Regex the request URL must match"),
      clear: z.boolean().optional().default(true).describe("Discard previously captured calls"),
    },
    async ({ urlFilter, clear }) => {
      try {
        browser.startCapture(urlFilter, clear);
        return toolSuccess({ capturing: true, hint: "Perform the action in the SAC window now, then call sac_capture_stop." });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool("sac_capture_stop", "Stop recording and return a summary of the captured calls.", {
    onlyMutating: z.boolean().optional().default(false).describe("Only show non-GET calls"),
  }, async ({ onlyMutating }) => {
    browser.stopCapture();
    const calls = browser.captured.filter((c) => !onlyMutating || c.method !== "GET").map(captureSummary);
    return toolSuccess(truncate({ total: browser.captured.length, calls }));
  });

  server.tool(
    "sac_capture_list",
    "List captured calls (current recording, or a saved capture by name).",
    {
      name: z.string().optional().describe("Saved capture name; omit for the current recording"),
      onlyMutating: z.boolean().optional().default(false),
      pathFilter: z.string().optional().describe("Regex on the URL"),
    },
    async ({ name, onlyMutating, pathFilter }) => {
      try {
        const calls = name ? loadSaved(name) : browser.captured;
        const re = pathFilter ? new RegExp(pathFilter, "i") : undefined;
        return toolSuccess(
          truncate(calls.filter((c) => (!onlyMutating || c.method !== "GET") && (!re || re.test(c.url))).map(captureSummary)),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_capture_get",
    "Full details (URL, headers, request payload, response) of one captured call.",
    {
      index: z.number().describe("Call index from sac_capture_list"),
      name: z.string().optional().describe("Saved capture name; omit for the current recording"),
      maxChars: z.number().optional(),
    },
    async ({ index, name, maxChars }) => {
      try {
        const call = (name ? loadSaved(name) : browser.captured).find((c) => c.index === index);
        if (!call) throw new Error(`No captured call with index ${index}`);
        let postData: unknown = call.postData;
        let responseBody: unknown = call.responseBody;
        try { postData = JSON.parse(call.postData ?? ""); } catch { /* raw */ }
        try { responseBody = JSON.parse(call.responseBody ?? ""); } catch { /* raw */ }
        return toolSuccess(truncate({ ...call, postData, responseBody }, maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_capture_save",
    "Save captured calls to <capture folder>/<name>.json (captures/ in the repo, ~/.sac-mcp/captures when installed from npm) so they can be replayed in later sessions.",
    {
      name: z.string().describe("Name, e.g. 'create_folder' or 'planning_data_entry'"),
      indices: z.array(z.number()).optional().describe("Subset of call indices; default all"),
      description: z.string().optional(),
    },
    async ({ name, indices, description }) => {
      try {
        mkdirSync(config.captureDir, { recursive: true });
        const calls = indices ? browser.captured.filter((c) => indices.includes(c.index)) : browser.captured;
        const file = join(config.captureDir, `${name.replace(/[^\w.-]/g, "_")}.json`);
        writeFileSync(file, JSON.stringify({ name, description, savedAt: new Date().toISOString(), calls }, null, 2));
        return toolSuccess({ saved: file, calls: calls.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool("sac_capture_saved", "List saved captures.", {}, async () => {
    try {
      mkdirSync(config.captureDir, { recursive: true });
      const items = readdirSync(config.captureDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const j = JSON.parse(readFileSync(join(config.captureDir, f), "utf8"));
          return { name: j.name, description: j.description, savedAt: j.savedAt, calls: j.calls?.length };
        });
      return toolSuccess(items);
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool(
    "sac_replay",
    `Replay a captured call through the browser session, optionally modified. Use this to repeat any UI action
(e.g. enter a different planning value, rename a different resource) after recording it once.
Modifications: 'replacements' (string or regex substitutions applied to URL and payload) and/or 'body' (full payload override).
Session-bound headers (cookies, CSRF) are refreshed automatically.`,
    {
      index: z.number().describe("Call index"),
      name: z.string().optional().describe("Saved capture name; omit for the current recording"),
      replacements: z
        .array(z.object({ from: z.string(), to: z.string(), regex: z.boolean().optional() }))
        .optional()
        .describe("Substitutions applied to URL and payload"),
      body: z.unknown().optional().describe("Replace the payload completely (object → JSON)"),
      maxChars: z.number().optional(),
      allowalteration,
    },
    async ({ index, name, replacements, body, maxChars, allowalteration }) => {
      try {
        const call = (name ? loadSaved(name) : browser.captured).find((c) => c.index === index);
        if (!call) throw new Error(`No captured call with index ${index}`);
        // InA / contentlib reads are POSTs too; treat everything non-GET as potentially mutating.
        if (call.method !== "GET" && !allowalteration) return toolError(ALTERATION_MSG);
        if (call.method !== "GET") assertWritable(`replay ${call.method} ${call.url}`);
        const reps = replacements ?? [];
        const url = applyReplacements(call.url, reps);
        const payload = body !== undefined ? body : call.postData !== undefined ? applyReplacements(call.postData, reps) : undefined;
        const headers = BrowserSession.replayHeaders(call.requestHeaders);
        const contentType = headers["content-type"];
        delete headers["content-type"];
        const res = await browser.request(call.method, url, payload, contentType, headers);
        return toolSuccess(truncate({ replayed: { method: call.method, url }, response: compact(res) }, maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── UI automation ────────────────────────────────────────────────

  server.tool(
    "sac_browser_screenshot",
    "Screenshot of the active SAC tab (coordinates in the image = CSS pixels for sac_browser_ui clicks).",
    { fullPage: z.boolean().optional().default(false) },
    async ({ fullPage }) => {
      try {
        const shot = await browser.screenshot(fullPage);
        return {
          content: [
            { type: "image" as const, data: shot.png.toString("base64"), mimeType: "image/png" },
            { type: "text" as const, text: JSON.stringify({ url: shot.url, width: shot.width, height: shot.height }) },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_browser_ui",
    `Drive the SAC UI in the browser session for things that have no API (e.g. building a story, adding widgets).
Target by visible text, CSS selector, or x/y from sac_browser_screenshot. Combine with sac_capture_* to record what the UI sends,
then turn it into an API call via sac_replay/sac_contentlib. Actions may change data, so allowalteration=true is required.`,
    {
      steps: z
        .array(
          z.object({
            kind: z.enum(["click", "double_click", "right_click", "type", "press", "goto", "hover", "scroll", "wait", "close_tab", "viewport"]).describe("viewport: value '390x844' (phone), '768x1024' or 'reset'"),
            text: z.string().optional().describe("Visible text to target (click/hover) or wait for"),
            exact: z.boolean().optional(),
            selector: z.string().optional().describe("CSS/Playwright selector"),
            x: z.number().optional(),
            y: z.number().optional(),
            value: z.string().optional().describe("Text to type, key to press (e.g. Enter, Control+S), or scroll delta"),
            url: z.string().optional().describe("For goto: absolute URL or tenant-relative path"),
            ms: z.number().optional().describe("For wait: milliseconds / timeout"),
          }),
        )
        .describe("Steps executed in order; stops at the first failure"),
      screenshot: z.boolean().optional().default(true).describe("Return a screenshot after the steps"),
      allowalteration,
    },
    async ({ steps, screenshot, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      const log: string[] = [];
      let error: string | undefined;
      try {
        assertWritable("browser UI automation");
        for (const [i, st] of steps.entries()) {
          try {
            await browser.ui(st);
            log.push(`${i}: ${st.kind} ok`);
          } catch (e) {
            error = `${i}: ${st.kind} failed: ${e instanceof Error ? e.message.split("\n")[0] : e}`;
            log.push(error);
            break;
          }
        }
        const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
          { type: "text", text: log.join("\n") },
        ];
        if (screenshot) {
          const shot = await browser.screenshot();
          content.push({ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" });
          content.push({ type: "text", text: JSON.stringify({ url: shot.url, width: shot.width, height: shot.height }) });
        }
        return { content, isError: Boolean(error) };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ── JS evaluation in the SAC page ────────────────────────────────

  server.tool(
    "sac_browser_eval",
    `Evaluate JavaScript inside the logged-in SAC page (async allowed, use 'return' for multi-statement code).
Gives access to the UI5/FPA runtime (window.sap, sap.ui.getCore(), …) for exploring internals. Requires allowalteration=true
because arbitrary code can change data.`,
    {
      code: z.string().describe("JS expression or function body"),
      maxChars: z.number().optional(),
      allowalteration,
    },
    async ({ code, maxChars, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("browser eval");
        return toolSuccess(truncate(await browser.evaluate(code), maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
