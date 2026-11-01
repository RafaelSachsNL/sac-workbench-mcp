/**
 * Duplicate a widget or a whole card (panel with everything inside): new ids for widgets, sections, inner layouts,
 * entities (so a copied text has its own text entity — the editor's "Duplicate" shares it, and deleting one copy then
 * breaks the other) and persisted queries; new outline names. Scripts/events are not copied.
 */

import { randomUUID } from "node:crypto";
import { appEntity, outlineNames, storyEntity } from "./content.js";
import { containerLayout } from "./fragments.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface DuplicateOptions {
  /** outline name of the copy */
  name: string;
  /** target container (page or panel outline name); default: next to the source */
  container?: string;
  /** names of copied children: replace this text … */
  renameFrom?: string;
  /** … with this (default: append "_2") */
  renameTo?: string;
  /** position of the copy in its container (left/top/width/height as in the layout entry) */
  position?: Record<string, number | string>;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function duplicateWidget(content: Json, source: string, opts: DuplicateOptions): { created: Record<string, string> } {
  const story = storyEntity(content).data;
  const names = appEntity(content).app.names as Record<string, string>;
  const byName = new Map([...outlineNames(content).entries()].map(([id, n]) => [n.name, { id, kind: n.kind }]));
  const nameOf = new Map([...outlineNames(content).entries()].map(([id, n]) => [id, n]));
  const used = new Set(Object.values(names));
  const created: Record<string, string> = {};

  const findWidget = (id: string) => {
    for (const page of story.pages ?? []) {
      const registry = page.content?.widgets?.find((w: Json) => w?.id === id);
      if (!registry) continue;
      for (const l of page.content.layouts ?? [])
        for (const s of l?.definition?.page?.sections ?? []) if (s?.widgets?.some((w: Json) => w?.widgetId === id)) return { page, registry, section: s, layout: l };
      return { page, registry, section: undefined, layout: undefined };
    }
    throw new Error(`Widget ${id} is not on any page`);
  };

  const copyName = (old: string, root: boolean) => {
    let n = root ? opts.name : opts.renameFrom ? old.split(opts.renameFrom).join(opts.renameTo ?? "") : `${old}_2`;
    if (!root) while (used.has(n)) n += "_2";
    if (used.has(n)) throw new Error(`Name '${n}' is already used`);
    used.add(n);
    return n;
  };

  /** copy widget `id` into `target` layout; returns the new id */
  const dup = (id: string, target: Json, root: boolean): string => {
    const { page, registry, section } = findWidget(id);
    const newId = randomUUID();
    const swap = (x: Json) => JSON.parse(JSON.stringify(x).split(id).join(newId));
    const reg = swap(registry);
    // own entity (text, image …)
    const entityId = registry.definition?.entityId;
    const entity = entityId && content.entities.find((e: Json) => e?.id === entityId);
    if (entity) {
      const e2 = clone(entity);
      e2.id = randomUUID();
      reg.definition.entityId = e2.id;
      content.entities.push(e2);
    }
    // inner layouts of containers, children copied recursively
    const innerIds: string[] = registry.definition?.layoutIds ?? [];
    if (innerIds.length) {
      reg.definition.layoutIds = innerIds.map((lid) => {
        const inner = page.content.layouts.find((l: Json) => l?.id === lid);
        const copy = clone(inner);
        copy.id = randomUUID();
        const children = (inner.definition?.page?.sections ?? []).flatMap((s: Json) => s.widgets?.map((w: Json) => w.widgetId) ?? []);
        copy.definition.page.sections = [];
        page.content.layouts.push(copy);
        for (const c of children) dup(c, copy, false);
        return copy.id;
      });
    }
    page.content.widgets.push(reg);
    // layout entry (position)
    if (section) {
      const s2 = clone(section);
      s2.sectionId = randomUUID();
      s2.widgets = s2.widgets.filter((w: Json) => w.widgetId === id).map((w: Json) => ({ ...w, widgetId: newId }));
      const def = s2.widgets[0].definition;
      if (root) {
        // the source may be hidden until a script shows it (editVisibility false); the copy starts visible
        delete s2.definition.editVisibility;
        s2.definition.viewVisibility = "auto";
      }
      if (root && opts.container) {
        // anchored to the edges of the old container (auto size) → size 0 elsewhere; give it a fixed box
        const dyn = (def.dynamicLayout ??= {});
        Object.assign(dyn, { left: 0, top: 0, width: 300, height: 140, leftUnit: "pixel", topUnit: "pixel", widthUnit: "pixel", heightUnit: "pixel", rightUnit: "auto", bottomUnit: "auto" });
        delete dyn.right;
        delete dyn.bottom;
      }
      if (root && opts.position) Object.assign(def.dynamicLayout ?? def, opts.position);
      if (root && opts.container && def.dynamicLayout)
        Object.assign(s2.definition, { x: 0, y: 0, width: def.dynamicLayout.width, height: def.dynamicLayout.height });
      // flow panel children also carry their size outside dynamicLayout
      if (root && target.definition?.page?.definition?.layoutType === "FLOW" && def.dynamicLayout)
        for (const k of ["width", "height"] as const) if (def.dynamicLayout[`${k}Unit`] === "pixel") def[k] = def.dynamicLayout[k];
      target.definition.page.sections.push(s2);
    }
    // persisted queries of the widget
    const queries: Json[] = story.persistedUqmQuery ?? [];
    for (const q of queries.filter((q) => typeof q?.id === "string" && q.id.includes(id))) queries.push(swap(q));
    const old = nameOf.get(id);
    if (old) {
      const n = copyName(old.name, root);
      names[old.key.split(id).join(newId)] = n;
      created[old.name] = n;
    }
    return newId;
  };

  const src = byName.get(source);
  if (!src) throw new Error(`No widget named '${source}'`);
  const target = opts.container ? containerLayout(content, opts.container).layout : findWidget(src.id).layout;
  if (!target) throw new Error(`'${source}' has no layout entry; pass container`);
  dup(src.id, target, true);
  return { created };
}
