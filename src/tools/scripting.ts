/**
 * Scripting tools: global variables, script objects (functions) and event scripts, following the naming
 * convention (gv_camelCase, SO_<PURPOSE>, functions camelCase by purpose).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable } from "../config.js";
import { browser } from "../browser/session.js";
import { loadStory, saveStory } from "../story/content.js";
import { addDataActionObject, listScripts, removeFunction, removeGlobalVariable, setEvent, setFunction, setGlobalVariable } from "../story/scripting.js";
import { ensureTenantPackage, outlineNames } from "../story/content.js";
import { addButton } from "../story/buttons.js";
import { conventionName } from "../story/naming.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";


const conventionFlag = z.boolean().optional().describe("Set false to allow names outside the convention (existing stories)");

export function registerScriptingTools(server: McpServer): void {
  server.tool(
    "sac_scripts_get",
    "All scripting of a story: global variables, script objects with their functions (signature + code) and event scripts per page/widget.",
    { storyId: z.string() },
    async ({ storyId }) => {
      try {
        return toolSuccess(listScripts((await loadStory(storyId)).content));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_script_variable_set",
    "Create or update a global script variable (convention gv_camelCase, e.g. gv_CountryArray). Types: string, boolean, integer, number or an SAC type.",
    {
      storyId: z.string(),
      name: z.string(),
      type: z.string().default("string"),
      isArray: z.boolean().optional(),
      defaultValue: z.string().optional(),
      description: z.string().optional(),
      remove: z.boolean().optional().describe("Delete the variable instead"),
      enforceConvention: conventionFlag,
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, remove, enforceConvention, allowalteration, ...v }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set script variable");
        const story = await loadStory(storyId);
        if (remove) removeGlobalVariable(story.content, v.name);
        else setGlobalVariable(story.content, v, { enforceConvention });
        const saved = await saveStory(story);
        return toolSuccess({ variable: v.name, removed: Boolean(remove), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_script_function_set",
    `Create or update a function in a script object (created if missing; convention SO_<PURPOSE>, functions camelCase by
purpose, e.g. SO_KPI.setKPIValues). Argument/return types: string, boolean, integer, number, void or widget types such
as Panel, Chart, Table, Button (written as "+Panel" internally).`,
    {
      storyId: z.string(),
      scriptObject: z.string(),
      name: z.string(),
      returnType: z.string().optional(),
      args: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean().optional(), isArray: z.boolean().optional() })).optional(),
      body: z.string().describe("Function body (script code)"),
      remove: z.boolean().optional().describe("Delete the function instead"),
      enforceConvention: conventionFlag,
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, scriptObject, remove, enforceConvention, allowalteration, ...fn }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set script function");
        const story = await loadStory(storyId);
        if (remove) removeFunction(story.content, scriptObject, fn.name);
        else setFunction(story.content, scriptObject, fn, { enforceConvention });
        const saved = await saveStory(story);
        return toolSuccess({ function: `${scriptObject}.${fn.name}`, removed: Boolean(remove), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_script_event_set",
    `Set the event script of a page or widget by outline name, e.g. PAGE_1 onInitialization, a button's onClick, a
chart's onSelect, an input control's onSelect. An empty body removes the script.`,
    {
      storyId: z.string(),
      target: z.string().describe("Outline name of the page or widget"),
      event: z.string().describe("e.g. onInitialization, onActive, onClick, onSelect, onResultChanged"),
      body: z.string(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, target, event, body, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set event script");
        const story = await loadStory(storyId);
        setEvent(story.content, target, event, body);
        const saved = await saveStory(story);
        return toolSuccess({ target, event, removed: !body.trim(), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_check_runtime",
    `Debug a story: open it in the browser (view mode by default), wait until it has loaded and return script errors,
console errors/warnings, uncaught page errors and the error notifications SAC displays. Use after changing scripts.`,
    {
      storyId: z.string(),
      mode: z.enum(["view", "edit"]).optional(),
      timeoutMs: z.number().optional(),
      onlyErrors: z.boolean().optional().describe("Drop console warnings (default true)"),
    },
    async ({ storyId, mode, timeoutMs, onlyErrors }) => {
      try {
        const r = await browser.runStory(storyId, { mode, timeoutMs });
        // SAC logs this once per widget on every load of a story saved via API; it is harmless
        const noise = (m: { text: string }) => /marked as dirty during load/.test(m.text);
        const ignored = r.console.filter(noise).length;
        const kept = r.console.filter((m) => !noise(m));
        const consoleMsgs = (onlyErrors ?? true) ? kept.filter((m) => m.type === "error") : kept;
        return toolSuccess({ ...r, console: consoleMsgs, ...(ignored ? { ignoredDirtyOnLoad: ignored } : {}), ok: !r.pageErrors.length && !consoleMsgs.length && !r.notifications.length });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_inspect",
    `Layout check: open the story at one or more widths (e.g. [1280, 760, 420]; below ~616 px use mode "present",
the SAC shell has a min width) and report per widget: scrollbars inside containers (content larger than the box),
widgets sticking out of their parent, and runtime errors. widget = outline name → PNG of that widget (hover: with
mouse over it). Read-only; use after layout/CSS changes instead of screenshots by eye.`,
    {
      storyId: z.string(),
      widths: z.array(z.number().int().min(320).max(3840)).min(1).max(5).optional().describe("Default [1600]"),
      height: z.number().int().optional(),
      mode: z.enum(["view", "present"]).optional(),
      widget: z.string().optional().describe("Outline name for a widget screenshot (taken at the last width)"),
      hover: z.boolean().optional(),
    },
    async ({ storyId, widths, height, mode, widget, hover }) => {
      try {
        const story = await loadStory(storyId);
        const names = outlineNames(story.content);
        const idOf = widget ? [...names.entries()].find(([, n]) => n.name === widget)?.[0] : undefined;
        if (widget && !idOf) throw new Error(`No widget named '${widget}'`);
        const ws = widths ?? [1600];
        const res = await browser.inspectStory(storyId, { widths: ws, height, mode, widget: idOf, hover });
        const report = res.map((r) => ({
          width: r.width,
          ok: !r.issues.length,
          issues: r.issues.map((i) => ({ widget: names.get(i.widgetId)?.name ?? i.widgetId, kind: i.kind, detail: i.detail.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => names.get(id)?.name ?? id) })),
          errors: r.errors,
        }));
        const png = res.at(-1)?.png;
        const text = { type: "text" as const, text: JSON.stringify({ storyId, report }, null, 2) };
        return png ? { content: [text, { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" }] } : { content: [text] };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_dataaction",
    `Add a data action to a story as scripting object (e.g. DA_PLAN_COPY) with a fixed target version. Run it from a
script, e.g. sac_script_event_set on a button onClick: DA_PLAN_COPY.execute();`,
    {
      storyId: z.string(),
      name: z.string().describe("Scripting name, e.g. DA_PLAN_COPY"),
      dataActionId: z.string(),
      targetVersion: z.string().describe("e.g. public.Plan"),
      autoPublish: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, name, dataActionId, targetVersion, autoPublish, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add data action object");
        const story = await loadStory(storyId);
        addDataActionObject(story.content, { name, dataActionId, targetVersion, autoPublish, tenantPackage: await ensureTenantPackage() });
        const saved = await saveStory(story);
        return toolSuccess({ name, updateCounter: saved.updateCounter, usage: `${name}.execute();` });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_button",
    `Add a button with an onClick script to a container (page outline name or panel), e.g. text "Plan berechnen" and
onClick "DA_PLAN_PLUS5.execute(); TA_PLANUNG_001.getDataSource().refreshData();". Name defaults to BT_<TEXT>_NNN.`,
    {
      storyId: z.string(),
      container: z.string(),
      text: z.string(),
      name: z.string().optional(),
      onClick: z.string().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      right: z.number().optional().describe("Anchor to the right edge instead of left (pixels)"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, container, text, name, onClick, left, top, width, height, right, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add button");
        const story = await loadStory(storyId);
        const outlineName = name ?? conventionName("button", text, [...outlineNames(story.content).values()].map((n) => n.name));
        const position = {
          ...Object.fromEntries(Object.entries({ left, top, width, height }).filter(([, v]) => v !== undefined)),
          ...(right !== undefined ? { right, rightUnit: "pixel", leftUnit: "auto" } : {}),
        };
        addButton(story.content, { container, outlineName, text, onClick, position });
        const saved = await saveStory(story);
        return toolSuccess({ name: outlineName, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
