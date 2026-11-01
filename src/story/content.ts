/**
 * Story content I/O and structure.
 *
 * An optimized (story2) story is one JSON document: `content.entities[]` holds
 *   - the story entity (type "story"): pages, filters, theme reference, persisted queries
 *   - the application entity (id "<story>:application"): outline names, events, global variables
 *   - one entity per widget (table, chart, container, lane, …) and per dataset
 * Each page has a widget registry (`content.widgets`: widget id → class → entity id) and a layout tree
 * (`content.layouts`; container widgets point to their inner layouts via `definition.layoutIds`).
 *
 * getContent returns the content as a string and moves the persisted queries out into
 * `cdata.uqmPersistedQueryAndDM`; loadStory puts them back so the result is exactly what
 * updateContent expects.
 */

import { browser } from "../browser/session.js";
import { config } from "../config.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface LoadedStory {
  resourceId: string;
  name: string;
  description: string;
  updateCounter: number;
  mobileSupport: number;
  content: Json;
}

const UQM_FIELDS = ["persistedUqmQuery", "persistedUdm", "preExecuteUqmQueryIds", "uqmVariablesDataModelInfo", "persistedMergeGroupQuery"];

export async function contentlib(action: string, data: unknown): Promise<Json> {
  const tenant = browser.tenantId;
  if (!tenant) throw new Error("Internal tenant id unknown — open SAC in the browser session first.");
  const res = await browser.request("POST", `/sap/fpa/services/rest/epm/contentlib?tenant=${encodeURIComponent(tenant)}`, {
    action,
    data,
  });
  if (res.status >= 400) {
    const text = typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    throw new Error(`contentlib ${action} failed (${res.status}): ${text.slice(0, 2000)}`);
  }
  return res.body;
}

// ── Tenant package ──────────────────────────────────────────────────
// Repository objects live in a tenant-specific package ("t.<ID>"); recorded templates carry the one of the tenant
// they were recorded on and are rewritten to the current tenant's package on use (see substitute in fragments.ts).

export const RECORDED_PACKAGE = "t.ABC123";
let currentPackage: string | undefined;

export function tenantPackage(): string {
  return currentPackage ?? RECORDED_PACKAGE;
}

export async function ensureTenantPackage(): Promise<string> {
  if (currentPackage) return currentPackage;
  const res = await contentlib("getSearchList", { type: "STORY", value: "*", recentlyAccessed: 50, bIncTemporary: false, spaceId: null });
  // objects in someone's My Files (ownerType PRIVATE) are always in the tenant package; public content may come from
  // imported packages (content network, samples, e.g. t.XYZ789) and can outnumber them among recent stories
  const items: Json[] = Array.isArray(res) ? res : [];
  const count = (list: Json[]) => {
    const counts = new Map<string, number>();
    for (const x of list) {
      const m = String(x?.packageId ?? "").match(/^t\.[A-Z0-9]+$/);
      if (m) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  const best = count(items.filter((x) => x?.ownerType === "PRIVATE")) ?? count(items);
  if (!best) throw new Error("Could not detect the tenant package (no stories visible) — create any story in SAC once and retry");
  currentPackage = best;
  return best;
}

export async function loadStory(storyId: string): Promise<LoadedStory> {
  await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
  await ensureTenantPackage();
  const res = await contentlib("getContent", {
    resourceType: "STORY",
    resourceId: storyId,
    oOpt: {
      isMobileMode: false,
      fetchDefaultBookmark: true,
      sTranslationLocale: "en",
      propertyBag: true,
      isStory2: true,
      fetchTheme: true,
      fetchComposite: true,
      optimized: true,
    },
    bIncDependency: false,
  });
  const cdata = res?.cdata;
  if (!cdata?.content) throw new Error(`Story ${storyId} has no content (not a story, or no access).`);
  const content = typeof cdata.content === "string" ? JSON.parse(cdata.content) : cdata.content;
  if (!content.entities) throw new Error("Unsupported story format (no entities) — only optimized stories are supported.");
  // templates, older stories and stories rebuilt in the editor may contain null placeholders
  dropNullEntries(content);
  const uqm = cdata.uqmPersistedQueryAndDM?.data;
  if (uqm) {
    const story = storyEntity(content);
    for (const f of UQM_FIELDS)
      if (uqm[f] !== undefined) story.data[f] = typeof uqm[f] === "string" ? JSON.parse(uqm[f]) : uqm[f];
  }
  return {
    resourceId: res.resourceId,
    name: res.name,
    description: res.description ?? "",
    updateCounter: res.updateCounter,
    mobileSupport: res.mobileSupport ?? 1,
    content,
  };
}

/** Same call the story editor makes on save; fails if someone saved in between (localVer). */
export async function saveStory(story: LoadedStory): Promise<{ updateCounter: number }> {
  dropNullEntries(story.content);
  const size = JSON.stringify(story.content).length;
  story.content.contentSize = size;
  const update = (localVer: number, ignoreVersion = false) => contentlib("updateContent", {
    resourceId: story.resourceId,
    name: story.name,
    description: story.description,
    cdata: story.content,
    mobileSupport: story.mobileSupport,
    updateOpt: {
      dataChangeInsightsSupport: { value: 0 },
      enhancedProperties: { STORY_OPTIMIZED_INFO: "VIEW_EDIT_STORY2", DEFAULT_VIEW_MODE: "view", CONTENT_SIZE: String(size) },
      contentOnly: true,
      ignoreVersion,
      localVer,
      importPageDetails: [],
      fetchImportPageDetails: true,
      ignoreSizeLimit: true,
      propertyBag: true,
      videoDataStorySupport: { value: 0 },
    },
    fetchOpt: { bIncDependency: false, bIncSubItems: false },
  });
  let res: Json;
  try {
    res = await update(story.updateCounter);
  } catch (e) {
    // fresh copies (counter 0) are refused although nobody touched them; only when the server counter is still the
    // one we loaded (nobody else saved in between) the save is repeated without the version check
    if (!String(e).includes("INCONSISTENT_VERSION")) throw e;
    const current = await contentlib("getContent", { resourceType: "STORY", resourceId: story.resourceId, oOpt: { fetchDataInfo: false } });
    if (current?.updateCounter !== story.updateCounter) throw e;
    res = await update(story.updateCounter, true);
  }
  story.updateCounter = res.updateCounter;
  return { updateCounter: res.updateCounter };
}

// ── Structure ───────────────────────────────────────────────────────

/**
 * The story stores the executed query of every widget (persistedUqmQuery, run ahead via preExecuteUqmQueryIds) and
 * opens with them. After a filter change they are stale — a measure filter, for example, lives in them as a formula —
 * so they are dropped and SAC builds them again from the widgets and filters (the editor rewrites them on save).
 */
export function dropPersistedQueries(content: Json) {
  const data = storyEntity(content).data;
  data.persistedUqmQuery = [];
  data.preExecuteUqmQueryIds = [];
  delete data.persistedUqmQueryAndDMInfo;
}

export function storyEntity(content: Json): Json {
  const e = content.entities.find((x: Json) => x.type === "story");
  if (!e) throw new Error("Story entity not found");
  return e;
}

export function appEntity(content: Json): Json {
  const e = content.entities.find((x: Json) => typeof x.id === "string" && x.id.endsWith(":application"));
  if (!e) throw new Error("Application entity not found");
  return e;
}

/** Outline names are keyed by instance ids like [{"story":"storyID"},{"table2":"<widget id>"}]. */
/** Remove null placeholders (entities, pages, page widgets, layouts, sections, section widgets) in place. */
export function dropNullEntries(content: Json): Json {
  content.entities = (content.entities ?? []).filter(Boolean);
  const story = content.entities.find((e: Json) => e.type === "story");
  if (!story?.data) return content;
  story.data.pages = (story.data.pages ?? []).filter(Boolean);
  for (const page of story.data.pages) {
    if (!page.content) continue;
    page.content.widgets = (page.content.widgets ?? []).filter(Boolean);
    page.content.layouts = (page.content.layouts ?? []).filter(Boolean);
    for (const l of page.content.layouts) {
      const pg = l.definition?.page;
      if (!pg) continue;
      pg.sections = (pg.sections ?? []).filter(Boolean);
      for (const sec of pg.sections) sec.widgets = (sec.widgets ?? []).filter(Boolean);
    }
  }
  return content;
}

export function outlineNames(content: Json): Map<string, { key: string; kind: string; name: string }> {
  const names = appEntity(content).app?.names ?? {};
  const byWidget = new Map<string, { key: string; kind: string; name: string }>();
  for (const [key, name] of Object.entries(names)) {
    try {
      const parts = JSON.parse(key) as Record<string, string>[];
      const last = parts.at(-1)!;
      const [kind, id] = Object.entries(last)[0];
      byWidget.set(id, { key, kind, name: String(name) });
    } catch {
      /* not an instance id */
    }
  }
  return byWidget;
}

export interface WidgetNode {
  widgetId: string;
  name?: string;
  kind?: string;
  class: string;
  entityId?: string;
  entityType?: string;
  position?: Json;
  children?: WidgetNode[];
}

const POSITION_KEYS = ["left", "top", "width", "height", "leftUnit", "topUnit", "widthUnit", "heightUnit"];

/** Page → nested widget tree (containers carry their inner layouts' widgets as children). */
export function pageTree(content: Json, page: Json): WidgetNode[] {
  const names = outlineNames(content);
  const entities = new Map<string, Json>(content.entities.filter(Boolean).map((e: Json) => [e.id, e]));
  const registry = new Map<string, Json>((page.content?.widgets ?? []).filter(Boolean).map((w: Json) => [w.id, w]));
  const layouts = new Map<string, Json>((page.content?.layouts ?? []).filter(Boolean).map((l: Json) => [l.id, l]));

  const walkLayout = (layoutId: string, seen: Set<string>): WidgetNode[] => {
    if (seen.has(layoutId)) return [];
    seen.add(layoutId);
    const layout = layouts.get(layoutId);
    if (!layout) return [];
    const out: WidgetNode[] = [];
    for (const section of layout.definition?.page?.sections ?? [])
      for (const w of (section?.widgets ?? []).filter(Boolean)) {
        const reg = registry.get(w.widgetId);
        const n = names.get(w.widgetId);
        const dyn = w.definition?.dynamicLayout ?? {};
        const node: WidgetNode = {
          widgetId: w.widgetId,
          name: n?.name,
          kind: n?.kind,
          class: String(reg?.class ?? "?").split(".").at(-1)!,
          entityId: reg?.definition?.entityId,
          entityType: entities.get(reg?.definition?.entityId)?.type,
          position: Object.fromEntries(POSITION_KEYS.filter((k) => dyn[k] !== undefined).map((k) => [k, dyn[k]])),
        };
        const inner = (reg?.definition?.layoutIds ?? []).flatMap((id: string) => walkLayout(id, seen));
        if (inner.length) node.children = inner;
        out.push(node);
      }
    return out;
  };
  return walkLayout(page.definition?.layoutId, new Set());
}

export function summarize(story: LoadedStory): Json {
  const c = story.content;
  const s = storyEntity(c).data;
  const app = appEntity(c).app ?? {};
  const datasets = c.entities
    .filter((e: Json) => e.type === "dataset")
    .map((e: Json) => ({
      id: e.id,
      model: e.data?.model?.description ?? e.data?.model?.name ?? e.data?.modelId,
      system: e.data?.systemType,
      remote: e.data?.isRemote,
    }));
  const pageNames = outlineNames(c);
  return {
    storyId: story.resourceId,
    name: story.name,
    description: story.description,
    updateCounter: story.updateCounter,
    contentBytes: JSON.stringify(c).length,
    pages: (s.pages ?? []).filter(Boolean).map((p: Json) => ({
      id: p.id,
      title: p.title,
      outlineName: pageNames.get(p.id)?.name,
      behaviorMode: p.definition?.behaviorMode,
      hidden: p.hidden,
      widgets: pageTree(c, p),
    })),
    datasets,
    storyFilters: (s.uqmStoryFilters ?? s.storyFilters ?? []).length,
    theme: s.themingReference ?? null,
    scripting: {
      events: app.events ?? {},
      globalVars: app.globalVars ?? {},
      // script objects and further app-level keys are surfaced as-is until their format is mapped
      otherAppKeys: Object.keys(app).filter(
        (k) => !["names", "events", "globalVars", "devicePreview", "busyIndicatorProperties", "navigation", "scheduling", "planning", "usedApi", "partialLibraryLoading", "loadInvisibleWidgets"].includes(k),
      ),
    },
    entityTypes: c.entities.reduce((acc: Record<string, number>, e: Json) => {
      const t = e.type ?? "?";
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

// ── Generic path access for patches ────────────────────────────────

export type PathSeg = string | number;

/** Path segments may also be selectors like {"id": "..."} or {"type": "story"} to pick an array element. */
export type Selector = PathSeg | Record<string, string>;

export function resolveSeg(node: Json, seg: Selector): PathSeg {
  if (typeof seg === "object") {
    if (!Array.isArray(node)) throw new Error(`Selector ${JSON.stringify(seg)} used on a non-array`);
    const idx = node.findIndex((x: Json) => Object.entries(seg).every(([k, v]) => x?.[k] === v));
    if (idx < 0) throw new Error(`No element matches ${JSON.stringify(seg)}`);
    return idx;
  }
  return seg;
}

export function getAt(root: Json, path: Selector[]): Json {
  let cur = root;
  for (const seg of path) {
    if (cur === undefined || cur === null) throw new Error(`Path not found at ${JSON.stringify(seg)}`);
    cur = cur[resolveSeg(cur, seg)];
  }
  return cur;
}

export function applyOp(root: Json, op: { op: "set" | "remove" | "merge" | "append"; path: Selector[]; value?: Json }) {
  if (op.path.length === 0) throw new Error("Empty path");
  const parent = getAt(root, op.path.slice(0, -1));
  if (parent === undefined || parent === null) throw new Error(`Parent of ${JSON.stringify(op.path)} not found`);
  const key = resolveSeg(parent, op.path.at(-1)!);
  switch (op.op) {
    case "set":
      parent[key] = op.value;
      break;
    case "remove":
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      break;
    case "merge":
      if (typeof parent[key] !== "object" || parent[key] === null) throw new Error(`merge target ${JSON.stringify(op.path)} is not an object`);
      Object.assign(parent[key], op.value);
      break;
    case "append":
      if (!Array.isArray(parent[key])) throw new Error(`append target ${JSON.stringify(op.path)} is not an array`);
      parent[key].push(op.value);
      break;
  }
}
