#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
// Opens the server's Chrome profile on the configured tenant and waits for the SSO login (session is kept).
import { resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { browser } = await import(pathToFileURL(resolve(root, "build/browser/session.js")).href);
const { config } = await import(pathToFileURL(resolve(root, "build/config.js")).href);
try {
  console.log(`Signing in to ${config.sacUrl} … (up to 5 minutes)`);
  await browser.ensureLoggedIn({ headless: false, timeoutMs: 5 * 60_000 });
  console.log(`Signed in. Tenant id: ${browser.tenantId ?? "detected on the first call"}`);
} catch (e) {
  console.error(String(e?.message ?? e));
  process.exitCode = 1;
} finally {
  await browser.close();
}
