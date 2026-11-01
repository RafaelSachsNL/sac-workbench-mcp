/**
 * Directory of a module. import.meta.dirname only exists from Node 20.11 — older Node (common on Windows machines)
 * crashed on startup, so it is derived from import.meta.url, which works everywhere and yields Windows paths there.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const dirOf = (moduleUrl: string): string => dirname(fileURLToPath(moduleUrl));
