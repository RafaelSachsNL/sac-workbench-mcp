/**
 * Design assets available in the tenant (themes, story templates, composites) and the rule for picking one:
 * branded names first, then the highest version in the name ("(2.0.1)"), then the most recently changed.
 */

import { contentlib } from "./content.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface DesignAsset {
  resourceId: string;
  name: string;
  kind: "theme" | "template" | "composite";
  modifiedTime: string;
  createdBy: string;
  version?: string;
  recommended?: boolean;
  reason?: string;
}

// own themes/templates first: names starting with SAC_BRAND_PREFIX (e.g. "ACME|AC" matches "ACME_Theme", "AC-Dark")
const brandPrefix = process.env.SAC_BRAND_PREFIX?.trim();
const BRAND = brandPrefix ? new RegExp(`\\b(${brandPrefix})[_\\s-]`, "i") : /(?!)/;

function version(name: string): number[] | undefined {
  const m = name.match(/\((\d+(?:\.\d+)*)\)\s*$/) ?? name.match(/[_\s-]V(\d+(?:\.\d+)*)\b/i);
  return m ? m[1].split(".").map(Number) : undefined;
}

function cmpVersion(a?: number[], b?: number[]): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
}

function rank(list: DesignAsset[]): DesignAsset[] {
  const sorted = [...list].sort(
    (x, y) =>
      Number(BRAND.test(y.name)) - Number(BRAND.test(x.name)) ||
      cmpVersion(version(x.name), version(y.name)) ||
      y.modifiedTime.localeCompare(x.modifiedTime),
  );
  if (sorted[0]) {
    const top = sorted[0];
    top.recommended = true;
    top.reason = BRAND.test(top.name)
      ? "Asset"
      : version(top.name)
        ? `highest version (${version(top.name)!.join(".")})`
        : "most recently changed";
  }
  return sorted;
}

async function search(type: string): Promise<Json[]> {
  const res = await contentlib("getSearchList", { type, value: "*", recentlyAccessed: 500, bIncTemporary: false, spaceId: null });
  return Array.isArray(res) ? res : [];
}

export async function listDesignAssets(): Promise<{ themes: DesignAsset[]; templates: DesignAsset[]; composites: DesignAsset[] }> {
  const toAsset = (x: Json, kind: DesignAsset["kind"]): DesignAsset => ({
    resourceId: x.resourceId,
    name: x.name,
    kind,
    modifiedTime: x.modifiedTime ?? "",
    createdBy: x.createdBy ?? "",
    ...(version(x.name) ? { version: version(x.name)!.join(".") } : {}),
  });
  const [themes, stories] = await Promise.all([search("THEMING"), search("STORY")]);
  return {
    themes: rank(themes.map((x) => toAsset(x, "theme"))),
    templates: rank(stories.filter((x) => x.resourceSubtype === "TEMPLATE").map((x) => toAsset(x, "template"))),
    composites: rank(stories.filter((x) => x.resourceSubtype === "COMPOSITE").map((x) => toAsset(x, "composite"))),
  };
}
