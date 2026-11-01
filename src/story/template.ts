/**
 * New story from a story template — what the Stories start page does: create an empty temporary (canvas) story,
 * take over the template's content and save it under a name into a folder.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentlib, ensureTenantPackage, loadStory } from "./content.js";
import { browser } from "../browser/session.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const CREATE_TEMP = resolve(dirOf(import.meta.url), "..", "..", "templates", "create_temp_canvas.json");

export async function createStoryFromTemplate(opts: {
  templateId: string;
  name: string;
  description?: string;
  folderId: string;
  user: string;
  /** adjust the template content before it is saved (bind a model, build the layout, …) */
  prepare?: (storyId: string, content: Json) => Promise<void>;
}): Promise<{ storyId: string; saved: Json }> {
  await ensureTenantPackage();
  const temp = JSON.parse(readFileSync(CREATE_TEMP, "utf8"));
  temp.data.parentResId = `TEMP_${opts.user}`;
  const created = await contentlib(temp.action, temp.data);
  const storyId = created.resourceId as string;
  if (!storyId) throw new Error(`createTempContent returned no resourceId: ${JSON.stringify(created).slice(0, 300)}`);

  try {
    return await fill(storyId, created.updateCounter ?? 0);
  } catch (e) {
    // don't leave an orphaned draft in the user's temp folder
    await browser.request("DELETE", `/api/v1/stories/${storyId}`).catch(() => undefined);
    throw e;
  }

  async function fill(storyId: string, base: number): Promise<{ storyId: string; saved: Json }> {
  const template = await loadStory(opts.templateId);
  const content = template.content;
  content.title = opts.name;
  if (opts.prepare) await opts.prepare(storyId, content);
  const size = JSON.stringify(content).length;
  content.contentSize = size;

  const save = (localVer: number) => contentlib("updateContentAndMoveResource", {
    resourceId: storyId,
    name: opts.name,
    description: opts.description ?? "",
    cdata: {
      storyId: null,
      title: opts.name,
      description: opts.description ?? "",
      isOptimizedEnabled: true,
      tiles: [],
      importPageDetails: [],
      isSample: false,
      isTemporary: false,
      resourceId: storyId,
      state: {},
      ownerType: "TEMP",
      ownerId: `TEMP_${opts.user}`,
      parentResId: `TEMP_${opts.user}`,
      shared: false,
      shareResId: "",
      mobileSupport: 1,
      resourceSubtype: "",
      resourceType: "STORY",
      content,
    },
    mobileSupport: 1,
    updateOpt: {
      dataChangeInsightsSupport: { value: 0 },
      enhancedProperties: { STORY_OPTIMIZED_INFO: "VIEW_EDIT_STORY2", DEFAULT_VIEW_MODE: "view", CONTENT_SIZE: String(size) },
      ignoreVersion: false,
      localVer,
      importPageDetails: [],
      fetchImportPageDetails: true,
      ignoreSizeLimit: true,
      propertyBag: true,
      videoDataStorySupport: { value: 0 },
    },
    fetchOpt: { bIncDependency: false, bIncSubItems: false },
    resourceIds: [storyId],
    targetParentResId: opts.folderId,
  });
  // the server expects the version after its own first touch of the temp story; try reported, then reported + 1
  let saved: Json;
  try {
    saved = await save(base);
  } catch (e) {
    if (!String(e).includes("INCONSISTENT_VERSION")) throw e;
    saved = await save(base + 1);
  }
  return { storyId, saved };
  }
}
