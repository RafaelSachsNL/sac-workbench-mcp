/**
 * Configuration: sac-mcp.config.json (see sac-mcp.config.example.json); environment variables override it.
 * Lookup: $SAC_MCP_CONFIG → <repo>/sac-mcp.config.json → ~/.sac-mcp/config.json
 *
 * No passwords: the login is SSO in the server's own Chrome profile (npm run login), which keeps the session.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { dirOf } from "./paths.js";

export interface FileConfig {
  /** SAC tenant, e.g. https://mytenant.eu10.hcs.cloud.sap */
  tenantUrl?: string;
  /** internal tenant UUID (?tenant=…); detected after login when empty */
  tenantId?: string;
  /** SAC user id (e.g. JDOE); detected from the folder owner when empty */
  user?: string;
  readOnly?: boolean;
  expertTools?: boolean;
  defaults?: {
    /** SAC live connection to Datasphere */
    connection?: string;
    /** Datasphere space */
    space?: string;
    /** folder for new stories (resource id) */
    folderId?: string;
  };
  browser?: { profileDir?: string; channel?: string; headless?: boolean };
  /** optional OAuth client (client credentials) for the public REST API; the browser session covers everything else */
  oauth?: { clientId?: string; clientSecret?: string; tokenUrl?: string };
}

export const REPO_DIR = resolve(dirOf(import.meta.url), "..");
export const HOME_DIR = join(homedir(), ".sac-mcp");
/** installed from npm (inside node_modules): write recordings, backups and theme profiles to ~/.sac-mcp, not the package */
export const INSTALLED = /[\\/]node_modules[\\/]/.test(REPO_DIR);
export const DATA_DIR = INSTALLED ? HOME_DIR : REPO_DIR;

export function configPath(): string | undefined {
  const candidates = [process.env.SAC_MCP_CONFIG, join(REPO_DIR, "sac-mcp.config.json"), join(HOME_DIR, "config.json")];
  return candidates.find((p) => p && existsSync(p));
}

function loadFile(): FileConfig {
  const p = configPath();
  if (!p) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as FileConfig;
  } catch (e) {
    throw new Error(`Config file ${p} is not valid JSON: ${(e as Error).message}`);
  }
}

const file = loadFile();

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export const config = {
  sacUrl: (env("SAC_BASE_URL") ?? env("SAC_URL") ?? file.tenantUrl ?? "").replace(/\/+$/, "") || undefined,
  /** Internal tenant id used by /sap/fpa/services (?tenant=X). Detected from the UI's service calls if unset. */
  tenantId: env("SAC_TENANT_ID") ?? file.tenantId,
  user: env("SAC_USER") ?? file.user,
  readOnly: (env("SAC_READ_ONLY") ?? String(file.readOnly ?? false)) === "true",
  /** Raw access to the tenant (arbitrary JS in the page, any API path, replaying recorded calls) — off unless asked for. */
  expertTools: (env("SAC_EXPERT_TOOLS") ?? String(file.expertTools ?? false)) === "true",
  defaults: {
    connection: env("SAC_DEFAULT_CONNECTION") ?? file.defaults?.connection,
    space: env("SAC_DEFAULT_SPACE") ?? file.defaults?.space,
    folderId: env("SAC_DEFAULT_FOLDER") ?? file.defaults?.folderId,
  },
  oauth: {
    clientId: env("SAC_CLIENT_ID") ?? file.oauth?.clientId ?? "",
    clientSecret: env("SAC_CLIENT_SECRET") ?? file.oauth?.clientSecret ?? "",
    tokenUrl: env("SAC_TOKEN_URL") ?? file.oauth?.tokenUrl ?? "",
  },
  browserProfile: resolve(env("SAC_BROWSER_PROFILE") ?? file.browser?.profileDir ?? join(HOME_DIR, "browser-profile")),
  browserChannel: env("SAC_BROWSER_CHANNEL") ?? file.browser?.channel ?? "chrome",
  headless: (env("SAC_BROWSER_HEADLESS") ?? String(file.browser?.headless ?? false)) === "true",
  captureDir: resolve(env("SAC_CAPTURE_DIR") ?? join(DATA_DIR, "captures")),
  maxOutputChars: Number(env("SAC_MAX_OUTPUT_CHARS") ?? 60000),
};

export function requireUrl(): string {
  if (!config.sacUrl)
    throw new Error("No SAC tenant configured. Run `npm run setup` (or copy sac-mcp.config.example.json to sac-mcp.config.json and set tenantUrl).");
  return config.sacUrl;
}

/** Default connection/space for model parameters; an explicit value is required when none is configured. */
export function defaultOf(key: "connection" | "space"): string {
  const v = config.defaults[key];
  if (!v) throw new Error(`No ${key} given and no defaults.${key} in the config — pass ${key} explicitly`);
  return v;
}

export function assertWritable(what: string) {
  if (config.readOnly) throw new Error(`Blocked: readOnly is set, refusing write operation (${what}).`);
}
