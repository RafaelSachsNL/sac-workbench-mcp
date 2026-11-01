/**
 * Story patch by function: run a JavaScript function body against the content document of a story (sandboxed with
 * node:vm, no I/O), then save. Replaces the getContent → transform → updateContent round trips that were otherwise
 * written by hand via sac_browser_eval.
 *
 * The body sees `content` (mutable) and `h` (helpers below) and may return anything JSON-serialisable as a report.
 */

import vm from "node:vm";
import { appEntity, outlineNames, storyEntity } from "./content.js";
import { diffJson } from "./diff.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function helpers(content: Json) {
  const story = () => storyEntity(content);
  const app = () => appEntity(content);
  const pages = () => story().data.pages ?? [];
  const byName = () => new Map([...outlineNames(content).entries()].map(([id, n]) => [n.name, { id, kind: n.kind, key: n.key }]));
  /** Everything SAC keeps for one widget: registry entry, its layout entry (position), its entity, its page. */
  const widget = (name: string) => {
    const hit = byName().get(name);
    if (!hit) throw new Error(`No widget named '${name}'`);
    for (const page of pages()) {
      const registry = page.content?.widgets?.find((w: Json) => w?.id === hit.id);
      if (!registry) continue;
      let layoutEntry: Json;
      let section: Json;
      let layout: Json;
      for (const l of page.content.layouts ?? [])
        for (const s of l?.definition?.page?.sections ?? [])
          for (const w of s?.widgets ?? []) if (w?.widgetId === hit.id) [layoutEntry, section, layout] = [w.definition, s, l];
      const entity = content.entities.find((e: Json) => e?.id === registry.definition?.entityId);
      return { id: hit.id, kind: hit.kind, registry, layoutEntry, section, layout, entity, page };
    }
    throw new Error(`Widget '${name}' is not on any page`);
  };
  /** Inner layout of a container (panel, flow panel) — its sections are the children in order. */
  const innerLayout = (name: string) => {
    const w = widget(name);
    const id = w.registry.definition?.layoutIds?.[0];
    return w.page.content.layouts.find((l: Json) => l?.id === id);
  };
  /** Paths of all values (or keys) matching a test, e.g. h.find(v => typeof v === "string" && v.includes("Cookie")). */
  const find = (test: (value: Json, key: string) => boolean, max = 50) => {
    const out: string[] = [];
    const walk = (o: Json, p: string) => {
      if (out.length >= max) return;
      if (o && typeof o === "object")
        for (const [k, v] of Object.entries(o)) {
          if (test(v, k)) out.push(`${p}.${k}`);
          walk(v, `${p}.${k}`);
        }
    };
    walk(content, "$");
    return out;
  };
  return { story, app, pages, names: () => Object.fromEntries(byName()), widget, innerLayout, find };
}

export function runTransform(content: Json, code: string, timeoutMs = 5000): { result: Json; changes: number; changed: string[] } {
  const before = structuredClone(content);
  const sandbox = { content, h: helpers(content), result: undefined as Json };
  vm.createContext(sandbox);
  vm.runInContext(`result = (function (content, h) {\n${code}\n})(content, h);`, sandbox, { timeout: timeoutMs, filename: "transform.js" });
  // summary: changed paths grouped two levels below the entity / page, no 60k raw diff
  const diff = diffJson(before, content, { maxValueChars: 0, ignore: /contentSize$/ });
  const changed = [...new Set(diff.map((d) => d.path.split(".").slice(0, 7).join(".")))].slice(0, 40);
  return { result: sandbox.result === undefined ? null : JSON.parse(JSON.stringify(sandbox.result)), changes: diff.length, changed };
}
