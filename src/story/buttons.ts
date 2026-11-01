/**
 * Buttons with an onClick script (fragment lifted from the Horizon template, made a plain text button in the
 * theme's lite style — clean, no frame until hover).
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { outlineNames } from "./content.js";
import { insertFragment, type Fragment, type Position } from "./fragments.js";
import { setEvent } from "./scripting.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const FRAGMENT = resolve(dirOf(import.meta.url), "..", "..", "templates", "fragments", "button.json");

export function addButton(
  content: Json,
  opts: { container: string; outlineName: string; text: string; position?: Position; onClick?: string },
): { widgetId: string } {
  const frag = JSON.parse(readFileSync(FRAGMENT, "utf8")) as Fragment;
  const none = { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" };
  const r = insertFragment(content, frag, { container: opts.container, outlineName: opts.outlineName, position: opts.position, model: none, dimensions: [], measures: [], allMeasures: [] });
  const id = [...outlineNames(content).entries()].find(([, n]) => n.name === opts.outlineName)?.[0];
  for (const page of content.entities.find((e: Json) => e?.type === "story").data.pages) {
    const reg = page?.content?.widgets?.find((w: Json) => w?.id === id);
    const entity = reg && content.entities.find((e: Json) => e?.id === reg.definition?.entityId);
    if (entity?.data) Object.assign(entity.data, { text: opts.text });
  }
  if (opts.onClick) setEvent(content, opts.outlineName, "onClick", opts.onClick);
  return r;
}
