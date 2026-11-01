/**
 * Composites (Stories → Composites), recorded from the composite editor and from Insert → Composite in a story.
 *
 * A composite is a STORY resource with subtype COMPOSITE whose content is shaped like a story (one canvas page,
 * widgets, app entity). Its size is the canvas size of the page layout. Optional interface: app.composite.payload
 * .properties[name] = {id, type, linkedToWidgets: [{widgetId, properties}]}.
 *
 * In a story it is (1) listed in app.compositesInAssets (objectId STORY:<package>:<id>) and (2) placed as a
 * CompositeWidget (resourceId/packageId) with an entity of type "composite".
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "../browser/session.js";
import { dirOf } from "../paths.js";
import { appEntity, contentlib, ensureTenantPackage, loadStory, outlineNames, storyEntity, tenantPackage } from "./content.js";
import { containerLayout, type Position } from "./fragments.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const CREATE_TEMP = resolve(dirOf(import.meta.url), "..", "..", "templates", "composite_create_temp.json");

/** Create a composite in a folder; `prepare` builds its content (bind models, add widgets) before the first save. */
export async function createComposite(opts: {
  name: string;
  description?: string;
  folderId: string;
  user: string;
  /** canvas size of the composite (its size in a story) */
  width?: number;
  height: number;
  prepare: (compositeId: string, content: Json) => Promise<void>;
}): Promise<{ compositeId: string; objectId: string }> {
  await ensureTenantPackage();
  const temp = JSON.parse(readFileSync(CREATE_TEMP, "utf8"));
  temp.data.parentResId = `TEMP_${opts.user}`;
  const content = structuredClone(temp.data.cdata.content);
  const created = await contentlib("createTempContent", temp.data);
  const compositeId = created.resourceId as string;
  if (!compositeId) throw new Error(`createTempContent returned no resourceId: ${JSON.stringify(created).slice(0, 300)}`);
  try {
    const page = storyEntity(content).data.pages[0];
    Object.assign(page.content.layouts[0].definition.page.definition, { height: opts.height, width: opts.width ?? 1920, backgroundColor: "transparent" });
    await opts.prepare(compositeId, content);
    const size = JSON.stringify(content).length;
    const save = (localVer: number) =>
      contentlib("updateContentAndMoveResource", {
        resourceId: compositeId,
        name: opts.name,
        description: opts.description ?? "",
        cdata: {
          storyId: null,
          title: opts.name,
          description: opts.description ?? "",
          isOptimizedEnabled: true,
          tiles: [],
          isSample: false,
          isTemporary: false,
          resourceId: compositeId,
          state: {},
          ownerType: "TEMP",
          ownerId: `TEMP_${opts.user}`,
          parentResId: `TEMP_${opts.user}`,
          shared: false,
          shareResId: "",
          mobileSupport: 0,
          resourceSubtype: "COMPOSITE",
          resourceType: "STORY",
          content,
        },
        mobileSupport: 0,
        updateOpt: {
          dataChangeInsightsSupport: { value: 0 },
          enhancedProperties: { STORY_OPTIMIZED_INFO: "VIEW_EDIT_STORY2", DEFAULT_VIEW_MODE: "view", CONTENT_SIZE: String(size) },
          ignoreVersion: false,
          localVer,
          ignoreSizeLimit: true,
          propertyBag: true,
          videoDataStorySupport: { value: 0 },
        },
        fetchOpt: { bIncDependency: false, bIncSubItems: false },
        resourceSubtype: "COMPOSITE",
        resourceIds: [compositeId],
        targetParentResId: opts.folderId,
      });
    try {
      await save(created.updateCounter ?? 0);
    } catch (e) {
      if (!String(e).includes("INCONSISTENT_VERSION")) throw e;
      await save((created.updateCounter ?? 0) + 1);
    }
    return { compositeId, objectId: `STORY:${tenantPackage()}:${compositeId}` };
  } catch (e) {
    await browser.request("DELETE", `/api/v1/stories/${compositeId}`).catch(() => undefined);
    throw e;
  }
}

/** Place a composite in a story (Insert → Composite): import into the assets, CompositeWidget in the container. */
export function insertComposite(
  content: Json,
  opts: { compositeId: string; packageId?: string; container: string; outlineName: string; position: Position; interfaceProperty?: Json[] },
): { widgetId: string } {
  if ([...outlineNames(content).values()].some((n) => n.name === opts.outlineName)) throw new Error(`Name '${opts.outlineName}' is already used`);
  const pkg = opts.packageId ?? tenantPackage();
  const app = appEntity(content);
  const objectId = `STORY:${pkg}:${opts.compositeId}`;
  app.compositesInAssets = [...new Set([...(app.compositesInAssets ?? []), objectId])];

  const { page, layout, unit } = containerLayout(content, opts.container);
  const widgetId = randomUUID();
  const entityId = randomUUID();
  content.entities.push({ type: "composite", id: entityId, vendorId: "sap.epm.appBuilding.entity.composite.CompositeWidgetVendor", data: { variableScope: "widget" } });
  page.content.widgets.push({
    id: widgetId,
    class: "sap.fpa.ui.appBuilding.entity.composite.CompositeWidget",
    definition: { entityId, data: {}, layoutIds: [randomUUID()] },
    themeClasses: [],
    dimension: { width: 496, height: 416 },
    serviceValidationHashes: {},
    resourceId: opts.compositeId,
    packageId: pkg,
    ...(opts.interfaceProperty?.length ? { interfaceProperty: opts.interfaceProperty } : {}),
  });
  const dynamicLayout = {
    left: 0,
    top: 0,
    leftUnit: unit,
    topUnit: unit,
    rightUnit: "auto",
    bottomUnit: "auto",
    widthUnit: unit,
    heightUnit: unit,
    minWidth: 16,
    minHeight: 16,
    minOccupiedWidth: 48,
    minOccupiedHeight: 32,
    fixedHeight: false,
    fixedWidth: false,
    ...opts.position,
  };
  layout.definition.page.sections.push({
    sectionId: randomUUID(),
    definition: { x: 0, y: 0, width: 0, height: 0, title: "Section" },
    widgets: [{ widgetId, definition: { removeable: true, x: 0, y: 0, height: 0, width: 0, border: {}, dynamicLayout } }],
  });
  app.app.names[JSON.stringify([{ story: "storyID" }, { composite: widgetId }])] = opts.outlineName;
  return { widgetId };
}

/**
 * Property values for a placed composite (recorded: widget.interfaceProperty). Each linked text keeps the composite's
 * own formatting — the value replaces the text of its HTML.
 */
export async function compositePropertyValues(compositeId: string, values: Record<string, string>): Promise<Json[]> {
  const { content } = await loadStory(compositeId);
  const props = content.entities.find((e: Json) => String(e?.id ?? "").endsWith(":application"))?.app?.composite?.payload?.properties ?? {};
  const widgets = new Map<string, Json>();
  for (const page of storyEntity(content).data.pages ?? []) for (const w of page?.content?.widgets ?? []) widgets.set(w.id, w);
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return Object.entries(values).map(([name, value]) => {
    const p = props[name];
    if (!p) throw new Error(`Composite has no property '${name}'. Available: ${Object.keys(props).join(", ") || "none"}`);
    const linked = (p.linkedToWidgets ?? []).flatMap((l: Json) =>
      (l.properties ?? []).map((id: string) => {
        const html = String(widgets.get(l.widgetId)?.definition?.text ?? "<p></p>");
        let done = false;
        const out = html.replace(/>([^<]+)</g, (m, txt) => (done || !txt.trim() ? m : ((done = true), `>${esc(value)}<`)));
        return { type: "text", id, value: done ? out : `<p>${esc(value)}</p>` };
      }),
    );
    return { id: p.id, value, properties: linked };
  });
}

/** Size (canvas of the composite page) and custom property names of a composite. */
export async function describeComposite(compositeId: string): Promise<{ height?: number; width?: number; properties: string[] }> {
  const { content } = await loadStory(compositeId);
  const page = storyEntity(content).data.pages?.[0];
  const def = page?.content?.layouts?.find((l: Json) => l?.id === "boxlayout")?.definition?.page?.definition ?? page?.content?.layouts?.[0]?.definition?.page?.definition;
  const props = content.entities.find((e: Json) => String(e?.id ?? "").endsWith(":application"))?.app?.composite?.payload?.properties ?? {};
  return { height: def?.height, width: def?.width, properties: Object.keys(props) };
}
