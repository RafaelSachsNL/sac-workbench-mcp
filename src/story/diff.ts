/**
 * Structural diff of two story content documents — the tool for learning how SAC stores a feature:
 * snapshot, change one thing in the UI, snapshot again, diff.
 *
 * Arrays of objects with an `id` (entities, widgets, layouts, pages) are matched by id, so an added widget shows up
 * as one added element instead of a cascade of index shifts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface DiffEntry {
  path: string;
  kind: "added" | "removed" | "changed";
  before?: Json;
  after?: Json;
  bytes?: number;
}

const isObj = (v: Json) => v !== null && typeof v === "object" && !Array.isArray(v);

function keyOf(el: Json, i: number): string {
  if (isObj(el)) {
    if (typeof el.id === "string") return `id=${el.id}`;
    if (typeof el.widgetId === "string") return `widgetId=${el.widgetId}`;
    if (typeof el.sectionId === "string") return `sectionId=${el.sectionId}`;
  }
  return String(i);
}

function preview(v: Json, max: number): Json {
  const s = JSON.stringify(v);
  if (s === undefined) return v;
  if (s.length <= max) return v;
  if (isObj(v)) return { __summary: `object(${s.length} bytes)`, keys: Object.keys(v).slice(0, 30), type: v.type, id: v.id };
  if (Array.isArray(v)) return { __summary: `array(${v.length} items, ${s.length} bytes)` };
  return s.slice(0, max) + "…";
}

export function diffJson(a: Json, b: Json, opts: { maxValueChars?: number; ignore?: RegExp } = {}): DiffEntry[] {
  const out: DiffEntry[] = [];
  const max = opts.maxValueChars ?? 400;

  const walk = (x: Json, y: Json, path: string) => {
    if (opts.ignore?.test(path)) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const p = `${path}.${k}`;
        if (!(k in y)) out.push({ path: p, kind: "removed", before: preview(x[k], max) });
        else if (!(k in x)) out.push({ path: p, kind: "added", after: preview(y[k], max), bytes: JSON.stringify(y[k])?.length });
        else walk(x[k], y[k], p);
      }
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      const xm = new Map(x.map((e, i) => [keyOf(e, i), e]));
      const ym = new Map(y.map((e, i) => [keyOf(e, i), e]));
      for (const [k, e] of xm) if (!ym.has(k)) out.push({ path: `${path}[${k}]`, kind: "removed", before: preview(e, max) });
      for (const [k, e] of ym) {
        if (!xm.has(k)) out.push({ path: `${path}[${k}]`, kind: "added", after: preview(e, max), bytes: JSON.stringify(e)?.length });
        else walk(xm.get(k), e, `${path}[${k}]`);
      }
      return;
    }
    // nested JSON strings (SAC stores some sub-documents as strings)
    if (typeof x === "string" && typeof y === "string" && /^[[{]/.test(x) && /^[[{]/.test(y)) {
      try {
        walk(JSON.parse(x), JSON.parse(y), `${path}<json>`);
        return;
      } catch {
        /* plain strings */
      }
    }
    out.push({ path, kind: "changed", before: preview(x, max), after: preview(y, max) });
  };

  walk(a, b, "$");
  return out;
}
