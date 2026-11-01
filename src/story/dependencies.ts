/**
 * Recorded story templates can point to repository objects of the tenant they were recorded on: the story theme
 * (themingReference) and composites (application compositesInAssets + CompositeWidget instances). On another tenant
 * those do not exist and saving fails ("Objects … might already be deleted or did not exist"). This drops what the
 * current tenant does not have: the story falls back to the default theme, missing composites are removed.
 */

import { appEntity, contentlib, outlineNames, storyEntity } from "./content.js";
import { removeWidget } from "./fragments.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

async function exists(resourceId: string): Promise<boolean> {
  // a missing (or unreadable) object answers with an error; without a metadata request the answer only echoes the id
  try {
    await contentlib("getResourceEx", { resourceId, metadata: { name: true } });
    return true;
  } catch {
    return false;
  }
}

export async function dropMissingDependencies(content: Json): Promise<string[]> {
  const dropped: string[] = [];
  const story = storyEntity(content).data;
  const themeId = story.themingReference?.resourceId;
  if (themeId && !(await exists(themeId))) {
    delete story.themingReference;
    if (story.storyWideSettings) delete story.storyWideSettings["story.theme"];
    dropped.push(`theme ${themeId}`);
  }
  const app = appEntity(content);
  const listed: string[] = app.compositesInAssets ?? [];
  const missing = new Set<string>();
  for (const ref of listed) {
    const id = ref.split(":").pop()!;
    if (!(await exists(id))) missing.add(id);
  }
  if (missing.size) {
    app.compositesInAssets = listed.filter((ref) => !missing.has(ref.split(":").pop()!));
    const names = outlineNames(content);
    for (const page of story.pages ?? [])
      for (const w of [...(page.content?.widgets ?? [])])
        if (w?.class?.endsWith("CompositeWidget") && missing.has(w.resourceId)) {
          const name = names.get(w.id)?.name;
          if (name) removeWidget(content, name);
          dropped.push(`composite ${w.resourceId}${name ? ` (${name})` : ""}`);
        }
  }
  return dropped;
}
