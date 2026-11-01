/**
 * Story-wide series colours (apply to every chart of the model in the story), stored on the story entity:
 * - colorSync[ds][dim].explicitColorAssignments: fixed colour per member. Key = "[Dim].[Hier].&[ID]" for a hierarchy
 *   (+ preferredHierarchy), the plain member ID for a flat dimension (verified: other forms
 *   are ignored). The entry needs the palette fields (id, mappingPaletteId, colors), otherwise SAC falls back to grey.
 * - measureSync[]: colour/pattern per measure or calculation.
 * - patternSync[ds][Version].patterns: colour/pattern per version (e.g. Actual solid, Plan hatched).
 */

import { calcRef, measureRef } from "./calculations.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface Look {
  color: string;
  /** "" = solid, "hatching1" … "hatching8" */
  pattern?: string;
}

export interface SeriesColors {
  /** {dimension: {memberId: color}} */
  members?: Record<string, Record<string, string>>;
  /** hierarchy per dimension, e.g. {Produkt: "H_KAT"} */
  hierarchies?: Record<string, string>;
  /** {measure id or calculation name: {color, pattern}} */
  measures?: Record<string, Look>;
  /** {version, e.g. "Plan" or "public.Plan": {color, pattern}} */
  versions?: Record<string, Look>;
}

const storyData = (content: Json) => {
  const story = content.entities.find((e: Json) => e.type === "story");
  return story.data ?? story;
};

/** Datasets used by charts of the story, with a palette to start from. */
export function chartDatasets(content: Json): Map<string, Json> {
  const out = new Map<string, Json>();
  const walk = (o: Json): void => {
    if (!o || typeof o !== "object") return;
    if (o.vizDefinition?.datasetEntityId) {
      const ds = JSON.parse(o.vizDefinition.datasetEntityId)[0].datasetId;
      if (!out.has(ds)) out.set(ds, o.vizDefinition.colorScheme?.paletteDesc);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(content);
  return out;
}

export function allColors(c: SeriesColors): string[] {
  return [
    ...Object.values(c.members ?? {}).flatMap((m) => Object.values(m)),
    ...Object.values(c.measures ?? {}).map((l) => l.color),
    ...Object.values(c.versions ?? {}).map((l) => l.color),
  ];
}

export function setSeriesColors(content: Json, c: SeriesColors, model?: string): string[] {
  const datasets = chartDatasets(content);
  const dsIds = [...datasets.keys()].filter((d) => !model || d.includes(model));
  if (dsIds.length !== 1)
    throw new Error(dsIds.length ? `Several models in the story, pass 'model' (one of: ${dsIds.join(" | ")})` : "No chart with a model in the story");
  const ds = dsIds[0];
  const dsKey = JSON.stringify([{ datasetId: ds }]);
  const dimKey = (d: string) => JSON.stringify([{ datasetId: ds }, { dimensionId: d }]);
  const sd = storyData(content);
  const changes: string[] = [];

  for (const [dim, members] of Object.entries(c.members ?? {})) {
    const sync = ((sd.colorSync ??= { version: "1.0.0" })[dsKey] ??= {});
    const palette = datasets.get(ds) ?? {};
    const entry = (sync[dimKey(dim)] ??= {
      id: palette.id,
      mappingPaletteId: palette.mappingPaletteId,
      preferredMappingPaletteId: palette.mappingPaletteId,
      colors: palette.colors ?? [],
    });
    const hier = c.hierarchies?.[dim];
    if (hier) entry.preferredHierarchy = hier;
    const assign = (entry.explicitColorAssignments ??= {});
    for (const [id, color] of Object.entries(members)) assign[hier ? `[${dim}].[${hier}].&[${id}]` : id] = color;
    changes.push(`${dim}: ${Object.keys(members).length} member colours${hier ? ` (${hier})` : ""}`);
  }

  if (c.measures) {
    const calcs = (content.entities.find((e: Json) => e.type === "calculation")?.entities ?? []).filter((x: Json) => !x.isDeleted);
    const list: Json[] = (sd.measureSync ??= []);
    for (const [name, look] of Object.entries(c.measures)) {
      const calc = calcs.find((x: Json) => x.name === name || x.id?.id === name);
      const id = calc ? calcRef(calc.id.id) : measureRef(ds, name);
      let e = list.find((x) => x.id === id);
      if (!e) list.push((e = { id, isGlobalColorReset: false, swatchId: "" }));
      e.color = look.color;
      if (look.pattern !== undefined) {
        if (look.pattern) e.pattern = look.pattern;
        else delete e.pattern;
      }
      changes.push(`measure ${name}: ${look.color}${look.pattern ? ` ${look.pattern}` : ""}`);
    }
  }

  if (c.versions) {
    const patterns = ((((sd.patternSync ??= {})[dsKey] ??= {})[dimKey("Version")] ??= {}).patterns ??= {});
    for (const [v, look] of Object.entries(c.versions)) {
      const key = v.includes(".") ? v : `public.${v}`;
      const n = Object.keys(patterns).length;
      const e = (patterns[key] ??= { strokeWidth: 2, swatchId: "", order: n, zIndex: 0, unstackBars: false, position: "center" });
      Object.assign(e, { color: look.color, fillColor: look.color, stroke: look.color });
      if (look.pattern !== undefined) e.pattern = look.pattern;
      else e.pattern ??= "";
      changes.push(`version ${key}: ${look.color}${e.pattern ? ` ${e.pattern}` : ""}`);
    }
  }
  return changes;
}
