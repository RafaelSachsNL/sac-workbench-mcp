/**
 * Themes as repository objects (THEMING). Content: preference groups per page/widget type in applyToExisting /
 * applyToNew (background, border, fonts, …), custom colour palettes and the theme CSS (page group, setting
 * sap.epm.appBuilding.settings.app.css.theme → appCssStyle).
 *
 * New themes are derived from a base theme (e.g. Fiori Morning Horizon) with targeted changes.
 */

import { randomUUID } from "node:crypto";
import { contentlib } from "./content.js";
import { mergeCss } from "./css-validate.js";
import { listDesignAssets } from "./assets.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface ThemeChanges {
  /** standard palette colours (first one becomes the default palette) */
  palette?: string[];
  /** theme CSS: append (default), replace all, or upsert rule by rule (same selector replaces the old rule) */
  css?: string;
  cssMode?: "append" | "replace" | "upsert";
  /** selectors whose rules are removed from the theme CSS */
  cssRemove?: string[];
  /** canvas page background */
  canvasBackground?: string;
  /** default corner radius of panels */
  panelRadius?: number;
  /** variance colours */
  positiveColor?: string;
  negativeColor?: string;
}

export async function readTheme(themeId: string): Promise<{ name: string; description: string; cdata: Json }> {
  const res = await contentlib("getContent", { resourceType: "THEMING", resourceId: themeId, oOpt: {} });
  const cdata = typeof res.cdata === "string" ? JSON.parse(res.cdata) : res.cdata;
  if (!cdata?.applyToExisting) throw new Error(`${themeId} is not a theme`);
  return { name: res.name, description: res.description ?? "", cdata };
}

function eachSetting(cdata: Json, groupId: string, prefType: string, fn: (settings: Json) => void) {
  for (const list of [cdata.applyToExisting, cdata.applyToNew])
    for (const grp of list ?? [])
      if (grp?.id === groupId) for (const p of grp.preferences ?? []) if (p?.type === prefType) fn((p.settings ??= {}));
}

export function applyThemeChanges(cdata: Json, c: ThemeChanges) {
  if (c.palette?.length) {
    const id = randomUUID();
    cdata.customColorPalettes = [{ colors: c.palette, type: "standard", id, default: true }, ...(cdata.customColorPalettes ?? []).map((p: Json) => ({ ...p, default: false }))];
    eachSetting(cdata, "sap.fpa.story.theme.tile.viz", "sap.lumira.story.setting.multiColorPalette", (s) => {
      s.standard = { path: null, value: id, lastUpdatedUtcTime: Date.now() };
    });
  }
  if (c.css !== undefined || c.cssRemove?.length)
    eachSetting(cdata, "sap.fpa.appBuilding.theme.app.general", "sap.epm.appBuilding.settings.app.css.theme", (s) => {
      s.enableThemeCss = true;
      const css = c.css ?? "";
      if (c.cssMode === "replace") s.appCssStyle = css;
      else if (c.cssMode === "upsert" || c.cssRemove?.length) s.appCssStyle = mergeCss(s.appCssStyle ?? "", { upsert: css, remove: c.cssRemove }).css;
      else s.appCssStyle = `${s.appCssStyle ?? ""}\n\n/* --- MCP --- */\n${css}`;
    });
  if (c.canvasBackground)
    eachSetting(cdata, "sap.fpa.story.theme.page.canvas", "sap.lumira.story.setting.canvas", (s) => {
      s.backgroundColor = { path: "/backgroundColor", value: c.canvasBackground };
    });
  if (c.panelRadius !== undefined)
    eachSetting(cdata, "sap.fpa.appBuilding.theme.widget.panel", "sap.lumira.story.setting.border.borderSetting", (s) => {
      s.border = { value: { ...(s.border?.value ?? {}), radius: c.panelRadius } };
    });
  if (c.positiveColor || c.negativeColor)
    eachSetting(cdata, "sap.fpa.story.theme.tile.viz", "sap.lumira.story.setting.varianceColor", (s) => {
      const v = s.varianceColors?.value ?? {};
      s.varianceColors = { value: { ...v, ...(c.positiveColor ? { positiveColor: c.positiveColor, nullZeroColor: c.positiveColor } : {}), ...(c.negativeColor ? { negativeColor: c.negativeColor } : {}) } };
    });
}

export async function createTheme(opts: { baseThemeId: string; name: string; description?: string; folderId: string; changes: ThemeChanges }): Promise<{ themeId: string }> {
  const base = await readTheme(opts.baseThemeId);
  const cdata = structuredClone(base.cdata);
  applyThemeChanges(cdata, opts.changes);
  cdata.isSample = false;
  cdata.isTemporary = false;
  const res = await contentlib("createContent", {
    parentResId: opts.folderId,
    resourceType: "THEMING",
    name: opts.name,
    description: opts.description ?? `${opts.name} (based on ${base.name})`,
    cdata: JSON.stringify(cdata),
    createOpt: {},
  });
  return { themeId: res.resourceId };
}

/** Theme CSS as stored (page group setting appCssStyle). */
export function themeCss(cdata: Json): string {
  let css = "";
  eachSetting(cdata, "sap.fpa.appBuilding.theme.app.general", "sap.epm.appBuilding.settings.app.css.theme", (s) => (css ||= s.appCssStyle ?? ""));
  return css;
}

/** Change an existing theme in place; returns the saved content and its new version (for story copies). */
export async function updateTheme(themeId: string, changes: ThemeChanges, opts: { dryRun?: boolean } = {}): Promise<{ cdata: Json; version: number }> {
  const res = await contentlib("getContent", { resourceType: "THEMING", resourceId: themeId, oOpt: {} });
  const cdata = typeof res.cdata === "string" ? JSON.parse(res.cdata) : res.cdata;
  applyThemeChanges(cdata, changes);
  if (opts.dryRun) return { cdata, version: res.updateCounter };
  const save = (ignoreVersion: boolean) =>
    contentlib("updateContent", {
      resourceId: themeId,
      name: res.name,
      description: res.description ?? "",
      cdata: JSON.stringify(cdata),
      updateOpt: { localVer: res.updateCounter, ignoreVersion },
    });
  let saved: Json;
  try {
    saved = await save(false);
  } catch (e) {
    // like stories: SAC sometimes refuses its own current version; repeat only if nobody saved in between
    if (!String(e).includes("INCONSISTENT_VERSION")) throw e;
    const current = await contentlib("getContent", { resourceType: "THEMING", resourceId: themeId, oOpt: {} });
    if (current?.updateCounter !== res.updateCounter) throw e;
    saved = await save(true);
  }
  return { cdata, version: saved?.updateCounter ?? res.updateCounter + 1 };
}

/**
 * A story works on its own copy of the theme (storyWideSettings["story.theme"]) and only re-reads the theme when
 * themingReference.version changes — so after a theme update the copy is replaced and the version raised.
 */
export function syncStoryTheme(content: Json, themeId: string, theme: { cdata: Json; version: number }): boolean {
  const story = content.entities.find((e: Json) => e?.type === "story").data;
  if (story.themingReference?.resourceId !== themeId) return false;
  const copy = (story.storyWideSettings ??= {})["story.theme"] ?? {};
  story.storyWideSettings["story.theme"] = {
    ...copy,
    applyToExisting: structuredClone(theme.cdata.applyToExisting),
    applyToNew: structuredClone(theme.cdata.applyToNew),
    ...(theme.cdata.customGradients ? { customGradients: structuredClone(theme.cdata.customGradients) } : {}),
    lastModified: Date.now(),
  };
  story.themingReference.version = theme.version;
  return true;
}

/** Point a story at a theme (themingReference); the story picks it up on next open. */
export function setStoryTheme(content: Json, theme: { resourceId: string; version?: number; packageId?: string }) {
  const story = content.entities.find((e: Json) => e?.type === "story").data;
  story.themingReference = { ...(story.themingReference ?? {}), resourceId: theme.resourceId, version: theme.version ?? 1, ...(theme.packageId ? { packageId: theme.packageId } : {}) };
}

/**
 * Apply a theme straight from its SAC resource (reference + the story's own copy), so a theme works without a
 * captured profile in templates/themes. Returns the theme's name.
 */
export async function applyThemeResource(content: Json, nameOrId: string): Promise<string> {
  const t = (await listDesignAssets()).themes.find((x) => x.resourceId === nameOrId || x.name === nameOrId);
  if (!t) throw new Error(`Theme '${nameOrId}' not found`);
  const meta = (await contentlib("getResourceEx", { resourceId: t.resourceId, metadata: { name: true, packageId: true, updateCounter: true } }).catch(() => ({}))) as {
    updateCounter?: number;
    packageId?: string;
  };
  const { cdata } = await readTheme(t.resourceId);
  const version = meta.updateCounter ?? 1;
  setStoryTheme(content, { resourceId: t.resourceId, version, packageId: meta.packageId });
  syncStoryTheme(content, t.resourceId, { cdata, version });
  return t.name;
}
