/**
 * Story calculations as the Calculation Editor stores them (recorded from the Calculation Editor):
 * - restricted measure: one selection per dimension (IN with member ids), the same filter as qmfSelections tree,
 *   Constant Selection = externalDimensionsToIgnore / selectedExternalDimensionsToIgnore as dimension objects
 *   (plain strings break the story);
 * - calculated measure: formula text ([#Name] for calculations), symbolic text with the ids, idMapping and the
 *   parsed formula (ast).
 */

import { randomUUID } from "node:crypto";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface RestrictionInput {
  dimension: string;
  /** member ids (Version: "Actual" or "public.Actual") */
  members: string[];
  exclude?: boolean;
}

const FORMAT = {
  options: { maximumFractionDigits: 2, minimumFractionDigits: 2 },
  scale: { multiplier: "1", prefix: "", suffix: "", symbolSuffix: "", symbolPrefix: "", toUse: "", spaceSeparated: false },
  unit: { symbol: "", prefix: "", suffix: "", toUse: "", symbolSuffix: "", symbolPrefix: "", spaceSeparated: false },
  plusSign: { symbol: "", isPrefix: true },
  minusSign: { symbol: "-", isPrefix: true },
  showSignAs: "Default",
};

function calcEntity(content: Json): Json {
  let e = content.entities.find((x: Json) => x.type === "calculation");
  if (!e) throw new Error("Story has no calculation entity");
  e.entities ??= [];
  return e;
}

function register(content: Json, id: string) {
  const story = content.entities.find((e: Json) => e.type === "story");
  const order = ((story.calculationsLoadOrder ??= { calculationsLoadOrder: [], uqmVersion: "1.0" }).calculationsLoadOrder ??= []);
  if (!order.includes(id)) order.push(id);
}

export function findCalc(content: Json, nameOrId: string): Json | undefined {
  return calcEntity(content).entities.find((c: Json) => !c.isDeleted && (c.name === nameOrId || c.id?.id === nameOrId));
}

function replaceExisting(content: Json, name: string): string {
  const old = findCalc(content, name);
  if (!old) return randomUUID();
  const list = calcEntity(content).entities;
  list.splice(list.indexOf(old), 1);
  return old.id.id;
}

/** Restricted measure on several dimensions, optionally ignoring dimensions of the context (Constant Selection). */
export function upsertRestrictedMeasure(
  content: Json,
  datasetId: string,
  opts: { name: string; measure: string; restrictions: RestrictionInput[]; constantSelection?: string[] },
): string {
  const id = replaceExisting(content, opts.name);
  const ds = { id: datasetId, type: "dataset" };
  const dsEntity = JSON.stringify([{ datasetId }]);
  const dim = (d: string) => ({ id: d, type: "dimension", parentKey: ds });
  const key = (d: string, m: string) => (d === "Version" && !m.includes(".") ? `public.${m}` : m);
  const measureKey = { id: opts.measure, type: "member", parentKey: { id: "CustomDimension1", type: "dimension", parentKey: ds } };
  const datasetAlias = content.entities.find((e: Json) => e.type === "datasetAlias" && e.datasetId === datasetId)?.alias;
  const now = Date.now();
  const ignore = opts.constantSelection?.length ? opts.constantSelection.map(dim) : null;
  calcEntity(content).entities.push({
    id: { id, type: "restrictedMeasure", parentKey: { type: "datasets", ids: [ds] } },
    dateCreated: now,
    dateModified: now,
    isDeleted: false,
    isHiddenCalculation: false,
    name: opts.name,
    description: null,
    format: FORMAT,
    version: "1.6",
    isDynamicDescription: false,
    shouldSuppressTranslation: false,
    measureId: measureKey,
    selections: opts.restrictions.map((r) => ({
      entityId: [dim(r.dimension)],
      exclude: !!r.exclude,
      answers: [{ function: "IN", arguments: [r.members.map((m) => key(r.dimension, m))], exclude: !!r.exclude }],
      bookedDataOnly: true,
      staleMemberInfo: {},
      targetAttribute: "ID+DESC",
      attributeId: [r.dimension],
      type: "Calculation_Selections",
      filterId: randomUUID(),
    })),
    ignoreChartContext: false,
    ignoreAllSelectionContext: false,
    externalDimensionsToIgnore: ignore,
    selectedExternalDimensionsToIgnore: ignore,
    _calculationVariableIdMap: {
      [JSON.stringify(measureKey)]: { keyName: opts.measure, caption: opts.measure, entityType: "member", datasetId, ...(datasetAlias ? { datasetAlias } : {}) },
    },
    isInheritFormat: false,
    uqmIsInheritUnit: true,
    qmfSelections: [
      {
        selectionSchema: "COMPLEX",
        datasetEntityId: dsEntity,
        complexFilterTree: {
          exclude: false,
          func: "AND",
          selectionSchema: "COMPLEX",
          filterNodeChildren: opts.restrictions.map((r) => ({
            memberKeys: r.members.map((m) => key(r.dimension, m)),
            operator: "EQUAL",
            setSign: r.exclude ? "EXCLUDING" : "INCLUDING",
            selectionSchema: "MEMBER",
            targetedEntity: { datasetEntityId: dsEntity, entityId: JSON.stringify([{ datasetId }, { dimensionId: r.dimension }]) },
          })),
        },
      },
    ],
    uqmVersion: "1.1",
    validationErrors: [],
  });
  register(content, id);
  return id;
}

/* ---------- calculated measure ---------- */

type Tok = { t: "num"; v: string } | { t: "op"; v: string } | { t: "ref"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === "[") {
      const j = src.indexOf("]", i);
      if (j < 0) throw new Error("Formula: missing ]");
      out.push({ t: "ref", v: src.slice(i + 1, j) });
      i = j + 1;
    } else if (/[0-9.]/.test(c)) {
      const m = src.slice(i).match(/^[0-9]*\.?[0-9]+/)!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if ("+-*/()".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else throw new Error(`Formula: unexpected '${c}' (allowed: numbers, + - * / ( ), [#Calculation], [Measure])`);
  }
  return out;
}

/** Formula → SAC formula tree; refs resolved by `ref` to {Name, id}. */
function parseFormula(src: string, ref: (name: string) => { Name: string; id: Json }): Json {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const fn = (Name: string, Parameters: Json[]) => ({ Function: { Name, Parameters } });
  const num = (v: string) => fn("decfloat", [{ Constant: { Value: v, ValueType: "String" } }]);
  const primary = (): Json => {
    const t = toks[p++];
    if (!t) throw new Error("Formula ends early");
    if (t.t === "num") return num(t.v);
    if (t.t === "ref") return { Member: ref(t.v) };
    if (t.v === "(") {
      const e = expr();
      if (toks[p++]?.v !== ")") throw new Error("Formula: missing )");
      return e;
    }
    if (t.v === "-") return fn("-", [num("0"), primary()]);
    throw new Error(`Formula: unexpected '${t.v}'`);
  };
  const term = (): Json => {
    let l = primary();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) l = fn(toks[p++].v, [l, primary()]);
    return l;
  };
  const expr = (): Json => {
    let l = term();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) l = fn(toks[p++].v, [l, term()]);
    return l;
  };
  const ast = expr();
  if (p < toks.length) throw new Error(`Formula: unexpected '${toks[p].v}'`);
  return ast;
}

/**
 * Calculated measure. Formula references: [#Name] = another calculation of the story, [Measure] = model measure id.
 */
export function upsertCalculatedMeasure(content: Json, datasetId: string, opts: { name: string; formula: string }): string {
  const ds = { id: datasetId, type: "dataset" };
  const idMapping: Record<string, Json> = {};
  const symbols: Record<string, string> = {};
  const resolve = (raw: string) => {
    if (raw.startsWith("#")) {
      const c = findCalc(content, raw.slice(1));
      if (!c) throw new Error(`Formula: no calculation '${raw.slice(1)}' in the story`);
      const id = { id: c.id.id, type: c.id.type, parentKey: c.id.parentKey };
      const k = JSON.stringify(id);
      idMapping[k] = { keyName: c.name, caption: c.name, entityType: "calculation" };
      symbols[`[${raw}]`] = k;
      return { Name: raw, id };
    }
    const id = { id: raw, type: "member", parentKey: { id: "CustomDimension1", type: "dimension", parentKey: ds } };
    const k = JSON.stringify(id);
    idMapping[k] = { keyName: raw, caption: raw, entityType: "member", datasetId };
    symbols[`[${raw}]`] = k;
    return { Name: `[${raw}]`, id };
  };
  const ast = parseFormula(opts.formula, resolve);
  const symbolic = opts.formula.replace(/\[[^\]]+\]/g, (m) => symbols[m] ?? m);
  const id = replaceExisting(content, opts.name);
  const now = Date.now();
  calcEntity(content).entities.push({
    id: { id, type: "calculation", parentKey: { type: "datasets", ids: [ds] } },
    dateCreated: now,
    dateModified: now,
    isDeleted: false,
    isHiddenCalculation: false,
    name: opts.name,
    description: null,
    format: FORMAT,
    version: "1.6",
    isDynamicDescription: false,
    shouldSuppressTranslation: false,
    formula: { text: { display: opts.formula, symbolic, idMapping }, ast },
    isInheritFormat: false,
    dimensionsValueTypeMap: {},
    uqmIsInheritUnit: true,
    uqmVersion: "1.1",
    validationErrors: [],
  });
  register(content, id);
  return id;
}
