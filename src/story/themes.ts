/**
 * Themes: SAC applies a theme by referencing the theme resource (themingReference) and copying derived styles into
 * storyWideSettings. That derivation is internal, so we capture the theme-related settings from a story that already
 * uses the theme ("theme profile", templates/themes/<name>.json) and transfer them to other stories.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { storyEntity } from "./content.js";
import { dirOf } from "../paths.js";
import { DATA_DIR, INSTALLED } from "../config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// theme profiles: templates/themes in a cloned repo, ~/.sac-mcp/themes when installed from npm
const THEME_DIR = INSTALLED ? join(DATA_DIR, "themes") : resolve(dirOf(import.meta.url), "..", "..", "templates", "themes");
const SETTINGS_KEYS = [
  "story.theme",
  "theme.color.palettes",
  "story.namedcolors.ismigrationcomplete",
  "story.namedcolors.migrationpalettes",
  "story.namedcolors.defaultpalettesbeforemigration",
];

const file = (name: string) => join(THEME_DIR, `${name.replace(/[^\w.-]/g, "_")}.json`);

export function captureThemeProfile(content: Json, name: string): Json {
  const s = storyEntity(content).data;
  if (!s.themingReference) throw new Error("The source story has no theme applied");
  const profile = {
    name,
    themingReference: s.themingReference,
    storyWideSettings: Object.fromEntries(SETTINGS_KEYS.filter((k) => k in (s.storyWideSettings ?? {})).map((k) => [k, s.storyWideSettings[k]])),
  };
  mkdirSync(THEME_DIR, { recursive: true });
  writeFileSync(file(name), JSON.stringify(profile));
  return { name, themingReference: profile.themingReference, keys: Object.keys(profile.storyWideSettings) };
}

export function listThemeProfiles(): string[] {
  mkdirSync(THEME_DIR, { recursive: true });
  return readdirSync(THEME_DIR).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
}

export function applyThemeProfile(content: Json, name: string) {
  const profile = JSON.parse(readFileSync(file(name), "utf8"));
  const s = storyEntity(content).data;
  s.themingReference = profile.themingReference;
  s.storyWideSettings = { ...(s.storyWideSettings ?? {}), ...profile.storyWideSettings };
}
