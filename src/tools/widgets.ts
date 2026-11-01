/**
 * Widget fragments as tools: learn a widget once from the UI (extract), then add it to any story.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertWritable, config } from "../config.js";
import { contentlib, loadStory, outlineNames, saveStory } from "../story/content.js";
import { browser } from "../browser/session.js";
import { conventionName } from "../story/naming.js";
import { addStoryFilter } from "../story/filters.js";
import { applyThemeProfile, captureThemeProfile, listThemeProfiles } from "../story/themes.js";
import { formatViz, applyMinimalStyle } from "../story/format.js";
import { addSwapControl } from "../story/swapcontrols.js";
import { SIGNAL_COLOR_NOTE, signalColorsIn } from "../story/colors.js";
import { addInputControl } from "../story/inputcontrols.js";
import { getStoryCss, setStoryCss, upsertCssClass } from "../story/css.js";
import { moveWidget, replaceInTexts, setFlowLayout, setWidgetPosition, setWidgetText, styleWidget } from "../story/canvas.js";
import { createTheme, setStoryTheme, syncStoryTheme, themeCss, updateTheme } from "../story/theme-create.js";
import { THEME_CSS_LIMIT, validateCss } from "../story/css-validate.js";
import { listDesignAssets } from "../story/assets.js";
import { addThreshold, attachThreshold } from "../story/thresholds.js";
import { addMeasureVariance, calculation, modelMeasure } from "../story/variance.js";
import { addCalcToViz, addRestrictedMeasure, dropPreExecute, removeMeasureFromViz } from "../story/calculations.js";
import { extractFragment, insertFragment, removeWidget, storyModel, textToHtml, type Fragment } from "../story/fragments.js";
import { fetchModelMetadata, resolveDimension, resolveMeasure } from "../story/metadata.js";
import { ALTERATION_MSG, toolError, toolSuccess } from "./_helpers.js";
import { dirOf } from "../paths.js";
import { applyChart, CHART_TYPES, readChart } from "../story/chart.js";
import { allColors, chartDatasets, setSeriesColors } from "../story/series-colors.js";
import { upsertCalculatedMeasure, upsertRestrictedMeasure } from "../story/calc-build.js";
import { duplicateWidget } from "../story/duplicate.js";

const SCRIPT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FRAGMENT_DIR = resolve(dirOf(import.meta.url), "..", "..", "templates", "fragments");
const fragmentFile = (name: string) => join(FRAGMENT_DIR, `${name.replace(/[^\w.-]/g, "_")}.json`);
const snapshotFile = (storyId: string, label: string) =>
  join(config.captureDir, "snapshots", `${storyId}__${label.replace(/[^\w.-]/g, "_")}.json`);

export function registerWidgetTools(server: McpServer): void {
  server.tool(
    "sac_fragment_extract",
    `Learn a widget type: after building it once in the SAC UI, lift everything SAC stores for it into a reusable
fragment (templates/fragments/<name>.json). Needs a snapshot from before the widget was added (sac_story_snapshot) and
compares it with the live story. Name the dimensions and measures the widget uses so they can be swapped on insert.`,
    {
      storyId: z.string(),
      before: z.string().describe("Snapshot label from before the widget was added"),
      after: z.string().optional().describe("Snapshot label with the widget; default: the live story"),
      widgetName: z.string().describe("Outline name of the new widget, e.g. Chart_1"),
      name: z.string().describe("Fragment name, e.g. chart_bar_1dim_1measure"),
      description: z.string(),
      dimensions: z.array(z.string()).describe("Dimensions the widget uses, in slot order (caption or InA name)"),
      measures: z.array(z.string()).describe("Measures the widget uses, in slot order"),
      textMarker: z.string().optional().describe("For text widgets: the marker text typed into it, becomes the text slot"),
    },
    async ({ storyId, before, after, widgetName, name, description, dimensions, measures, textMarker }) => {
      try {
        const readSnap = (l: string) => JSON.parse(readFileSync(snapshotFile(storyId, l), "utf8")).content;
        const base = readSnap(before);
        const current = after ? readSnap(after) : (await loadStory(storyId)).content;
        const model = storyModel(current);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const frag = extractFragment(base, current, {
          widgetName,
          name,
          description,
          dimensions: dimensions.map((d) => resolveDimension(meta, d)),
          measures: measures.map((m) => resolveMeasure(meta, m)),
          textMarker,
        });
        mkdirSync(FRAGMENT_DIR, { recursive: true });
        writeFileSync(fragmentFile(name), JSON.stringify(frag));
        return toolSuccess({
          saved: fragmentFile(name),
          kind: frag.kind,
          parts: {
            entities: frag.parts.entities.map((e) => e.type),
            queries: frag.parts.queries.length,
            preExecute: frag.parts.preExecute.length,
            udm: frag.parts.udm.length,
          },
          tokens: frag.tokens,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool("sac_fragment_list", "List the widget fragments available for sac_story_add_widget.", {}, async () => {
    try {
      mkdirSync(FRAGMENT_DIR, { recursive: true });
      return toolSuccess(
        readdirSync(FRAGMENT_DIR)
          .filter((f) => f.endsWith(".json"))
          .map((f) => {
            const fr = JSON.parse(readFileSync(join(FRAGMENT_DIR, f), "utf8")) as Fragment;
            return {
              name: fr.name,
              description: fr.description,
              kind: fr.kind,
              dimensionSlots: fr.tokens.dimensions.length,
              measureSlots: fr.tokens.measures.length,
              textSlot: Boolean(fr.tokens.textMarker),
            };
          }),
      );
    } catch (err) {
      return toolError(err);
    }
  });

  server.tool(
    "sac_story_add_widget",
    `Add a widget from a fragment (see sac_fragment_list) to a story: into a container (lane/panel, by outline name) at a
position in grid units, bound to the story's model with the given dimensions and measures, under an outline name.`,
    {
      storyId: z.string(),
      fragment: z.string(),
      container: z.string().describe("Outline name of the target container, e.g. Lane_1"),
      name: z.string().optional().describe("Outline (script) name; default: convention from 'content', e.g. CH_BAR_SALES_001"),
      content: z.string().optional().describe("What the widget shows (e.g. 'Sales by Region'), used for the conventional name"),
      dimensions: z.array(z.string()).default([]).describe("Caption or InA name per dimension slot"),
      measures: z.array(z.string()).default([]).describe("Measure per measure slot"),
      position: z
        .object({
          left: z.number().optional(),
          top: z.number().optional(),
          width: z.number().optional(),
          height: z.number().optional(),
          widthUnit: z.enum(["grid", "pixel", "percent", "auto"]).optional(),
          heightUnit: z.enum(["grid", "pixel", "percent", "auto"]).optional(),
        })
        .optional()
        .describe("Lane: grid units (36 columns). Flow panel: pixels by default; widthUnit 'percent' for responsive widths"),
      datasetId: z.string().optional().describe("Only needed if the story has several datasets"),
      text: z.string().optional().describe("Text widgets: plain text (\\n = new paragraph)"),
      html: z.string().optional().describe("Text widgets: HTML instead of plain text, e.g. <p><b>Title</b></p>"),
      allowalteration: z.boolean().optional(),
    },
    async (args) => {
      if (!args.allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add widget");
        const frag = JSON.parse(readFileSync(fragmentFile(args.fragment), "utf8")) as Fragment;
        const story = await loadStory(args.storyId);
        // page suffix only when the story has several pages: the page that holds the target container
        const pages: { content?: { widgets?: { id: string }[] } }[] =
          story.content.entities.find((e: { type?: string }) => e.type === "story")?.data?.pages ?? [];
        const names = outlineNames(story.content);
        const containerId = [...names.entries()].find(([, n]) => n.name === args.container)?.[0];
        const pageIdx = pages.findIndex((p) => p.content?.widgets?.some((w) => w.id === containerId));
        const name =
          args.name ??
          conventionName(
            args.fragment,
            args.content ?? (args.measures[0] || args.fragment),
            [...names.values()].map((n) => n.name),
            pages.length > 1 && pageIdx >= 0 ? pageIdx + 1 : undefined,
          );
        if (!SCRIPT_NAME.test(name)) throw new Error(`'${name}' is not a valid script name`);
        // Widgets without data (text, shapes, containers) keep their parts free of the source model.
        const needsModel = JSON.stringify(frag.parts).includes(frag.tokens.model.cubeId);
        const model = needsModel ? storyModel(story.content, args.datasetId) : frag.tokens.model;
        const meta = needsModel ? await fetchModelMetadata(model.connection, model.space, model.model) : undefined;
        const { widgetId } = insertFragment(story.content, frag, {
          container: args.container,
          outlineName: name,
          position: args.position,
          model,
          dimensions: meta ? args.dimensions.map((d) => resolveDimension(meta, d)) : [],
          measures: meta ? args.measures.map((m) => resolveMeasure(meta, m)) : [],
          allMeasures: meta ? meta.measures.map((m) => m.name) : [],
          html: args.html ?? (args.text !== undefined ? textToHtml(args.text) : undefined),
        });
        const saved = await saveStory(story);
        return toolSuccess({ widgetId, name, fragment: frag.name, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_filter",
    "Add a story filter (applies to all pages and widgets of the dataset) on one dimension, restricted to the given members (member keys, e.g. PC2).",
    {
      storyId: z.string(),
      dimension: z.string().describe("Caption or InA name"),
      members: z.array(z.union([z.string(), z.object({ key: z.string(), caption: z.string().optional() })])).min(1),
      datasetId: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, dimension, members, datasetId, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add story filter");
        const story = await loadStory(storyId);
        const model = storyModel(story.content, datasetId);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const dim = resolveDimension(meta, dimension);
        const id = addStoryFilter(story.content, model, dim, members.map((m) => (typeof m === "string" ? { key: m } : m)));
        const saved = await saveStory(story);
        return toolSuccess({ filterId: id, dimension: `${dim.caption} (${dim.name})`, members, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_input_control",
    `Add an input control to a container (page outline name like PAGE_1, panel or flow panel); it filters every widget on
the page. kind "member" (default): member filter on a dimension. kind "measureRange": measure filter — keeps the members of
the context dimension whose measure value lies in the ranges (e.g. Gross_Sales 0–100 Mio per DJ_State).
kind "measureSwap" / "dimensionSwap": the viewer switches which measure / dimension the linked charts show (options + charts;
dimension is ignored, pass any). Not filters: they change the chart axis.
Minimal look: no header icon (hideIcon defaults to true). Name defaults to the convention (IC_<DIMENSION>_NNN).`,
    {
      storyId: z.string(),
      container: z.string().describe("Outline name of the page or container"),
      kind: z.enum(["member", "measureRange", "measureSwap", "dimensionSwap"]).optional(),
      dimension: z.string().describe("Caption or InA name (measureRange: the dimension context)"),
      name: z.string().optional(),
      members: z.array(z.string()).optional().describe("member: initially selected member keys; empty = all"),
      measure: z.string().optional().describe("measureRange: measure (caption or technical name)"),
      ranges: z.array(z.object({ start: z.number(), end: z.number() })).optional().describe("measureRange: value ranges (between, inclusive)"),
      options: z.array(z.string()).optional().describe("measureSwap/dimensionSwap: measures or dimensions to choose from (first = initial)"),
      charts: z.array(z.string()).optional().describe("measureSwap/dimensionSwap: outline names of the charts that follow the control"),
      title: z.string().optional().describe("Title shown in the control (member filter: instead of the dimension caption, e.g. 'Fiscal Year' for FISCALYEAR)"),
      hideIcon: z.boolean().optional(),
      left: z.number().optional(),
      top: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, container, kind, dimension, name, members, measure, ranges, options, charts, title, hideIcon, left, top, width, height, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add input control");
        const story = await loadStory(storyId);
        const model = storyModel(story.content);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const position = Object.fromEntries(Object.entries({ left, top, width, height }).filter(([, v]) => v !== undefined));
        const taken = [...outlineNames(story.content).values()].map((n) => n.name);
        if (kind === "measureSwap" || kind === "dimensionSwap") {
          if (!options?.length || !charts?.length) throw new Error(`${kind} needs options and charts`);
          const isMeasure = kind === "measureSwap";
          const resolved = options.map((o) => (isMeasure ? resolveMeasure(meta, o) : resolveDimension(meta, o)));
          const ids = resolved.map((r) => (typeof r === "string" ? r : r.name));
          const captions = resolved.map((r) => (typeof r === "string" ? r : r.caption));
          const byName = new Map([...outlineNames(story.content).entries()].map(([id, n]) => [n.name, id]));
          const chartIds = charts.map((c) => {
            const id = byName.get(c);
            if (!id) throw new Error(`No widget named '${c}'`);
            return id;
          });
          const label = title ?? (isMeasure ? "Measure" : "Dimension");
          const outlineName = name ?? conventionName("input_control", label, taken);
          addSwapControl(story.content, { kind: isMeasure ? "measure" : "dimension", container, outlineName, title: label, options: ids, captions, charts: chartIds, position, hideIcon });
          const saved = await saveStory(story);
          return toolSuccess({ name: outlineName, kind, options: ids, charts, updateCounter: saved.updateCounter });
        }
        const dim = resolveDimension(meta, dimension);
        const outlineName = name ?? conventionName("input_control", kind === "measureRange" && measure ? measure : dim.caption, taken);
        if (kind === "measureRange") {
          if (!measure || !ranges?.length) throw new Error("measureRange needs measure and ranges");
          const range = { measure: resolveMeasure(meta, measure), context: dim, ranges };
          addInputControl(story.content, { container, outlineName, range, hideIcon, position });
        } else addInputControl(story.content, { container, outlineName, dimension: dim, members, hideIcon, position, title });
        const saved = await saveStory(story);
        return toolSuccess({ name: outlineName, dimension: `${dim.caption} (${dim.name})`, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_css",
    `Read or change the story CSS (Edit CSS on story level). action get | set (replace all) | class (insert/replace one
class: className + widget type panel/flowpanel/text/button or a raw inner selector + declarations). Assign the class to
widgets with sac_story_style_widget.`,
    {
      storyId: z.string(),
      action: z.enum(["get", "set", "class"]),
      css: z.string().optional().describe("For set"),
      className: z.string().optional(),
      widget: z.string().optional().describe("panel | flowpanel | text | button | any | raw selector"),
      declarations: z.string().optional().describe("e.g. 'border-left: 4px solid #0A6ED1; background-color: #fff'"),
      forceCss: z.boolean().optional().describe("Save even if the CSS check reports problems"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, action, css, className, widget, declarations, forceCss, allowalteration }) => {
      try {
        const story = await loadStory(storyId);
        if (action === "get") return toolSuccess({ css: getStoryCss(story.content) });
        if (!allowalteration) return toolError(ALTERATION_MSG);
        assertWritable("change story css");
        let block: string | undefined;
        if (action === "set") setStoryCss(story.content, css ?? "");
        else {
          if (!className || !declarations) throw new Error("class needs className and declarations");
          block = upsertCssClass(story.content, className, widget ?? "any", declarations);
        }
        // SAC stores story CSS unchecked; unsupported rules may work today but are not supported → refuse unless forced
        const cssErrors = validateCss(action === "set" ? (css ?? "") : (block ?? ""));
        if (cssErrors.length && !forceCss) return toolSuccess({ needsInput: true, note: "Story CSS NOT saved: it breaks SAC rules (forceCss overrides).", cssErrors });
        const saved = await saveStory(story);
        return toolSuccess({ ...(block ? { block } : {}), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_style_widget",
    "Set CSS class, corner radius and/or background of a widget (Styling panel). cards: cssClass 'card', radius 12.",
    {
      storyId: z.string(),
      widget: z.string().describe("Outline name"),
      cssClass: z.string().optional(),
      radius: z.number().optional(),
      background: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, cssClass, radius, background, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("style widget");
        const story = await loadStory(storyId);
        styleWidget(story.content, widget, { cssClass, radius, background });
        const saved = await saveStory(story);
        return toolSuccess({ widget, cssClass, radius, background, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_theme_capture",
    "Save the theme of a story (which already has the wanted theme applied in the UI) as a reusable theme profile.",
    { storyId: z.string(), name: z.string().describe("Profile name, e.g. MY_THEME") },
    async ({ storyId, name }) => {
      try {
        return toolSuccess(captureThemeProfile((await loadStory(storyId)).content, name));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_apply_theme",
    "Apply a theme profile (see sac_theme_capture) to a story. Available profiles are listed when the name is unknown.",
    { storyId: z.string(), theme: z.string(), allowalteration: z.boolean().optional() },
    async ({ storyId, theme, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("apply theme");
        if (!listThemeProfiles().includes(theme)) throw new Error(`Unknown theme profile '${theme}'. Available: ${listThemeProfiles().join(", ")}`);
        const story = await loadStory(storyId);
        applyThemeProfile(story.content, theme);
        const saved = await saveStory(story);
        return toolSuccess({ theme, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  const themeChanges = {
    palette: z
      .array(z.string())
      .optional()
      .describe("Standard palette (series colours), neutral first, e.g. ['#1d2d3e','#3d6f8f','#8396a8',…]. Red/green are refused unless confirmSignalColors"),
    css: z.string().optional().describe("Theme CSS. Checked against the SAC CSS rules first (one invalid rule makes SAC drop the whole theme CSS)"),
    cssMode: z.enum(["append", "replace", "upsert"]).optional().describe("append (default) · replace all · upsert: a rule with the same selector replaces the old one"),
    cssRemove: z.array(z.string()).optional().describe("Selectors whose rules are removed from the theme CSS"),
    forceCss: z.boolean().optional().describe("Save even if the CSS check reports problems or the size limit is exceeded"),
    canvasBackground: z.string().optional(),
    panelRadius: z.number().optional(),
    positiveColor: z.string().optional(),
    negativeColor: z.string().optional(),
    confirmSignalColors: z
      .boolean()
      .optional()
      .describe("Only after the user was told the drawbacks and still wants red/green series colours"),
  };

  /** Red/green as series colours: ask instead of applying (variance/highlight colours). */
  const signalColorCheck = (palette?: string[], confirmed?: boolean) => {
    const hits = signalColorsIn(palette);
    if (!hits.length || confirmed) return undefined;
    return toolSuccess({
      needsInput: true,
      note: "Theme was NOT changed. Please clarify with the user.",
      signalColors: hits.map((h) => `${h.color} (Position ${h.index + 1}: ${h.signal === "red" ? "red" : "green"})`),
      why: SIGNAL_COLOR_NOTE,
      question: "Make the palette neutral (red/green only for variances and highlights), or keep these colours on purpose?",
      options: ["Neutral palette (recommended)", "Keep them anyway (confirmSignalColors: true)"],
    });
  };

  server.tool(
    "sac_theme_create",
    `Create a theme (repository object) derived from a base theme (name or id, see sac_design_assets → themes) with
changes: palette, theme CSS, canvas background, panel radius, variance colours.`,
    { baseTheme: z.string(), name: z.string(), description: z.string().optional(), folderId: z.string(), ...themeChanges, allowalteration: z.boolean().optional() },
    async ({ baseTheme, name, description, folderId, allowalteration, confirmSignalColors, ...changes }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      const ask = signalColorCheck(changes.palette, confirmSignalColors);
      if (ask) return ask;
      try {
        assertWritable("create theme");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const themes = (await listDesignAssets()).themes;
        const base = themes.find((t) => t.resourceId === baseTheme || t.name === baseTheme);
        if (!base) throw new Error(`Theme '${baseTheme}' not found. Available: ${themes.map((t) => t.name).join(", ")}`);
        const { forceCss, ...rest } = changes;
        const cssErrors = rest.css ? validateCss(rest.css, "theme") : [];
        if (cssErrors.length && !forceCss) return toolSuccess({ needsInput: true, note: "Theme NOT created: CSS breaks SAC rules (SAC would drop the whole theme CSS).", cssErrors });
        const { themeId } = await createTheme({ baseThemeId: base.resourceId, name, description, folderId, changes: rest });
        return toolSuccess({ themeId, name, base: base.name });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_theme_update",
    `Change an existing theme in place (palette, CSS, canvas background, panel radius, variance colours). CSS is checked
against the SAC rules and the size limit of the story copy (~76,000 chars) before saving. Stories keep their own copy
of the theme: pass 'stories' (ids) to update those copies too — otherwise the new theme CSS does not show there.`,
    {
      themeId: z.string(),
      ...themeChanges,
      stories: z.array(z.string()).optional().describe("Story ids whose theme copy is refreshed"),
      dryRun: z.boolean().optional().describe("Only check and report (CSS problems, final size)"),
      allowalteration: z.boolean().optional(),
    },
    async ({ themeId, allowalteration, confirmSignalColors, stories, dryRun, forceCss, ...changes }) => {
      if (!allowalteration && !dryRun) return toolError(ALTERATION_MSG);
      const ask = signalColorCheck(changes.palette, confirmSignalColors);
      if (ask) return ask;
      try {
        if (!dryRun) assertWritable("update theme");
        await browser.ensureLoggedIn({ headless: config.headless, timeoutMs: 30_000 });
        const cssErrors = changes.css ? validateCss(changes.css, "theme") : [];
        const preview = await updateTheme(themeId, changes, { dryRun: true });
        const cssSize = themeCss(preview.cdata).length;
        const tooBig = cssSize > THEME_CSS_LIMIT;
        if (dryRun) return toolSuccess({ dryRun: true, cssErrors, cssSize, cssLimit: THEME_CSS_LIMIT });
        if ((cssErrors.length || tooBig) && !forceCss)
          return toolSuccess({
            needsInput: true,
            note: "Theme NOT changed." + (cssErrors.length ? " CSS breaks SAC rules – SAC would drop the whole theme CSS." : "") + (tooBig ? ` Theme CSS would have ${cssSize} characters; the story copy is cut off at ~${THEME_CSS_LIMIT} → remove rules with cssRemove.` : ""),
            cssErrors,
            cssSize,
          });
        const saved = await updateTheme(themeId, changes);
        const synced: string[] = [];
        const skipped: string[] = [];
        for (const id of stories ?? []) {
          const story = await loadStory(id);
          if (!syncStoryTheme(story.content, themeId, saved)) {
            skipped.push(id);
            continue;
          }
          await saveStory(story);
          synced.push(id);
        }
        return toolSuccess({
          themeId,
          version: saved.version,
          cssSize,
          updated: Object.keys(changes).filter((k) => (changes as Record<string, unknown>)[k] !== undefined),
          ...(stories?.length ? { storiesSynced: synced, storiesNotUsingTheme: skipped } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_set_theme",
    "Assign a theme (repository object, by name or id) to a story.",
    { storyId: z.string(), theme: z.string(), allowalteration: z.boolean().optional() },
    async ({ storyId, theme, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set story theme");
        const story = await loadStory(storyId);
        const themes = (await listDesignAssets()).themes;
        const t = themes.find((x) => x.resourceId === theme || x.name === theme);
        if (!t) throw new Error(`Theme '${theme}' not found`);
        const full = await contentlib("getResourceEx", { resourceId: t.resourceId, metadata: { name: true, packageId: true, updateCounter: true } }).catch(() => ({}));
        setStoryTheme(story.content, { resourceId: t.resourceId, version: (full as { updateCounter?: number }).updateCounter, packageId: (full as { packageId?: string }).packageId });
        const saved = await saveStory(story);
        return toolSuccess({ theme: t.name, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_format_widget",
    "Format a chart or KPI widget: title, subtitle, number scale (Thousand/Million/Billion/Auto-Formatted) and decimal places. Tables: scale and decimals for all their measures.",
    {
      storyId: z.string(),
      widget: z.string().describe("Outline name"),
      title: z.string().optional(),
      subtitle: z.string().optional(),
      scale: z.enum(["Default", "Unformatted", "Thousand", "Million", "Billion", "Auto-Formatted"]).optional(),
      decimals: z.number().int().min(0).max(7).optional(),
      minimal: z.boolean().optional().describe("Minimal look: hide subtitle (charts/KPIs) or the whole header (tables)"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, allowalteration, minimal, ...f }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("format widget");
        const story = await loadStory(storyId);
        if (Object.values(f).some((v) => v !== undefined)) formatViz(story.content, widget, f);
        if (minimal) applyMinimalStyle(story.content, widget);
        const saved = await saveStory(story);
        return toolSuccess({ widget, ...f, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_threshold",
    `Add a story-defined threshold (conditional formatting) on a measure: ranges with name, semantic (ok/warning/critical,
sets icon and color), inclusive 'low' and exclusive 'high' bounds (omit for open ends). Tables and charts showing the measure
pick it up. Example: ok ≥ 100000000, warning 50000000–100000000, critical < 50000000.`,
    {
      storyId: z.string(),
      measure: z.string(),
      ranges: z
        .array(
          z.object({
            name: z.string(),
            semantic: z.enum(["ok", "warning", "critical"]),
            low: z.number().optional(),
            high: z.number().optional(),
            color: z.string().optional().describe("Hex color, default by semantic"),
          }),
        )
        .min(1),
      title: z.string().optional(),
      applyTo: z.array(z.string()).optional().describe("Widgets (outline names: charts, KPIs, tables) that should show the threshold"),
      datasetId: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, measure, ranges, title, applyTo, datasetId, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add threshold");
        const story = await loadStory(storyId);
        const model = storyModel(story.content, datasetId);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const m = resolveMeasure(meta, measure);
        const ds = story.content.entities.find((e: { type?: string; id: string }) => e.type === "dataset" && (!datasetId || e.id === datasetId));
        const id = addThreshold(story.content, ds.id, m, ranges, title);
        for (const w of applyTo ?? []) attachThreshold(story.content, w, id);
        const saved = await saveStory(story);
        return toolSuccess({ thresholdId: id, measure: m, ranges, appliedTo: applyTo ?? [], updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_variance",
    "Add a variance to a bar/column chart comparing measure A (usually the plotted one) with measure B: variance = A − B (absolute).",
    {
      storyId: z.string(),
      widget: z.string().describe("Outline name of the chart"),
      compare: z.string().describe("Measure A"),
      to: z.string().describe("Measure B"),
      datasetId: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, compare, to, datasetId, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add variance");
        const story = await loadStory(storyId);
        const model = storyModel(story.content, datasetId);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const ds = story.content.entities.find((e: { type?: string; id: string }) => e.type === "dataset" && (!datasetId || e.id === datasetId));
        const ids = addMeasureVariance(
          story.content,
          widget,
          modelMeasure(ds.id, resolveMeasure(meta, compare)),
          modelMeasure(ds.id, resolveMeasure(meta, to)),
        );
        const saved = await saveStory(story);
        return toolSuccess({ widget, compare, to, ...ids, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_year_comparison",
    `Turn a bar/column chart into a year-over-year comparison: creates restricted measures "<label> <current>" and
"<label> <previous>" (measure filtered on a year-month dimension whose keys start with the year, e.g. 2025xx), plots both
instead of the original measure and adds the variance current − previous. Works for models without a SAC time dimension.`,
    {
      storyId: z.string(),
      widget: z.string().describe("Outline name of the chart"),
      measure: z.string(),
      dimension: z.string().optional().default("Calender_Year_Month").describe("Dimension whose member keys start with the year"),
      current: z.string().describe("e.g. 2025"),
      previous: z.string().describe("e.g. 2024"),
      label: z.string().optional().describe("Measure label prefix, default: the measure name"),
      datasetId: z.string().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, measure, dimension, current, previous, label, datasetId, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("year comparison");
        for (const y of [current, previous]) if (!/^\d{2,8}$/.test(y)) throw new Error(`'${y}' is not a year/period prefix`);
        const story = await loadStory(storyId);
        const model = storyModel(story.content, datasetId);
        const meta = await fetchModelMetadata(model.connection, model.space, model.model);
        const m = resolveMeasure(meta, measure);
        const dim = resolveDimension(meta, dimension);
        const ds = story.content.entities.find((e: { type?: string; id: string }) => e.type === "dataset" && (!datasetId || e.id === datasetId));
        const name = (y: string) => `${label ?? m}_${y}`.replace(/[^A-Za-z0-9_]/g, "_");
        const cur = addRestrictedMeasure(story.content, ds.id, { name: name(current), measure: m, dimension: dim.name, beginsWith: current, modelName: model.model });
        const prev = addRestrictedMeasure(story.content, ds.id, { name: name(previous), measure: m, dimension: dim.name, beginsWith: previous, modelName: model.model });
        addCalcToViz(story.content, widget, prev);
        addCalcToViz(story.content, widget, cur);
        removeMeasureFromViz(story.content, widget, ds.id, m);
        const v = addMeasureVariance(story.content, widget, calculation(cur, name(current)), calculation(prev, name(previous)));
        dropPreExecute(story.content, widget);
        const saved = await saveStory(story);
        return toolSuccess({ widget, measures: [name(previous), name(current)], variance: `${name(current)} − ${name(previous)}`, ...v, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_remove_widget",
    "Remove a widget from a story by outline name (containers are removed with their content).",
    { storyId: z.string(), widget: z.string(), allowalteration: z.boolean().optional() },
    async ({ storyId, widget, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("remove widget");
        const story = await loadStory(storyId);
        const removed = removeWidget(story.content, widget);
        const saved = await saveStory(story);
        return toolSuccess({ removed, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_set_text",
    `Change text widgets that already exist. Either one widget: text (keeps its formatting; \\n = new paragraph) or html
(replaces everything). Or many at once: replace [{from, to}] in all text widgets (optionally only in 'widgets') — for
renaming, wording fixes and translation. Text only, tags and styles stay.`,
    {
      storyId: z.string(),
      widget: z.string().optional().describe("Outline name of the text widget"),
      text: z.string().optional(),
      html: z.string().optional(),
      replace: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      widgets: z.array(z.string()).optional().describe("replace: limit to these text widgets"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, text, html, replace, widgets, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set text");
        if (!replace?.length && (!widget || (text === undefined && html === undefined))) throw new Error("Pass widget + text/html, or replace");
        const story = await loadStory(storyId);
        const changed = replace?.length ? replaceInTexts(story.content, replace, widgets) : [];
        if (widget && (text !== undefined || html !== undefined)) {
          setWidgetText(story.content, widget, { text, html });
          changed.push(widget);
        }
        if (!changed.length) return toolSuccess({ changed: [], note: "Nothing found – nothing saved." });
        const saved = await saveStory(story);
        return toolSuccess({ changed, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_chart_get",
    `Read a chart as a short description: type, measures, dimensions, colour/pattern dimension, other feeds, legend,
plus the dimensions and calculations it could use. Same shape as sac_story_chart accepts ("chart B like A, but line" =
get A, change, apply to B).`,
    { storyId: z.string(), chart: z.string().describe("Outline name, e.g. CH_LINE_TAG_001") },
    async ({ storyId, chart }) => {
      try {
        const story = await loadStory(storyId);
        return toolSuccess(readChart(story.content, chart));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_chart",
    `Change an existing chart declaratively; only the given parts change. type (${CHART_TYPES.join(", ")}; metric =
Numeric Point), measures (model measure ids or calculation names), dimensions (main dimension feed of the type:
categoryAxis / donut colour / treemap title), color and pattern (dimension, e.g. Version: Actual solid, Plan hatched;
[] removes), feeds {feed: [...]} for anything else, legend true/false, hierarchy {Dim: {id, level}}, filters (members, e.g. Version ["Actual"] —
restricted measures need exactly one version; or dynamic date: year/quarter/month/day with last/next). Keeps the chart query in line with the feeds
(axes, dimension list, measure filter), which a plain JSON patch does not.`,
    {
      storyId: z.string(),
      chart: z.string().describe("Outline name of the chart"),
      type: z.string().optional(),
      measures: z.array(z.string()).optional(),
      dimensions: z.array(z.string()).optional(),
      color: z.array(z.string()).optional(),
      pattern: z.array(z.string()).optional(),
      feeds: z.record(z.string(), z.array(z.string())).optional(),
      legend: z.boolean().optional(),
      hierarchy: z
        .record(z.string(), z.object({ id: z.string(), level: z.number().optional(), includeParents: z.boolean().optional() }))
        .optional()
        .describe('Hierarchy and drill level per dimension, e.g. {"Produkt": {"id": "H_KAT", "level": 1}}; level 0 = top nodes'),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            members: z.array(z.string()).optional().describe("[] removes the filter"),
            hierarchy: z.string().optional(),
            dynamic: z
              .object({ granularity: z.enum(["year", "quarter", "month", "day"]), last: z.number().optional(), next: z.number().optional() })
              .optional()
              .describe("Date range relative to today, e.g. {granularity: 'month', last: 2} = this month and the two before"),
          }),
        )
        .optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, chart, allowalteration, ...spec }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("change chart");
        const story = await loadStory(storyId);
        const changes = applyChart(story.content, chart, spec);
        if (!changes.length) return toolSuccess({ changes, note: "Nothing to change." });
        const saved = await saveStory(story);
        return toolSuccess({ changes, chart: readChart(story.content, chart), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_set_colors",
    `Story-wide series colours for all charts of a model: fixed colour per member (members {Dim: {ID: "#hex"}}, with
hierarchies {Dim: "H_KAT"} when the charts show a hierarchy — parents can get a colour too), colour/pattern per measure
or calculation (measures {name: {color, pattern}}) and per version (versions {Plan: {color, pattern: "hatching8"}} =
Actual solid, Plan hatched). Patterns: "" solid, hatching1…hatching8. Red/green series colours only after asking
(confirmSignalColors).`,
    {
      storyId: z.string(),
      members: z.record(z.string(), z.record(z.string(), z.string())).optional(),
      hierarchies: z.record(z.string(), z.string()).optional(),
      measures: z.record(z.string(), z.object({ color: z.string(), pattern: z.string().optional() })).optional(),
      versions: z.record(z.string(), z.object({ color: z.string(), pattern: z.string().optional() })).optional(),
      model: z.string().optional().describe("Only when the story uses several models: part of the dataset id"),
      confirmSignalColors: z.boolean().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, model, confirmSignalColors, allowalteration, ...colors }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      const hits = signalColorsIn(allColors(colors));
      if (hits.length && !confirmSignalColors)
        return toolSuccess({
          needsInput: true,
          note: "Colours were NOT set. Please clarify with the user.",
          signalColors: hits.map((h) => `${h.color} (${h.signal === "red" ? "red" : "green"})`),
          why: SIGNAL_COLOR_NOTE,
          options: ["Neutral colours (recommended)", "Keep them anyway (confirmSignalColors: true)"],
        });
      try {
        assertWritable("set series colours");
        const story = await loadStory(storyId);
        const changes = setSeriesColors(story.content, colors, model);
        const saved = await saveStory(story);
        return toolSuccess({ changes, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_calculation",
    `Create or replace a story calculation (Calculation Editor). Restricted measure: measure + restrictions
[{dimension, members, exclude?}] on any number of dimensions (Version: "Actual"), constantSelection [dims] = ignore
these dimensions of the chart/filter context (e.g. Version, so Actual and Target can sit in one chart). Calculated
measure: formula with [#Calculation name] and [ModelMeasureId], numbers, + - * / ( ), e.g.
"100 - [#Drinks actual] / [#Actual units] * 100". charts: add the result to these charts' measures.`,
    {
      storyId: z.string(),
      name: z.string(),
      measure: z.string().optional().describe("Restricted measure: model measure id"),
      restrictions: z.array(z.object({ dimension: z.string(), members: z.array(z.string()), exclude: z.boolean().optional() })).optional(),
      constantSelection: z.array(z.string()).optional(),
      formula: z.string().optional().describe("Calculated measure"),
      charts: z.array(z.string()).optional(),
      model: z.string().optional().describe("Only when the story uses several models: part of the dataset id"),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, name, measure, restrictions, constantSelection, formula, charts, model, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("story calculation");
        if (!!formula === !!measure) throw new Error("Pass either measure + restrictions (restricted measure) or formula (calculated measure)");
        const story = await loadStory(storyId);
        const dsIds = [...chartDatasets(story.content).keys()].filter((d) => !model || d.includes(model));
        if (dsIds.length !== 1) throw new Error(dsIds.length ? `Several models, pass 'model' (${dsIds.join(" | ")})` : "No chart with a model in the story");
        const id = formula
          ? upsertCalculatedMeasure(story.content, dsIds[0], { name, formula })
          : upsertRestrictedMeasure(story.content, dsIds[0], { name, measure: measure!, restrictions: restrictions ?? [], constantSelection });
        const added: string[] = [];
        for (const c of charts ?? []) {
          const cur = readChart(story.content, c).measures ?? [];
          if (!cur.includes(name)) applyChart(story.content, c, { measures: [...cur, name] });
          added.push(c);
        }
        const saved = await saveStory(story);
        return toolSuccess({ id, name, kind: formula ? "calculated" : "restricted", charts: added, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_duplicate",
    `Duplicate a widget or a whole card (panel with all children) with new ids and its own text entities (unlike the
editor's Duplicate, deleting one copy does not break the other). name = outline name of the copy; children get
renameFrom → renameTo (e.g. "EHR" → "DTZ") or "_2". Optional target container and position. Scripts are not copied.`,
    {
      storyId: z.string(),
      source: z.string(),
      name: z.string(),
      container: z.string().optional(),
      renameFrom: z.string().optional(),
      renameTo: z.string().optional(),
      position: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, source, allowalteration, ...opts }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("duplicate widget");
        const story = await loadStory(storyId);
        const r = duplicateWidget(story.content, source, opts);
        const saved = await saveStory(story);
        return toolSuccess({ ...r, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_add_kpi",
    `KPI tile as Numeric Point (rule: KPIs are Numeric Point charts bound to the model, not text fields
filled by script). Copies a chart of the same model (sourceChart, default: the first chart found), turns it into a
Numeric Point with one measure (model measure or calculation) and optional filters (Version, dynamic date …).
Name e.g. CH_KPI_SALES_001.`,
    {
      storyId: z.string(),
      name: z.string(),
      measure: z.string(),
      container: z.string().optional(),
      sourceChart: z.string().optional(),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            members: z.array(z.string()).optional(),
            hierarchy: z.string().optional(),
            dynamic: z.object({ granularity: z.enum(["year", "quarter", "month", "day"]), last: z.number().optional(), next: z.number().optional() }).optional(),
          }),
        )
        .optional(),
      position: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, name, measure, container, sourceChart, filters, position, allowalteration }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("add KPI");
        const story = await loadStory(storyId);
        const source =
          sourceChart ??
          [...outlineNames(story.content).values()].find((n) => {
            try {
              return !!readChart(story.content, n.name);
            } catch {
              return false;
            }
          })?.name;
        if (!source) throw new Error("No chart in the story to copy the model binding from; pass sourceChart");
        duplicateWidget(story.content, source, { name, container, position });
        const changes = applyChart(story.content, name, { type: "metric", measures: [measure], filters });
        const saved = await saveStory(story);
        return toolSuccess({ name, source, changes, chart: readChart(story.content, name), updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_set_layout",
    `Flow panel layout in one call: padding inside (number = all sides, or {top,right,bottom,left}), gap between
children (number or {horizontal, vertical}), order of the children (outline names; unlisted ones follow) and fixed
child sizes {NAME: {width, height}}. tiles: padding 4 / gap 8 instead of wrapper panels (CSS has no padding).`,
    {
      storyId: z.string(),
      container: z.string().describe("Outline name of the flow panel"),
      padding: z.union([z.number(), z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() })]).optional(),
      gap: z.union([z.number(), z.object({ horizontal: z.number().optional(), vertical: z.number().optional() })]).optional(),
      order: z.array(z.string()).optional(),
      sizes: z.record(z.string(), z.object({ width: z.number().optional(), height: z.number().optional() })).optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, container, allowalteration, ...opts }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("set layout");
        const story = await loadStory(storyId);
        const { children } = setFlowLayout(story.content, container, opts);
        const saved = await saveStory(story);
        return toolSuccess({ container, children, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "sac_story_set_position",
    `Position a widget in its container (canvas): pixel offsets left/top/right/bottom, or width/height. left+right
(top+bottom) stretch it. Typical: a table filling a card below its 48 px title → left 8, top 56, right 8, bottom 8.
container moves the widget into another container first (e.g. an input control into the filter bar flow panel).`,
    {
      storyId: z.string(),
      widget: z.string().describe("Outline name"),
      container: z.string().optional().describe("Outline name of the container to move the widget into"),
      left: z.number().optional(),
      top: z.number().optional(),
      right: z.number().optional(),
      bottom: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      allowalteration: z.boolean().optional(),
    },
    async ({ storyId, widget, container, allowalteration, ...pos }) => {
      if (!allowalteration) return toolError(ALTERATION_MSG);
      try {
        assertWritable("position widget");
        const story = await loadStory(storyId);
        if (container) moveWidget(story.content, widget, container);
        setWidgetPosition(story.content, widget, pos);
        const saved = await saveStory(story);
        return toolSuccess({ widget, ...pos, updateCounter: saved.updateCounter });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
