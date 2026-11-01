/**
 * Browser session for SAC's *internal* APIs (/sap/fpa/services/..., InA, contentlib).
 *
 * These endpoints are what the SAC web UI itself talks to. They are undocumented and do not
 * accept the OAuth client-credential token, but they work with a normal logged-in browser
 * session. We drive a real Chrome (persistent profile, so SSO only has to happen once) and
 * execute requests *inside the page* via fetch(), so cookies, SAML session and CSRF behave
 * exactly like they do for the UI.
 *
 * On top of that, the session can record the UI's own XHR traffic ("capture") so any action a
 * user can click in SAC can be inspected and replayed with modified parameters.
 */

import { mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Page, type Request } from "playwright-core";
import { config, requireUrl } from "../config.js";
import type { RawResponse } from "../auth/sac-client.js";

export interface CapturedCall {
  index: number;
  time: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
}

const DEFAULT_CAPTURE_FILTER = /\/(sap\/fpa\/services|api\/v1|sap\/bc\/ina|sap\/fpa\/ui\/.*\/rest)\b/i;
const MAX_CAPTURED_BODY = 200_000;
// Headers that are session-specific or set by the browser; never replayed.
const DROP_HEADERS = /^(cookie|set-cookie|authorization|x-xsrf-token|x-csrf-token|host|content-length|connection|origin|referer|user-agent|accept-encoding|sec-|:)/i;

// Session secrets are never stored in captures (memory or disk); replay re-attaches fresh ones.
const SECRET_HEADERS = /^(cookie|set-cookie|authorization|x-csrf-token|x-xsrf-token|proxy-authorization)$/i;

function redact(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_HEADERS.test(k) ? "[redacted]" : v]));
}

type CsrfScope = "api" | "fpa";

function csrfScope(url: string): CsrfScope {
  return /\/api\/v1\//.test(url) ? "api" : "fpa";
}

class BrowserSession {
  private ctx?: BrowserContext;
  private page?: Page;
  /** CSRF tokens per backend: /api/v1 (public REST) and the internal FPA services use different ones. */
  private csrf = new Map<CsrfScope, string>();
  private detectedTenant?: string;
  private capturing = false;
  private captureFilter: RegExp = DEFAULT_CAPTURE_FILTER;
  private pending = new Map<Request, CapturedCall>();
  private popups = new WeakSet<Page>();
  captured: CapturedCall[] = [];

  get running() {
    return Boolean(this.ctx);
  }

  get tenantId(): string | undefined {
    return config.tenantId ?? this.detectedTenant;
  }

  status() {
    return {
      running: this.running,
      url: this.page?.url(),
      loggedIn: this.isLoggedIn(),
      tenantId: this.tenantId,
      haveCsrf: { api: this.csrf.has("api"), fpa: this.csrf.has("fpa") },
      capturing: this.capturing,
      capturedCalls: this.captured.length,
      profileDir: config.browserProfile,
    };
  }

  private isLoggedIn(): boolean {
    const url = this.page?.url() ?? "";
    return url.startsWith(config.sacUrl ?? "\0") && /\/sap\/fpa\/ui\//.test(url);
  }

  private tenantFromServices = false;

  /**
   * Internal FPA services take the tenant *UUID* as ?tenant=<uuid> — that is what the UI sends and what
   * contentlib needs. The short id in UI URLs (/tenants/6c7d6/...) is only a fallback.
   */
  private sniffTenant(url: string) {
    if (this.tenantFromServices) return;
    const q = /\/sap\/fpa\/services\//.test(url) ? url.match(/[?&]tenant=([^&#]+)/) : null;
    if (q) {
      this.detectedTenant = decodeURIComponent(q[1]);
      this.tenantFromServices = true;
      return;
    }
    const p = url.match(/\/tenants\/([^/?#]+)/);
    if (p && !this.detectedTenant) this.detectedTenant = decodeURIComponent(p[1]);
  }

  async start(headless: boolean): Promise<void> {
    if (this.ctx) return;
    const base = requireUrl();
    mkdirSync(config.browserProfile, { recursive: true });
    this.ctx = await chromium.launchPersistentContext(config.browserProfile, {
      channel: config.browserChannel,
      headless,
      viewport: null,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    this.ctx.on("close", () => {
      this.ctx = undefined;
      this.page = undefined;
      this.csrf.clear();
    });

    this.ctx.on("page", (p) => {
      p.opener().then((o) => o && this.popups.add(p)).catch(() => undefined);
    });
    this.ctx.on("request", (req) => {
      const url = req.url();
      if (!url.startsWith(base)) return;
      this.sniffTenant(url);
      const token = req.headers()["x-csrf-token"];
      if (token && token.toLowerCase() !== "fetch") this.csrf.set(csrfScope(url), token);
      if (this.capturing && ["xhr", "fetch"].includes(req.resourceType()) && this.captureFilter.test(url)) {
        const call: CapturedCall = {
          index: this.captured.length,
          time: new Date().toISOString(),
          method: req.method(),
          url,
          requestHeaders: redact(req.headers()),
          postData: req.postData() ?? undefined,
        };
        this.captured.push(call);
        this.pending.set(req, call);
      }
    });

    this.ctx.on("response", async (res) => {
      const token = res.headers()["x-csrf-token"];
      if (token && !["required", "fetch"].includes(token.toLowerCase()) && res.url().startsWith(base))
        this.csrf.set(csrfScope(res.url()), token);
      const call = this.pending.get(res.request());
      if (!call) return;
      this.pending.delete(res.request());
      call.status = res.status();
      call.responseHeaders = redact(res.headers());
      try {
        const text = await res.text();
        call.responseBody = text.length > MAX_CAPTURED_BODY ? text.slice(0, MAX_CAPTURED_BODY) + "\n…[truncated]" : text;
      } catch {
        call.responseBody = "[body unavailable]";
      }
    });

    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    await this.page.goto(base + "/sap/fpa/ui/app.html", { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  /** Start (if needed) and wait until the user is logged into SAC. */
  async ensureLoggedIn(opts: { headless: boolean; timeoutMs: number }): Promise<void> {
    await this.start(opts.headless);
    const deadline = Date.now() + opts.timeoutMs;
    while (!this.isLoggedIn()) {
      if (Date.now() > deadline)
        throw new Error(
          `Not logged into SAC within ${Math.round(opts.timeoutMs / 1000)}s (current URL: ${this.page?.url()}). ` +
            `Run sac_browser_login (opens a visible Chrome window) and complete the SSO login.`,
        );
      await new Promise((r) => setTimeout(r, 1000));
    }
    // The UI reveals the tenant UUID with its first FPA service call; give it a moment after login.
    for (let i = 0; i < 40 && !this.tenantFromServices && !config.tenantId; i++) await new Promise((r) => setTimeout(r, 500));
    if (!this.detectedTenant) this.sniffTenant(this.page!.url());
  }

  /**
   * The SAC session times out after inactivity: services then answer with the approuter's HTML auth page.
   * Reload the app; on "Session Ended" press Log On — SSO signs in again with the profile's IdP session.
   */
  async relogin(timeoutMs = 60_000): Promise<void> {
    const page = this.page!;
    this.csrf.clear();
    await page.goto(requireUrl() + "/sap/fpa/ui/app.html#/home", { waitUntil: "domcontentloaded" });
    const logOn = page.getByText("Log On", { exact: true });
    if (await logOn.isVisible({ timeout: 8_000 }).catch(() => false)) await logOn.click();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const probe = await this.inPageFetch("GET", requireUrl() + "/api/v1/csrf", undefined, { "x-csrf-token": "fetch" }).catch(() => undefined);
      if (probe && !isAuthPage(probe) && probe.status < 400) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error("SAC session expired and the automatic re-login did not succeed — run sac_browser_login");
  }

  async close() {
    await this.ctx?.close();
  }

  private async inPageFetch(
    method: string,
    url: string,
    body: string | undefined,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    const timeoutMs = Number(process.env.SAC_REQUEST_TIMEOUT_MS ?? 120_000);
    const run = () =>
      this.page!.evaluate(
        async ({ method, url, body, headers, timeoutMs }) => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          try {
            const r = await fetch(url, { method, body, headers, credentials: "include", signal: ctrl.signal });
            const h: Record<string, string> = {};
            r.headers.forEach((v, k) => (h[k] = v));
            return { status: r.status, headers: h, body: (await r.text()) as unknown };
          } finally {
            clearTimeout(timer);
          }
        },
        { method, url, body, headers, timeoutMs },
      );
    try {
      return await run();
    } catch (e) {
      // the SAC page navigated or reloaded underneath us: the evaluate never ran (context destroyed) → safe to repeat;
      // "Failed to fetch" / abort may have reached the server → only reads are repeated
      const msg = String(e);
      const notSent = /Execution context was destroyed|Target page, context or browser has been closed|frame was detached/i.test(msg);
      const read = ["GET", "HEAD"].includes(method);
      if (!notSent && !(read && /Failed to fetch|aborted/i.test(msg))) {
        if (/aborted/i.test(msg)) throw new Error(`SAC did not answer within ${timeoutMs / 1000}s (${method} ${url.split("?")[0]}) — check the result before repeating`);
        if (/Failed to fetch/i.test(msg)) throw new Error(`Connection to SAC broke off (${method} ${url.split("?")[0]}) — the change may or may not have been applied; check before repeating`);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 2000));
      if (!this.page || this.page.isClosed()) await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
      return run();
    }
  }

  private async fetchCsrf(scope: CsrfScope): Promise<void> {
    const url = requireUrl() + (scope === "api" ? "/api/v1/csrf" : "/sap/fpa/services/rest/epm/session");
    const res = await this.inPageFetch("GET", url, undefined, { "x-csrf-token": "fetch", "X-Requested-With": "XMLHttpRequest" });
    const t = res.headers["x-csrf-token"];
    if (t && t.toLowerCase() !== "required") this.csrf.set(scope, t);
  }

  /** Execute a request inside the logged-in SAC page. */
  async request(
    method: string,
    path: string,
    body?: unknown,
    contentType?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<RawResponse> {
    await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
    const m = method.toUpperCase();
    const url = path.startsWith("http") ? path : requireUrl() + (path.startsWith("/") ? path : "/" + path);
    const data = body === undefined || body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const mutating = !["GET", "HEAD"].includes(m);
    const scope = csrfScope(url);

    const send = async () => {
      // X-Requested-With: some contentlib actions (e.g. getRepoView) answer 403 without it, like the UI's own XHRs.
      const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        ...extraHeaders,
      };
      if (data !== undefined) headers["Content-Type"] ??= contentType ?? (typeof body === "string" ? "text/plain" : "application/json;charset=UTF-8");
      if (mutating) {
        if (!this.csrf.has(scope)) await this.fetchCsrf(scope);
        const token = this.csrf.get(scope);
        if (token) headers["X-CSRF-Token"] = token;
      }
      return this.inPageFetch(m, url, data, headers);
    };

    let res = await send();
    if (isAuthPage(res)) {
      await this.relogin();
      res = await send();
    }
    if (mutating && res.status === 403) {
      this.csrf.delete(scope);
      res = await send();
    }
    const text = res.body as string;
    let parsed: unknown = text;
    if ((res.headers["content-type"] ?? "").includes("json") || /^\s*[\[{]/.test(text)) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep text */
      }
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  /** Evaluate arbitrary JS in the SAC page (access to sap.* UI5/FPA runtime objects). */
  async evaluate(expression: string): Promise<unknown> {
    await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
    return this.page!.evaluate(async (src) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (async () => { ${src.includes("return") ? src : "return (" + src + ")"} })()`);
      const v = await fn();
      try {
        return JSON.parse(JSON.stringify(v ?? null));
      } catch {
        return String(v);
      }
    }, expression);
  }

  // ── UI automation (for things that have no API at all, e.g. building a story) ──

  /** The most recently opened SAC tab (stories may open in a new tab). */
  private activePage(): Page {
    // only SAC tabs and popups SAC opened (e.g. SSO); tabs someone opens by hand in this window are left alone
    const ours = (this.ctx?.pages() ?? []).filter((p) => p.url().startsWith(config.sacUrl ?? "\0") || this.popups.has(p));
    const page = ours[ours.length - 1] ?? this.page;
    if (!page) throw new Error("Browser not running — call sac_browser_login first.");
    return page;
  }

  /**
   * Open a story in view mode and collect what goes wrong at runtime: script errors (console), uncaught page errors and
   * the error/warning notifications SAC shows. Resolves after the page has been quiet for `quietMs` or `timeoutMs`.
   */
  async runStory(storyId: string, opts: { mode?: "view" | "edit" | "present"; timeoutMs?: number; quietMs?: number } = {}): Promise<{
    console: { type: string; text: string }[];
    pageErrors: string[];
    notifications: string[];
    loadMs: number;
  }> {
    await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
    const page = this.activePage();
    const consoleMsgs: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    let lastActivity = Date.now();
    const onConsole = (m: { type(): string; text(): string }) => {
      if (m.type() === "error" || m.type() === "warning" || /script/i.test(m.text())) consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 1000) });
    };
    const onError = (e: Error) => pageErrors.push(String(e?.message ?? e).slice(0, 1000));
    const onResponse = () => (lastActivity = Date.now());
    page.on("console", onConsole);
    page.on("pageerror", onError);
    page.on("response", onResponse);
    const t0 = Date.now();
    try {
      await page.goto(requireUrl() + "/sap/fpa/ui/app.html#/home", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      // the app survives the hash change, and so do the message strips of stories checked before → close them
      // (a reload instead adds boot noise and cancels the home page's queries)
      await page
        .evaluate(() => {
          const sel = '[role="alert"], .sapMMessageStrip, .sapMMessageToast, [class*="MessageStrip"], [class*="Toast"]';
          document.querySelectorAll(sel).forEach((e) => {
            (e.querySelector('[aria-label="Close"], [title="Close"], button') as HTMLElement | null)?.click();
            e.remove();
          });
        })
        .catch(() => undefined);
      consoleMsgs.length = 0;
      pageErrors.length = 0;
      await page.goto(`${requireUrl()}/sap/fpa/ui/app.html#/story2&/s2/${storyId}/?mode=${opts.mode ?? "view"}`, { waitUntil: "domcontentloaded" });
      const timeout = opts.timeoutMs ?? 120_000;
      const quiet = opts.quietMs ?? 8_000;
      lastActivity = Date.now();
      while (Date.now() - t0 < timeout && Date.now() - lastActivity < quiet) await page.waitForTimeout(500);
      const notifications = await page
        .evaluate(() =>
          [...document.querySelectorAll('[role="alert"], .sapMMessageStrip, .sapMMessageToast, [class*="MessageStrip"], [class*="Toast"]')]
            .map((e) => (e as HTMLElement).innerText.trim())
            .filter(Boolean),
        )
        .catch(() => [] as string[]);
      return { console: consoleMsgs, pageErrors, notifications: [...new Set(notifications)], loadMs: lastActivity - t0 };
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onError);
      page.off("response", onResponse);
    }
  }

  /**
   * Layout check of a story at given widths: containers that show a scrollbar (content larger than the box with
   * overflow auto/scroll — such scrollbars are otherwise only found by eye), widgets sticking out
   * of their parent widget, plus the runtime errors of runStory. Optionally a PNG of one widget (with hover).
   */
  async inspectStory(
    storyId: string,
    opts: { widths: number[]; height?: number; mode?: "view" | "present"; widget?: string; hover?: boolean },
  ): Promise<{ width: number; issues: { widgetId: string; kind: string; detail: string }[]; errors: unknown; png?: Buffer }[]> {
    const page = () => this.activePage();
    const out = [];
    for (const width of opts.widths) {
      await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
      await page().setViewportSize({ width, height: opts.height ?? 900 });
      const run = await this.runStory(storyId, { mode: opts.mode ?? "view" });
      // lazy widgets render only near the viewport: scroll through the page once
      await page().evaluate(async () => {
        const sc = [...document.querySelectorAll<HTMLElement>("*")].filter((e) => e.scrollHeight > e.clientHeight + 50 && /auto|scroll/.test(getComputedStyle(e).overflowY));
        for (const e of sc) for (let y = 0; y <= e.scrollHeight; y += e.clientHeight / 2) { e.scrollTop = y; await new Promise((r) => setTimeout(r, 150)); }
        for (const e of sc) e.scrollTop = 0;
      });
      await page().waitForTimeout(1500);
      const issues = await page().evaluate(() => {
        const found: { widgetId: string; kind: string; detail: string }[] = [];
        const widgets = [...document.querySelectorAll<HTMLElement>("[data-sap-widget-id]")];
        const owner = (e: Element) => e.closest<HTMLElement>("[data-sap-widget-id]")?.getAttribute("data-sap-widget-id") ?? "";
        // the page's own scroll container is meant to scroll
        const pageScroller = (e: HTMLElement) => !e.closest("[data-sap-widget-id]") || e.getBoundingClientRect().height > window.innerHeight * 0.8;
        for (const w of widgets) {
          for (const e of [w, ...w.querySelectorAll<HTMLElement>("div")]) {
            if (owner(e) !== w.getAttribute("data-sap-widget-id")) continue;
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height || cs.visibility === "hidden") continue;
            const barY = /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 1 && e.offsetWidth - e.clientWidth > 0;
            const barX = /auto|scroll/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 1 && e.offsetHeight - e.clientHeight > 0;
            if ((barY || barX) && !pageScroller(e))
              found.push({
                widgetId: w.getAttribute("data-sap-widget-id")!,
                kind: barY ? "scrollbar-y" : "scrollbar-x",
                detail: barY ? `content ${e.scrollHeight}px in ${e.clientHeight}px (bar ${e.offsetWidth - e.clientWidth}px)` : `content ${e.scrollWidth}px in ${e.clientWidth}px`,
              });
          }
          const parent = w.parentElement?.closest<HTMLElement>("[data-sap-widget-id]");
          if (parent) {
            const a = w.getBoundingClientRect();
            const b = parent.getBoundingClientRect();
            // inside a scrolling area of the parent (e.g. a scrolling body) content may lie outside the visible box
            let scrollX = false;
            let scrollY = false;
            for (let e: HTMLElement | null = w.parentElement; e && e !== parent; e = e.parentElement) {
              const cs = getComputedStyle(e);
              scrollX ||= /auto|scroll/.test(cs.overflowX);
              scrollY ||= /auto|scroll/.test(cs.overflowY);
            }
            const over = Math.max(scrollX ? 0 : Math.max(b.left - a.left, a.right - b.right), scrollY ? 0 : Math.max(b.top - a.top, a.bottom - b.bottom));
            if (a.width && a.height && over > 1)
              found.push({ widgetId: w.getAttribute("data-sap-widget-id")!, kind: "overhang", detail: `${Math.round(over)}px outside ${parent.getAttribute("data-sap-widget-id")}` });
          }
        }
        // one entry per widget and kind
        return found.filter((f, i) => found.findIndex((g) => g.widgetId === f.widgetId && g.kind === f.kind) === i);
      });
      let png: Buffer | undefined;
      if (opts.widget) {
        const el = page().locator(`[data-sap-widget-id="${opts.widget}"]`).first();
        await el.scrollIntoViewIfNeeded().catch(() => undefined);
        if (opts.hover) await el.hover().catch(() => undefined);
        await page().waitForTimeout(600);
        png = await el.screenshot().catch(() => undefined);
      }
      out.push({ width, issues, errors: { console: run.console.filter((m) => m.type === "error" && !/marked as dirty during load/.test(m.text)), pageErrors: run.pageErrors, notifications: run.notifications }, png });
    }
    await page().setViewportSize({ width: 1362, height: 762 });
    return out;
  }

  async screenshot(fullPage = false): Promise<{ png: Buffer; url: string; width: number; height: number }> {
    await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
    const page = this.activePage();
    const png = await page.screenshot({ fullPage, scale: "css" });
    const size = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    return { png, url: page.url(), ...size };
  }

  async ui(action: {
    kind: "click" | "double_click" | "right_click" | "type" | "press" | "goto" | "hover" | "scroll" | "wait" | "close_tab" | "viewport";
    x?: number;
    y?: number;
    selector?: string;
    text?: string;
    exact?: boolean;
    value?: string;
    url?: string;
    ms?: number;
  }): Promise<string> {
    await this.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
    const page = this.activePage();
    const target = () => {
      if (action.selector) return page.locator(action.selector).first();
      if (action.text) return page.getByText(action.text, { exact: action.exact ?? false }).first();
      return undefined;
    };
    switch (action.kind) {
      case "goto":
        await page.goto(action.url!.startsWith("http") ? action.url! : requireUrl() + action.url, { waitUntil: "domcontentloaded" });
        break;
      case "click":
      case "double_click":
      case "right_click": {
        const button = action.kind === "right_click" ? "right" : "left";
        const clickCount = action.kind === "double_click" ? 2 : 1;
        const t = target();
        if (t) await t.click({ button, clickCount, timeout: 10_000 });
        else await page.mouse.click(action.x!, action.y!, { button, clickCount });
        break;
      }
      case "hover": {
        const t = target();
        if (t) await t.hover({ timeout: 10_000 });
        else await page.mouse.move(action.x!, action.y!);
        break;
      }
      case "type":
        await page.keyboard.type(action.value ?? "", { delay: 20 });
        break;
      case "press":
        await page.keyboard.press(action.value!);
        break;
      case "scroll":
        await page.mouse.move(action.x ?? 400, action.y ?? 400);
        await page.mouse.wheel(0, Number(action.value ?? 300));
        break;
      case "viewport": {
        // "390x844" (phone), "768x1024" (tablet) or "reset"
        const m = String(action.value ?? "").match(/^(\d+)x(\d+)$/);
        if (m) await page.setViewportSize({ width: Number(m[1]), height: Number(m[2]) });
        else await page.setViewportSize({ width: 1362, height: 762 });
        break;
      }
      case "close_tab":
        // Only popups/secondary tabs; the main SAC tab carries the session.
        if (page !== this.page) await page.close();
        return this.activePage().url();
      case "wait":
        if (action.text) await page.getByText(action.text).first().waitFor({ timeout: action.ms ?? 30_000 });
        else await page.waitForTimeout(action.ms ?? 1000);
        break;
    }
    await page.waitForTimeout(action.kind === "wait" ? 0 : 400);
    return page.url();
  }

  startCapture(filter?: string, clear = true) {
    if (!this.ctx) throw new Error("Browser not running — call sac_browser_login first.");
    if (clear) this.captured = [];
    this.captureFilter = filter ? new RegExp(filter, "i") : DEFAULT_CAPTURE_FILTER;
    this.capturing = true;
  }

  stopCapture() {
    this.capturing = false;
  }

  /** Headers worth replaying (drops session/browser-managed ones). */
  static replayHeaders(h: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(h).filter(([k]) => !DROP_HEADERS.test(k)));
  }
}

export const browser = new BrowserSession();
export { BrowserSession };

function isAuthPage(res: RawResponse): boolean {
  return (res.headers["content-type"] ?? "").includes("text/html") && /approuter\/v1\/(redirect|embedded-auth)/.test(String(res.body));
}
