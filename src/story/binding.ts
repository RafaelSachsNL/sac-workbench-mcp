/**
 * Bind a Datasphere model to a story that has none yet (e.g. one created from a template), the way the table story
 * flow does it: an embedded model reference (CUBE) below the story plus the story's dataset and dataset alias entities.
 * The entity shapes come from the recorded table story (templates/story_table.json).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contentlib, storyEntity } from "./content.js";
import { substitute, type ModelRef } from "./fragments.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TABLE_TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "story_table.json");

export function newCubeId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return "C" + Array.from(randomBytes(26), (b) => alphabet[b % alphabet.length]).join("");
}

export interface ModelSource {
  connection: string;
  space: string;
  model: string;
}

/** Creates the model reference below `storyId` and adds the dataset entities to `content`. */
export async function bindModel(content: Json, storyId: string, user: string, src: ModelSource): Promise<ModelRef> {
  const tpl = JSON.parse(readFileSync(TABLE_TEMPLATE, "utf8"));
  const ph = tpl.placeholders as Record<string, string>;
  const cubeId = newCubeId();
  const pairs: [string, string][] = [
    [ph.storyId, storyId],
    [ph.cubeId, cubeId],
    [ph.user, user],
    [ph.model, src.model],
    [ph.space, src.space],
    [ph.connection, src.connection],
  ];
  const cube = JSON.parse(substitute(JSON.stringify(tpl.createContent), pairs));
  await contentlib(cube.action, cube.data);

  const recorded = tpl.updateContentAndMoveResource.data.cdata.content.entities as Json[];
  const parts = recorded.filter((e) => e.type === "dataset" || e.type === "datasetAlias");
  const entities = JSON.parse(substitute(JSON.stringify(parts), pairs)) as Json[];
  const datasetId = entities.find((e) => e.type === "dataset").id as string;
  content.entities = content.entities.filter((e: Json) => !(e.type === "dataset" && e.id === datasetId));
  for (const e of entities) if (e.type === "datasetAlias") e.id = randomUUID();
  content.entities.push(...entities);

  const story = storyEntity(content).data;
  story.lastDataSource = datasetId;
  story.uqmRemoteSystemNames = [...new Set([...(story.uqmRemoteSystemNames ?? []), src.connection])];
  return { cubeId, ...src };
}
