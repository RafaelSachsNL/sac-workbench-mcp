/**
 * Composites: reusable building blocks (Stories → Composites). Today: the lean 40 px page header.
 * Note: input controls inside a composite only filter widgets inside the composite ("No Connected Widgets" in the
 * story), so filter bars stay normal story tiles.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { browser } from "../browser/session.js";
import { assertWritable, config } from "../config.js";
import { buildHeaderComposite, FILTER_BAR_HEIGHT, HEADER_COMPOSITE_HEIGHT, TILE_MARGIN } from "../story/canvas-dashboard.js";
import { compositePropertyValues, createComposite, insertComposite } from "../story/composite.js";
import { loadStory, outlineNames, saveStory } from "../story/content.js";
import { conventionName, PAGE_NAME } from "../story/naming.js";
import { resolveUser } from "./story.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";


export function registerCompositeTools(server: McpServer): void {
  server.tool(
    "sac_composite_header_create",
    `Create a lean page header composite, 40 px, title only (bold, vertically centred). Title is a composite property,
so every story sets its own text: sac_story_add_composite with role "header" and properties {Title: "…"}.`,
    {
      name: z.string(),
      description: z.string().optional(),
      folderId: z.string().optional().describe("Default: defaults.folderId from the config"),
      title: z.string().describe("Default title text"),
      inverted: z.boolean().optional().describe("Dark header with light text"),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("create composite");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const folderId = args.folderId ?? config.defaults.folderId;
        if (!folderId) throw new Error("folderId missing (and no defaults.folderId in the config)");
        const user = await resolveUser(folderId);
        let widgets: string[] = [];
        const { compositeId } = await createComposite({
          name: args.name,
          description: args.description,
          folderId,
          user,
          height: HEADER_COMPOSITE_HEIGHT,
          prepare: async (_id, content) => {
            widgets = buildHeaderComposite(content, "Page_1", { title: args.title, inverted: args.inverted });
          },
        });
        return toolSuccess({ compositeId, name: args.name, height: HEADER_COMPOSITE_HEIGHT, properties: ["Title"], widgets });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_composite",
    `Place a composite (e.g. a filter bar from sac_composite_filterbar_create) in a story: imports it into the story's
assets and adds it to a container (page outline name like PAGE_1, or a panel). Default position: full width below
the 72 px header with the 4 px tile margin, height 40 px.`,
    {
      storyId: z.string(),
      compositeId: z.string(),
      role: z.enum(["header", "filterbar", "other"]).optional().describe("header: top, full width, no margin; filterbar (default): below a 72 px header, 4 px tile margin"),
      container: z.string().optional().describe("Default: PAGE_1"),
      properties: z.record(z.string(), z.string()).optional().describe("Values for the composite's custom properties, e.g. {Title: 'DemoJuice Sales'}"),
      name: z.string().optional(),
      top: z.number().optional(),
      height: z.number().optional(),
      left: z.number().optional(),
      right: z.number().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, compositeId, role, container, properties, name, top, height, left, right, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add composite");
        const story = await loadStory(storyId);
        const header = role === "header";
        const outlineName = name ?? conventionName("composite", header ? "HEADER" : "FILTERBAR", [...outlineNames(story.content).values()].map((n) => n.name));
        const m = header ? 0 : TILE_MARGIN;
        const interfaceProperty = properties ? await compositePropertyValues(compositeId, properties) : undefined;
        insertComposite(story.content, {
          compositeId,
          interfaceProperty,
          container: container ?? PAGE_NAME(1),
          outlineName,
          position: {
            left: left ?? m,
            right: right ?? m,
            top: top ?? (header ? 0 : 72 + m),
            height: height ?? (header ? HEADER_COMPOSITE_HEIGHT : FILTER_BAR_HEIGHT),
            leftUnit: "pixel",
            rightUnit: "pixel",
            topUnit: "pixel",
            heightUnit: "pixel",
            widthUnit: "auto",
            bottomUnit: "auto",
          },
        });
        const saved = await saveStory(story);
        return toolSuccess({ name: outlineName, compositeId, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
