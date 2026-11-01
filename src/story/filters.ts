/**
 * Story filters (Filters panel → "Applied to All Pages"): one uqmStoryFilters entry per dimension.
 * Built from a recorded entry (templates/story_filter.json); SAC applies it to all widgets of the dataset on load.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { storyEntity, dropPersistedQueries } from "./content.js";
import { substitute, type ModelRef } from "./fragments.js";
import type { ModelDimension } from "./metadata.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "story_filter.json");

export function addStoryFilter(
  content: Json,
  model: ModelRef,
  dim: ModelDimension,
  members: { key: string; caption?: string }[],
  /** dataset id when it is not a Datasphere view (SAC planning models: planning:[…]) */
  datasetId?: string,
): string {
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const t = tpl.tokens;
  const id = randomUUID();
  let text = JSON.stringify(tpl.filter);
  // whole recorded dataset id (any package prefix) → the target's; before the cube id swap below
  if (datasetId) text = text.replace(new RegExp(`view:\\[_SYS_BIC\\]\\[[^\\]]*\\.${t.cubeId}\\]\\[${t.cubeId}\\]`, "g"), () => datasetId);
  const json = substitute(text, [
    [t.dimName, dim.name],
    [t.dimKey, dim.key],
    [t.dimCaption, dim.caption],
    [t.cubeId, model.cubeId],
    [t.id, id],
  ]);
  const filter = JSON.parse(json);
  filter.lovInfo.staticMembers = members.map((m) => ({ key: m.key, caption: m.caption ?? m.key, displayId: m.key }));

  const story = storyEntity(content).data;
  const existing = (story.uqmStoryFilters ?? []).find((f: Json) => f.extendedSelection?.targetEntity?.dimensionEntityId === filter.extendedSelection.targetEntity.dimensionEntityId);
  if (existing) throw new Error(`The story already has a filter on ${dim.caption}`);
  (story.uqmStoryFilters ??= []).push(filter);
  (story.filterBarInfo ??= {})[id] = {};
  dropPersistedQueries(content);
  return id;
}
