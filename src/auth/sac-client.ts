import { assertWritable, config } from "../config.js";
import { browser } from "../browser/session.js";
/**
 * SAC API client
 *
 * Handles OAuth 2.0 authentication and all HTTP interactions with the
 * SAP Analytics Cloud REST API, including CSRF token management.
 *
 * Authentication methods supported by SAC (official docs):
 *
 *   1. OAuth 2.0 SAML Bearer Assertion (2-legged)
 *      For apps deployed on SAP BTP using the BTP SDK.
 *      Requires a SAML assertion signed by a Trusted IdP.
 *
 *   2. OAuth 2.0 Client Credentials Grant (2-legged)
 *      For non-browser, technical-user access to the REST API.
 *
 *   3. OAuth 2.0 Authorization Code Grant (3-legged)
 *      For non-browser apps acting on behalf of a named user.
 *
 *   4. Basic Authentication Against the Token Service  ← used here
 *      Simplest option.  Recommended for dev/automation and SCIM.
 *      POST to Token URL with:
 *        URL param:  ?grant_type=client_credentials
 *        Header:     Authorization: Basic Base64(<ClientID>:<Secret>)
 *      Returns:      { access_token, token_type, expires_in }
 *
 * This module implements method 4 (Basic Auth against Token Service).
 * The access_token is then used as a Bearer token on all API calls.
 *
 * Session management (per SAP docs):
 *   - A cookie store must be maintained across API calls.
 *   - x-sap-sac-custom-auth: true  is required on every API request.
 *   - Write ops (POST/PUT/PATCH/DELETE) require a CSRF token obtained
 *     via GET /api/v1/csrf with header  x-csrf-token: fetch.
 *   - The CSRF token and session cookies must travel together.
 *
 * Environment variables:
 *   SAC_BASE_URL      – https://<tenant>.<dc>.sapanalytics.cloud
 *   SAC_TOKEN_URL     – Token URL from SAC Admin > App Integration
 *   SAC_CLIENT_ID     – OAuth Client ID registered in SAC
 *   SAC_CLIENT_SECRET – OAuth Client Secret registered in SAC
 */

// ── Configuration ──────────────────────────────────────────────────

export interface SacClientConfig {
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

/** Read config from environment variables. */
export function configFromEnv(): SacClientConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  return {
    baseUrl: config.sacUrl ?? "",
    tokenUrl: config.oauth.tokenUrl,
    // Optional: without an OAuth client every call goes through the logged-in browser session.
    clientId: config.oauth.clientId,
    clientSecret: config.oauth.clientSecret,
  };
}

// ── Transport selection ────────────────────────────────────────────

/** True when an OAuth client is configured and not overridden by SAC_AUTH_MODE=browser. */
export function oauthConfigured(): boolean {
  return Boolean(config.oauth.clientId && config.oauth.clientSecret && config.oauth.tokenUrl) && process.env.SAC_AUTH_MODE !== "browser";
}

function useBrowser(cfg: SacClientConfig): boolean {
  return !cfg.clientId || !cfg.clientSecret || process.env.SAC_AUTH_MODE === "browser";
}

/** Same contract as the OAuth helpers (throw on HTTP error, return parsed body), but via the browser session. */
async function viaBrowser(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<unknown> {
  const res = await browser.request(method, path, body, undefined, extraHeaders);
  if (res.status >= 400) {
    const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    throw new Error(`SAC API error ${res.status} on ${method} ${path} (browser session): ${text.slice(0, 4000)}`);
  }
  return res.body;
}

// ── Bearer token cache ─────────────────────────────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0; // epoch ms

/**
 * Obtain (or return cached) Bearer token.
 *
 * Uses "Basic Authentication Against the Token Service" (SAP docs):
 *   POST <tokenUrl>?grant_type=client_credentials
 *   Authorization: Basic Base64(<ClientID>:<Secret>)
 *   → { access_token, token_type, expires_in }
 */
export async function getAccessToken(cfg: SacClientConfig): Promise<string> {
  // Return cached token if still valid (with 60 s safety margin)
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  // SAP docs: "include the URL parameter ?grant_type=client_credentials"
  const url = cfg.tokenUrl.includes("?")
    ? `${cfg.tokenUrl}&grant_type=client_credentials`
    : `${cfg.tokenUrl}?grant_type=client_credentials`;

  // SAP docs: "Authorization: Basic Base64-encoding-of-<OAuthClientID>:<Secret>"
  const credentials = Buffer.from(
    `${cfg.clientId}:${cfg.clientSecret}`,
  ).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };

  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;

  return cachedToken;
}

// ── Session cookie jar ─────────────────────────────────────────────
// SAP docs: "Set up a cookie store to maintain session while
// operating against the API."

/** Accumulated session cookies (name=value pairs). */
let cookieJar: Map<string, string> = new Map();

/** Merge Set-Cookie headers from a response into the jar. */
function collectCookies(res: Response): void {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const nameValue = raw.split(";")[0]; // keep "name=value"
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) {
      cookieJar.set(nameValue.slice(0, eqIdx), nameValue.slice(eqIdx + 1));
    }
  }
}

/** Serialise the cookie jar into a single Cookie header value. */
function cookieHeader(): string {
  return Array.from(cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// ── CSRF token cache ───────────────────────────────────────────────

let cachedCsrf: string | null = null;
let csrfExpiresAt = 0; // epoch ms

/**
 * Fetch a CSRF token from SAC.
 *
 * SAP docs — "Get a Valid CSRF Token":
 *   GET <tenant-url>/api/v1/csrf
 *   Headers:
 *     Authorization: Bearer <Access_Token>
 *     x-sap-sac-custom-auth: true
 *     x-csrf-token: fetch
 *   The token is returned in the  x-csrf-token  response header.
 *   Session cookies are set via Set-Cookie and must be stored.
 */
async function fetchCsrfToken(cfg: SacClientConfig): Promise<string> {
  const bearer = await getAccessToken(cfg);
  const cookies = cookieHeader();

  const res = await fetch(`${cfg.baseUrl}/api/v1/csrf`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "x-sap-sac-custom-auth": "true",
      "x-csrf-token": "fetch",
      ...(cookies ? { Cookie: cookies } : {}),
    },
  });

  // Always collect cookies to maintain the session jar.
  collectCookies(res);

  const csrfToken = res.headers.get("x-csrf-token");
  if (!csrfToken) {
    const text = await res.text();
    console.error(`[SAC] CSRF fetch failed: ${text}`);
    throw new Error(
      `CSRF fetch failed (${res.status}): no x-csrf-token header. Body: ${text}`,
    );
  }

  console.error(`[SAC] Acquired CSRF token. Session cookies: ${cookieJar.size}`);
  return csrfToken;
}

/**
 * Get a valid CSRF token, using the cache when possible.
 * Tokens are session-scoped; we conservatively refresh every 10 min.
 */
async function getCsrf(cfg: SacClientConfig): Promise<string> {
  if (cachedCsrf && Date.now() < csrfExpiresAt) {
    return cachedCsrf;
  }

  cachedCsrf = await fetchCsrfToken(cfg);
  csrfExpiresAt = Date.now() + 10 * 60 * 1000;

  return cachedCsrf;
}

/** Invalidate the cached CSRF so the next write re-fetches. */
export function invalidateCsrf(): void {
  console.error("[SAC] Invalidating CSRF token and clearing session cookies");
  cachedCsrf = null;
  csrfExpiresAt = 0;
  cookieJar.clear(); // Force fresh session
}

/** Reset all cached state (token, CSRF, cookies). */
export function resetSession(): void {
  cachedToken = null;
  tokenExpiresAt = 0;
  cachedCsrf = null;
  csrfExpiresAt = 0;
  cookieJar = new Map();
}

// ── Common headers ─────────────────────────────────────────────────

/**
 * Headers required on every SAC API request (per official docs):
 *   Authorization: Bearer <Access_Token>
 *   x-sap-sac-custom-auth: true
 *   Cookie: <session cookies>
 */
async function baseHeaders(
  cfg: SacClientConfig,
): Promise<Record<string, string>> {
  const bearer = await getAccessToken(cfg);
  const cookies = cookieHeader();
  return {
    Authorization: `Bearer ${bearer}`,
    "x-sap-sac-custom-auth": "true",
    ...(cookies ? { Cookie: cookies } : {}),
  };
}

/**
 * Headers for write operations — adds CSRF token on top of base headers.
 *
 * SAP docs: "you can make POST, PUT, and DELETE requests to the API,
 * so long as you continue to include the Authorization, x-csrf-token,
 * and x-sap-sac-custom-auth HTTP headers"
 */
async function writeHeaders(
  cfg: SacClientConfig,
): Promise<Record<string, string>> {
  // Must fetch CSRF first, because it might update the session cookies (in the jar).
  const csrfToken = await getCsrf(cfg);
  // Now get base headers, which include the latest cookies from the jar.
  const base = await baseHeaders(cfg);
  const headers = {
    ...base,
    "X-Csrf-Token": csrfToken,
    "Content-Type": "application/json",
    // Add Origin and X-Requested-With to satisfy stricter CORS/CSRF checks
    "Origin": new URL(cfg.baseUrl).origin,
    "X-Requested-With": "XMLHttpRequest",
  };
  return headers;
}

// ── Public HTTP helpers ────────────────────────────────────────────

/**
 * Authenticated GET request to the SAC REST API.
 * Cookies from the response are stored in the session jar.
 */
export async function sacGet(
  cfg: SacClientConfig,
  path: string,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  if (useBrowser(cfg)) return viaBrowser("GET", path, undefined, extraHeaders);
  const headers = { ...(await baseHeaders(cfg)), ...extraHeaders };
  const url = `${cfg.baseUrl}${path}`;

  const res = await fetch(url, { headers });
  collectCookies(res);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAC API error ${res.status} on GET ${path}: ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

/**
 * Authenticated POST request.  Automatically manages CSRF tokens.
 * If the token is rejected (403), invalidates and retries once.
 */
export async function sacPost(
  cfg: SacClientConfig,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  if (useBrowser(cfg)) return viaBrowser("POST", path, body, extraHeaders);
  const url = `${cfg.baseUrl}${path}`;

  const attempt = async (): Promise<Response> => {
    const headers = { ...(await writeHeaders(cfg)), ...extraHeaders };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    collectCookies(res);
    return res;
  };

  let res = await attempt();

  if (res.status === 403) {
    invalidateCsrf();
    res = await attempt();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAC API error ${res.status} on POST ${path}: ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

/**
 * Authenticated PUT request.  Same CSRF handling as POST.
 */
export async function sacPut(
  cfg: SacClientConfig,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  assertWritable(`PUT ${path}`);
  if (useBrowser(cfg)) return viaBrowser("PUT", path, body, extraHeaders);
  const url = `${cfg.baseUrl}${path}`;

  const attempt = async (): Promise<Response> => {
    const headers = { ...(await writeHeaders(cfg)), ...extraHeaders };
    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify(body),
    });
    collectCookies(res);
    return res;
  };

  let res = await attempt();

  if (res.status === 403) {
    invalidateCsrf();
    res = await attempt();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAC API error ${res.status} on PUT ${path}: ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

/**
 * Authenticated PATCH request.  Same CSRF handling as POST.
 */
export async function sacPatch(
  cfg: SacClientConfig,
  path: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  assertWritable(`PATCH ${path}`);
  if (useBrowser(cfg)) return viaBrowser("PATCH", path, body, extraHeaders);
  const url = `${cfg.baseUrl}${path}`;

  const attempt = async (): Promise<Response> => {
    const headers = { ...(await writeHeaders(cfg)), ...extraHeaders };
    const res = await fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    collectCookies(res);
    return res;
  };

  let res = await attempt();

  if (res.status === 403) {
    invalidateCsrf();
    res = await attempt();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAC API error ${res.status} on PATCH ${path}: ${text}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) return res.json();
  return res.text();
}

/**
 * Authenticated DELETE request.  Same CSRF handling as POST.
 */
export async function sacDelete(
  cfg: SacClientConfig,
  path: string,
  body?: unknown,
): Promise<void> {
  assertWritable(`DELETE ${path}`);
  if (useBrowser(cfg)) {
    await viaBrowser("DELETE", path, body);
    return;
  }
  const url = `${cfg.baseUrl}${path}`;

  const attempt = async (): Promise<Response> => {
    const headers = await writeHeaders(cfg);
    const res = await fetch(url, {
      method: "DELETE",
      headers,
      ...(body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
    });
    collectCookies(res);
    return res;
  };

  let res = await attempt();

  if (res.status === 403) {
    invalidateCsrf();
    res = await attempt();
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SAC API error ${res.status} on DELETE ${path}: ${text}`);
  }
}

// ── Raw request (no throw on HTTP errors) ──────────────────────────

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Arbitrary request against the tenant with the OAuth session (Bearer + cookies + CSRF).
 * Unlike sacGet/sacPost it never throws on HTTP status and supports non-JSON bodies
 * (e.g. text/csv uploads), so it can be used to probe undocumented endpoints.
 */
export async function sacRaw(
  cfg: SacClientConfig,
  method: string,
  path: string,
  body?: unknown,
  contentType?: string,
  extraHeaders?: Record<string, string>,
): Promise<RawResponse> {
  if (useBrowser(cfg)) return browser.request(method, path, body, contentType, extraHeaders);
  const m = method.toUpperCase();
  const url = path.startsWith("http") ? path : `${cfg.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
  const data =
    body === undefined || body === null ? undefined : typeof body === "string" ? body : JSON.stringify(body);

  const attempt = async (): Promise<Response> => {
    const headers: Record<string, string> =
      m === "GET" || m === "HEAD" ? await baseHeaders(cfg) : await writeHeaders(cfg);
    if (data !== undefined) headers["Content-Type"] = contentType ?? (typeof body === "string" ? "text/plain" : "application/json");
    else delete headers["Content-Type"];
    const res = await fetch(url, { method: m, headers: { ...headers, ...extraHeaders }, body: data });
    collectCookies(res);
    return res;
  };

  let res = await attempt();
  if (res.status === 403 && m !== "GET" && m !== "HEAD") {
    invalidateCsrf();
    res = await attempt();
  }
  const text = await res.text();
  let parsed: unknown = text;
  if ((res.headers.get("content-type") ?? "").includes("json")) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep text */
    }
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: parsed };
}
