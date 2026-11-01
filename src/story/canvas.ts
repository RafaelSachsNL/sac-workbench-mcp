/**
 * Canvas building blocks: reduce a story to one blank canvas page, lift existing widgets as fragments, style widgets.
 *
 * Canvas anchoring (dynamicLayout): a side is fixed with <side>Unit "pixel"; width/height "auto" stretches between the
 * fixed sides. Header/filter/KPI areas use fixed tops, the body uses top + bottom 0 so it fills the rest and scrolls.
 */

import { randomUUID } from "node:crypto";
import { appEntity, outlineNames, storyEntity } from "./content.js";
import { containerLayout, removeWidget, type Fragment } from "./fragments.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/** Keep only the first page, empty it and name it PAGE_1. */
export function stripToBlankCanvasPage(content: Json, pageName = "PAGE_1") {
  const story = storyEntity(content).data;
  const app = appEntity(content);
  const names = app.app.names as Record<string, string>;
  const [keep, ...drop] = (story.pages ?? []).filter(Boolean);
  if (!keep) throw new Error("Story has no page");

  // widgets/entities of dropped pages
  const droppedWidgetIds = new Set<string>();
  const droppedEntityIds = new Set<string>();
  for (const p of drop)
    for (const w of p.content?.widgets ?? []) {
      if (!w) continue;
      droppedWidgetIds.add(w.id);
      if (w.definition?.entityId) droppedEntityIds.add(w.definition.entityId);
    }
  const droppedPageIds = new Set<string>(drop.map((p: Json) => String(p.id)));
  story.pages = [keep];
  content.entities = content.entities.filter((e: Json) => e && !droppedEntityIds.has(e.id));
  for (const key of Object.keys(names)) {
    if ([...droppedWidgetIds, ...droppedPageIds].some((id) => key.includes(id))) delete names[key];
  }
  app.appPages = (app.appPages ?? []).filter((a: Json) => !droppedPageIds.has(a?.payload?.pageId));
  const events = app.app.events ?? {};
  for (const key of Object.keys(events)) if ([...droppedWidgetIds].some((id) => key.includes(id))) delete events[key];

  // empty the kept page: remove its root widgets (removeWidget handles nesting)
  const rootLayout = keep.content.layouts.find((l: Json) => l?.id === keep.definition.layoutId);
  const rootIds = (rootLayout?.definition?.page?.sections ?? []).flatMap((s: Json) => (s?.widgets ?? []).map((w: Json) => w?.widgetId));
  const byWidget = outlineNames(content);
  for (const id of rootIds) {
    const n = byWidget.get(id)?.name;
    if (n) removeWidget(content, n);
  }
  // anything left unnamed on the page
  keep.content.widgets = (keep.content.widgets ?? []).filter((w: Json) => w && byWidget.has(w.id) && outlineNames(content).has(w.id));
  if (rootLayout?.definition?.page) rootLayout.definition.page.sections = [];
  for (const key of Object.keys(events)) if (![...outlineNames(content).keys()].some((id) => key.includes(id))) delete events[key];

  keep.title = pageName;
  const pageKey = Object.keys(names).find((k) => k.includes(keep.id) && k.includes("appPage"));
  if (pageKey) names[pageKey] = pageName;
}

/** Lift an existing widget (without its children) as a fragment, e.g. a Horizon card panel. */
export function fragmentFromWidget(
  content: Json,
  widgetName: string,
  fragmentName: string,
  description: string,
  data?: Pick<Fragment["tokens"], "model" | "dimensions" | "measures">,
): Fragment {
  const names = outlineNames(content);
  const hit = [...names.entries()].find(([, n]) => n.name === widgetName);
  if (!hit) throw new Error(`No widget named '${widgetName}'`);
  const [widgetId, { kind }] = hit;
  const page = storyEntity(content).data.pages.find((p: Json) => p?.content?.widgets?.some((w: Json) => w?.id === widgetId));
  const registry = page.content.widgets.find((w: Json) => w?.id === widgetId);
  let section: Json;
  for (const l of page.content.layouts)
    for (const s of l?.definition?.page?.sections ?? []) if (s?.widgets?.some((w: Json) => w?.widgetId === widgetId)) section = s;
  if (!section) throw new Error("Layout section of the widget not found");
  section = structuredClone(section);
  section.widgets = section.widgets.filter((w: Json) => w?.widgetId === widgetId);
  const entity = content.entities.find((e: Json) => e?.id === registry.definition?.entityId);
  const layouts = (registry.definition?.layoutIds ?? []).map((id: string) => {
    const l = structuredClone(page.content.layouts.find((x: Json) => x?.id === id));
    if (l?.definition?.page) l.definition.page.sections = [];
    return l;
  });
  // data widgets: their persisted (and pre-executed) queries are keyed by the widget id
  const story = storyEntity(content).data;
  const queries = data ? (story.persistedUqmQuery ?? []).filter((q: Json) => String(q?.id).includes(widgetId)) : [];
  const preExecute = data ? (story.preExecuteUqmQueryIds ?? []).filter((q: string) => q.includes(widgetId)) : [];
  return {
    name: fragmentName,
    description,
    kind,
    tokens: {
      widgetId,
      sectionId: section.sectionId,
      entityIds: entity ? [entity.id] : [],
      outlineName: widgetName,
      model: data?.model ?? { cubeId: "\u0000none", model: "\u0000none", space: "\u0000none", connection: "\u0000none" },
      dimensions: data?.dimensions ?? [],
      measures: data?.measures ?? [],
    },
    parts: {
      registry: structuredClone(registry),
      section,
      entities: entity ? [structuredClone(entity)] : [],
      queries: structuredClone(queries),
      preExecute,
      udm: [],
      layouts,
    },
  };
}

export interface WidgetStyle {
  cssClass?: string;
  radius?: number;
  background?: string;
}

/** CSS class, corner radius and background of a widget (Styling panel). */
export function styleWidget(content: Json, widgetName: string, style: WidgetStyle) {
  const names = outlineNames(content);
  const hit = [...names.entries()].find(([, n]) => n.name === widgetName);
  if (!hit) throw new Error(`No widget named '${widgetName}'`);
  const widgetId = hit[0];
  const page = storyEntity(content).data.pages.find((p: Json) => p?.content?.widgets?.some((w: Json) => w?.id === widgetId));
  let def: Json;
  for (const l of page.content.layouts)
    for (const s of l?.definition?.page?.sections ?? []) for (const w of s?.widgets ?? []) if (w?.widgetId === widgetId) def = w.definition;
  const reg = page.content.widgets.find((w: Json) => w?.id === widgetId);
  const entity = content.entities.find((e: Json) => e?.id === reg?.definition?.entityId);
  if (style.cssClass !== undefined) def.cssClassName = style.cssClass;
  if (style.radius !== undefined || style.background !== undefined) {
    const border = { format: "all_borders", style: "solid", color: "transparent", thickness: "1", radius: style.radius ?? def.border?.radius ?? 0, max_thickness: "8" };
    def.notFollowTheme = true;
    def.border = border;
    if (entity?.data) {
      entity.data.themeOverrideSettings = {
        ...(entity.data.themeOverrideSettings ?? {}),
        backgroundColor: style.background ?? entity.data.themeOverrideSettings?.backgroundColor ?? "transparent",
        border,
        ...(entity.data.canvasScrolling ? { canvasScrolling: entity.data.canvasScrolling } : {}),
      };
    }
  }
}

export interface BreakpointRule {
  /** applies while the container is at most this wide (px) */
  maxWidth: number;
  /** width of every child in percent */
  width?: number;
  /** children (outline names) hidden at this size */
  hide?: string[];
}

/** Responsive rules of a flow panel (Builder → Responsive Rule Configuration). */
export function setBreakpoints(content: Json, flowPanel: string, rules: BreakpointRule[]) {
  const names = outlineNames(content);
  const id = [...names.entries()].find(([, n]) => n.name === flowPanel)?.[0];
  if (!id) throw new Error(`No flow panel named '${flowPanel}'`);
  const idOf = (name: string) => {
    const hit = [...names.entries()].find(([, n]) => n.name === name)?.[0];
    if (!hit) throw new Error(`No widget named '${name}'`);
    return hit;
  };
  for (const page of storyEntity(content).data.pages) {
    const reg = page?.content?.widgets?.find((w: Json) => w?.id === id);
    if (!reg) continue;
    const entity = content.entities.find((e: Json) => e?.id === reg.definition?.entityId);
    if (entity?.type !== "flowpanel") throw new Error(`'${flowPanel}' is not a flow panel`);
    entity.data.breakPointRules = rules.map((r, i) => ({
      breakPointName: `Break Point ${i + 1}`,
      containerBreakPoint: r.maxWidth,
      widthEntries: r.width !== undefined ? [{ entryId: "*", width: r.width, unit: "percent" }] : [],
      heightEntries: [],
      visibilityEntries: (r.hide ?? []).map((n) => ({ entryId: idOf(n), visible: false })),
    }));
    entity.data.applyRuleInDesignTime = true;
  }
}

/** Move a widget (its layout entry) into another container, e.g. an input control the editor dropped on a card. */
export function moveWidget(content: Json, widgetName: string, container: string) {
  const hit = [...outlineNames(content).entries()].find(([, n]) => n.name === widgetName);
  if (!hit) throw new Error(`No widget named '${widgetName}'`);
  const { layout: target } = containerLayout(content, container);
  let entry: Json;
  for (const page of storyEntity(content).data.pages ?? [])
    for (const l of page?.content?.layouts ?? [])
      for (const s of l?.definition?.page?.sections ?? []) {
        const i = (s?.widgets ?? []).findIndex((w: Json) => w?.widgetId === hit[0]);
        if (i < 0) continue;
        if (l === target) return;
        entry = s.widgets.splice(i, 1)[0];
        if (!s.widgets.length) l.definition.page.sections.splice(l.definition.page.sections.indexOf(s), 1);
      }
  if (!entry) throw new Error(`'${widgetName}' has no canvas layout entry`);
  target.definition.page.sections.push({ sectionId: randomUUID(), definition: { x: 0, y: 0, width: 0, height: 0, title: "Section" }, widgets: [entry] });
}

/**
 * Canvas position of a widget inside its container (dynamicLayout): pixel offsets per side; pass left+right (and
 * top+bottom) to stretch, or width/height for a fixed size.
 */
export function setWidgetPosition(
  content: Json,
  widgetName: string,
  pos: { left?: number; top?: number; right?: number; bottom?: number; width?: number; height?: number },
) {
  const hit = [...outlineNames(content).entries()].find(([, n]) => n.name === widgetName);
  if (!hit) throw new Error(`No widget named '${widgetName}'`);
  let def: Json;
  for (const page of storyEntity(content).data.pages ?? [])
    for (const l of page?.content?.layouts ?? []) for (const s of l?.definition?.page?.sections ?? []) for (const w of s?.widgets ?? []) if (w?.widgetId === hit[0]) def = w.definition;
  if (!def) throw new Error(`'${widgetName}' has no canvas layout entry`);
  // widgets inserted in the editor may have no dynamicLayout yet (fixed x/y/width/height) — start from a complete one
  const d = (def.dynamicLayout ??= {
    left: def.x ?? 0,
    top: def.y ?? 0,
    width: def.width ?? 384,
    height: def.height ?? 384,
    leftUnit: "pixel",
    topUnit: "pixel",
    widthUnit: "pixel",
    heightUnit: "pixel",
    rightUnit: "auto",
    bottomUnit: "auto",
    minWidth: 16,
    minHeight: 16,
    minOccupiedWidth: 48,
    minOccupiedHeight: 32,
    fixedHeight: false,
    fixedWidth: false,
  });
  for (const [k, v] of Object.entries({ minWidth: 16, minHeight: 16, fixedHeight: false, fixedWidth: false, width: def.width ?? 384, height: def.height ?? 384 }))
    if (d[k] === undefined) d[k] = v;
  const set = (k: string, v: number | undefined, unit = "pixel") => {
    if (v === undefined) return;
    d[k] = v;
    d[`${k}Unit`] = unit;
  };
  set("left", pos.left);
  set("top", pos.top);
  set("right", pos.right);
  set("bottom", pos.bottom);
  set("width", pos.width);
  set("height", pos.height);
  // flow panels lay out children by their fixed size
  if (pos.width !== undefined) def.width = pos.width;
  if (pos.height !== undefined) def.height = pos.height;
  if (pos.left !== undefined && pos.right !== undefined && pos.width === undefined) d.widthUnit = "auto";
  if (pos.top !== undefined && pos.bottom !== undefined && pos.height === undefined) d.heightUnit = "auto";
  if (pos.right === undefined && pos.width !== undefined) d.rightUnit = "auto";
  if (pos.bottom === undefined && pos.height !== undefined) d.bottomUnit = "auto";
  d.minOccupiedWidth = Math.min(d.minOccupiedWidth ?? 48, 48);
  d.minOccupiedHeight = Math.min(d.minOccupiedHeight ?? 32, 32);
}

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Text widgets of a story (the text lives in the page registry: definition.text as HTML). */
function textWidgets(content: Json): { name: string; def: Json }[] {
  const names = outlineNames(content);
  const out: { name: string; def: Json }[] = [];
  for (const page of storyEntity(content).data.pages ?? [])
    for (const w of page?.content?.widgets ?? []) if (typeof w?.definition?.text === "string") out.push({ name: names.get(w.id)?.name ?? w.id, def: w.definition });
  return out;
}

/**
 * Set the text of a text widget and keep its formatting: the first text run takes the new text (lines become
 * paragraphs of the same style), further runs are emptied. html replaces the content completely.
 */
export function setWidgetText(content: Json, widgetName: string, opts: { text?: string; html?: string }): string {
  const w = textWidgets(content).find((x) => x.name === widgetName);
  if (!w) throw new Error(`'${widgetName}' is not a text widget`);
  if (opts.html !== undefined) return (w.def.text = opts.html);
  const lines = (opts.text ?? "").split("\n");
  const html = String(w.def.text || "<p></p>");
  const para = html.match(/^\s*(<p[^>]*>)(.*?)<\/p>/s);
  if (!para) return (w.def.text = lines.map((l) => `<p>${escapeHtml(l) || "<br>"}</p>`).join(""));
  // wrapper tags around the first text run of the first paragraph, e.g. <span style="…"><b>…</b></span>
  const inner = para[2];
  const open = inner.match(/^((?:<[^/][^>]*>)*)/)?.[1] ?? "";
  const close = [...open.matchAll(/<([a-z0-9]+)/gi)].map((m) => `</${m[1]}>`).reverse().join("");
  return (w.def.text = lines.map((l) => `${para[1]}${open}${escapeHtml(l) || "<br>"}${close}</p>`).join(""));
}

/** Replace text in all text widgets (only in text, not in tags/attributes). Returns the widgets that changed. */
export function replaceInTexts(content: Json, pairs: { from: string; to: string }[], widgetNames?: string[]): string[] {
  const changed: string[] = [];
  for (const w of textWidgets(content)) {
    if (widgetNames?.length && !widgetNames.includes(w.name)) continue;
    const before = w.def.text;
    w.def.text = before.replace(/>([^<]+)</g, (_m: string, txt: string) => `>${pairs.reduce((t, p) => t.split(escapeHtml(p.from)).join(escapeHtml(p.to)), txt)}<`);
    if (w.def.text !== before) changed.push(w.name);
  }
  return changed;
}

type Sides = number | { top?: number; right?: number; bottom?: number; left?: number };

/**
 * Flow panel layout in one go: inner padding (panelPadding, per side), spacing between children (panelSpacing),
 * order of the children (= order of the sections in its inner layout) and fixed child sizes. SAC CSS has no
 * padding/margin, so spacing belongs here, not in wrapper panels.
 */
export function setFlowLayout(
  content: Json,
  container: string,
  opts: { padding?: Sides; gap?: number | { horizontal?: number; vertical?: number }; order?: string[]; sizes?: Record<string, { width?: number; height?: number }> },
): { children: string[] } {
  const names = outlineNames(content);
  const hit = [...names.entries()].find(([, n]) => n.name === container);
  if (!hit) throw new Error(`No widget named '${container}'`);
  let reg: Json;
  let page: Json;
  for (const p of storyEntity(content).data.pages ?? []) {
    reg = p?.content?.widgets?.find((w: Json) => w?.id === hit[0]);
    if (reg) {
      page = p;
      break;
    }
  }
  const layout = page?.content?.layouts?.find((l: Json) => l?.id === reg?.definition?.layoutIds?.[0]);
  if (!layout) throw new Error(`'${container}' is not a container`);
  const entity = content.entities.find((e: Json) => e?.id === reg.definition?.entityId);
  if ((opts.padding !== undefined || opts.gap !== undefined) && !entity?.data) throw new Error(`'${container}' has no entity for padding/spacing`);
  if (opts.padding !== undefined) {
    const p = typeof opts.padding === "number" ? { top: opts.padding, right: opts.padding, bottom: opts.padding, left: opts.padding } : opts.padding;
    const pad = (entity.data.panelPadding ??= {});
    for (const [side, v] of Object.entries(p)) if (v !== undefined) pad[`${side}Padding`] = { value: v, unit: "pixel" };
  }
  if (opts.gap !== undefined) {
    const g = typeof opts.gap === "number" ? { horizontal: opts.gap, vertical: opts.gap } : opts.gap;
    const sp = (entity.data.panelSpacing ??= {});
    if (g.horizontal !== undefined) sp.horizontalSpacing = g.horizontal;
    if (g.vertical !== undefined) sp.verticalSpacing = g.vertical;
  }
  const sections: Json[] = layout.definition.page.sections;
  const nameOf = (s: Json) => names.get(s?.widgets?.[0]?.widgetId)?.name ?? s?.widgets?.[0]?.widgetId;
  if (opts.order?.length) {
    const unknown = opts.order.filter((n) => !sections.some((s) => nameOf(s) === n));
    if (unknown.length) throw new Error(`Not in '${container}': ${unknown.join(", ")}. Children: ${sections.map(nameOf).join(", ")}`);
    const rank = (s: Json) => {
      const i = opts.order!.indexOf(nameOf(s));
      return i < 0 ? opts.order!.length : i;
    };
    // listed children first in the given order, the rest keep their relative order behind them
    layout.definition.page.sections = sections.map((s, i) => [s, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);
  }
  for (const [name, size] of Object.entries(opts.sizes ?? {})) {
    const sec = layout.definition.page.sections.find((s: Json) => nameOf(s) === name);
    if (!sec) throw new Error(`'${name}' is not in '${container}'`);
    const def = sec.widgets[0].definition;
    const dyn = (def.dynamicLayout ??= {});
    for (const k of ["width", "height"] as const)
      if (size[k] !== undefined) {
        def[k] = size[k];
        dyn[k] = size[k];
        dyn[`${k}Unit`] = "pixel";
      }
  }
  return { children: layout.definition.page.sections.map(nameOf) };
}
