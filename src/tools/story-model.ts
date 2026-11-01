/**
 * Read and modify existing stories through their content document (see src/story/content.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable, config } from "../config.js";
import { applyOp, appEntity, getAt, loadStory, outlineNames, saveStory, summarize, type Selector } from "../story/content.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffJson } from "../story/diff.js";
import { runTransform } from "../story/transform.js";

const snapshotDir = () => join(config.captureDir, "snapshots");
const snapshotFile = (storyId: string, label: string) => join(snapshotDir(), `${storyId}__${label.replace(/[^\w.-]/g, "_")}.json`);


// SAC script names: start with a letter or underscore, then letters, digits, underscores.
const SCRIPT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const selector = z.union([z.string(), z.number(), z.record(z.string(), z.string())]);

function truncate(text: string, max = config.maxOutputChars) {
  return text.length > max ? text.slice(0, max) + `\n…[truncated, ${text.length} chars total]` : text;
}

export function registerStoryModelTools(server: McpServer): void {
  server.tool(
    "sac_story_get",
    `Read an optimized story. Default: a structured summary (pages with nested widget tree incl. outline names, widget ids,
classes, entity types and responsive positions; datasets; scripting; entity counts). With 'path' returns the raw JSON at
that path inside the content document, e.g. ["entities", {"type":"story"}, "data", "pages", 0] or
["entities", {"id":"<widget entity id>"}, "data"]. Selectors {"key":"value"} pick array elements.`,
    {
      storyId: z.string(),
      path: z.array(selector).optional().describe("Path into the content document for raw access"),
      maxChars: z.number().optional(),
    },
    async ({ storyId, path, maxChars }) => {
      try {
        const story = await loadStory(storyId);
        const out = path ? getAt(story.content, path as Selector[]) : summarize(story);
        return toolSuccess(truncate(JSON.stringify(out, null, 2), maxChars));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_rename_widgets",
    "Rename widgets/pages in the story outline (the script names). Identify each by its current outline name or widget id.",
    {
      storyId: z.string(),
      renames: z.array(z.object({ from: z.string().describe("Current name or widget id"), to: z.string() })).min(1),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, renames, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("rename widgets");
        const story = await loadStory(storyId);
        const names = appEntity(story.content).app.names as Record<string, string>;
        const byWidget = outlineNames(story.content);
        const done: { from: string; to: string; widgetId: string }[] = [];
        for (const { from, to } of renames) {
          if (!SCRIPT_NAME.test(to)) throw new Error(`'${to}' is not a valid script name (letters, digits, _; must not start with a digit)`);
          const hit = [...byWidget.entries()].find(([id, n]) => id === from || n.name === from);
          if (!hit) throw new Error(`No widget named or with id '${from}'. Existing: ${[...byWidget.values()].map((n) => n.name).join(", ")}`);
          const clash = Object.entries(names).find(([k, v]) => v === to && k !== hit[1].key);
          if (clash) throw new Error(`Name '${to}' is already used`);
          names[hit[1].key] = to;
          done.push({ from: hit[1].name, to, widgetId: hit[0] });
        }
        const saved = await saveStory(story);
        return toolSuccess({ renamed: done, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_patch",
    `Low-level edit of a story's content document followed by a save (optimistic locking: fails if the story was saved in
between). Ops: set | remove | merge (shallow object merge) | append (array push). Paths as in sac_story_get.
Use sac_story_get with 'path' first to see the exact structure; prefer the dedicated tools where they exist.`,
    {
      storyId: z.string(),
      ops: z
        .array(
          z.object({
            op: z.enum(["set", "remove", "merge", "append"]),
            path: z.array(selector),
            value: z.unknown().optional(),
          }),
        )
        .min(1),
      dryRun: z.boolean().optional().describe("Apply in memory and return the summary without saving"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, ops, dryRun, allowalteration }) => {
      if (!dryRun && !allowalteration) return toolError(ALTERATION_MSG);
      try {
        if (!dryRun) assertWritable("story patch");
        const story = await loadStory(storyId);
        for (const op of ops) applyOp(story.content, op as Parameters<typeof applyOp>[1]);
        if (dryRun) return toolSuccess(truncate(JSON.stringify({ dryRun: true, summary: summarize(story) }, null, 2)));
        const saved = await saveStory(story);
        return toolSuccess({ applied: ops.length, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_transform",
    `Change a story with a JavaScript function body (story patch by function): load → run → snapshot → save, with the
usual version-conflict fallback. The body gets \`content\` (the story document, mutate it) and \`h\` helpers:
h.widget(name) → {id, kind, registry, layoutEntry, section, layout, entity, page}; h.innerLayout(name) (children = its
sections, in order); h.names(); h.story(); h.app(); h.pages(); h.find((value, key) => bool). Return a value to get it
back as 'result'. Sandboxed (no require/fetch), 5 s limit. Before saving, the old version is kept as a local snapshot
(label in the answer, revert with sac_story_diff + patch). dryRun only reports result and changed paths.
Example: const w = h.widget("TE_TITLE_001"); w.registry.definition.text = "<p>Neu</p>"; return w.id;`,
    {
      storyId: z.string(),
      code: z.string().describe("Function body, e.g. 'h.widget(\"X\").layoutEntry.dynamicLayout.top = 8; return \"ok\";'"),
      dryRun: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, code, dryRun, allowalteration }) => {
      if (!dryRun && !allowalteration) return toolError(ALTERATION_MSG);
      try {
        if (!dryRun) assertWritable("story transform");
        const story = await loadStory(storyId);
        const original = structuredClone(story.content);
        const { result, changes, changed } = runTransform(story.content, code);
        if (dryRun || !changes) return toolSuccess(truncate(JSON.stringify({ dryRun: Boolean(dryRun), result, changes, changed }, null, 2)));
        const label = `before_transform_${new Date().toISOString().replace(/[:.]/g, "-")}`;
        mkdirSync(snapshotDir(), { recursive: true });
        writeFileSync(snapshotFile(storyId, label), JSON.stringify({ storyId, label, updateCounter: story.updateCounter, savedAt: new Date().toISOString(), content: original }));
        const saved = await saveStory(story);
        return toolSuccess(truncate(JSON.stringify({ result, changes, changed, snapshot: label, updateCounter: saved.updateCounter }, null, 2)));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_restore",
    "Write a local snapshot (sac_story_snapshot, or the one sac_story_transform keeps) back into the story — undo.",
    { storyId: z.string(), label: z.string(), allowalteration: z.boolean().optional() },
    async ({ storyId, label, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("story restore");
        const snap = JSON.parse(readFileSync(snapshotFile(storyId, label), "utf8"));
        const story = await loadStory(storyId);
        story.content = snap.content;
        const saved = await saveStory(story);
        return toolSuccess({ restored: label, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_snapshot",
    `Save the current content of a story locally (${"captures/snapshots"}) under a label, as the 'before' or 'after' of a diff.`,
    { storyId: z.string(), label: z.string().describe("e.g. 'before', 'with_chart'") },
    async ({ storyId, label }) => {
      try {
        const story = await loadStory(storyId);
        mkdirSync(snapshotDir(), { recursive: true });
        writeFileSync(snapshotFile(storyId, label), JSON.stringify({ storyId, label, updateCounter: story.updateCounter, savedAt: new Date().toISOString(), content: story.content }));
        return toolSuccess({ saved: label, updateCounter: story.updateCounter, bytes: JSON.stringify(story.content).length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_diff",
    `Structural diff between two snapshots of a story (or a snapshot and the live story with to="live"). Arrays with ids are
matched by id. Use it to learn how SAC stores a feature: snapshot, change one thing in the UI and save, diff.`,
    {
      storyId: z.string(),
      from: z.string().describe("Snapshot label"),
      to: z.string().optional().default("live").describe("Snapshot label or 'live'"),
      ignore: z.string().optional().describe("Regex of paths to ignore (e.g. contentSize|modifiedTime)"),
      maxValueChars: z.number().optional().default(400),
      list: z.boolean().optional().describe("Only list the snapshots of this story"),
    },
    async ({ storyId, from, to, ignore, maxValueChars, list }) => {
      try {
        if (list) {
          mkdirSync(snapshotDir(), { recursive: true });
          return toolSuccess(readdirSync(snapshotDir()).filter((f) => f.startsWith(storyId + "__")).map((f) => f.slice(storyId.length + 2, -5)));
        }
        const read = (l: string) => JSON.parse(readFileSync(snapshotFile(storyId, l), "utf8")).content;
        const a = read(from);
        const b = to === "live" ? (await loadStory(storyId)).content : read(to);
        const diff = diffJson(a, b, { maxValueChars, ignore: new RegExp(ignore ?? "\\.contentSize$") });
        return toolSuccess(truncate(JSON.stringify({ changes: diff.length, diff }, null, 2)));
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
