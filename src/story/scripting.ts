/**
 * Story scripting (optimized stories / former analytic applications), recorded from the Outline → Scripting panel.
 *
 *   global (script) variables  app.globalVars[name] = {name, type, isArray, defaultValue, description?}
 *   script objects             appEntity.scriptObjects[] = {instanceId: '[{"scriptObject":"<id>"}]', payload: {
 *                                functionSignatures: {fn: {returnType?, args: [{name, type, optional?, isArray?}]}},
 *                                functionImplementations: {fn: "<code>"}}}  — outline name in app.names
 *   event scripts              app.events[<outline key of the page/widget>] = {onInitialization: "<code>", …}
 *
 * Widget types in signatures are prefixed with "+" (e.g. "+Panel"); primitive types are plain (string, integer, …).
 */

import { randomUUID } from "node:crypto";
import { appEntity, outlineNames } from "./content.js";
import { FUNCTION_NAME, GLOBAL_VAR_NAME, SCRIPT_OBJECT_NAME } from "./naming.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const PRIMITIVES = new Set(["string", "boolean", "integer", "number", "void"]);

/** "Panel" → "+Panel" (widget/object types), primitives unchanged. */
function sigType(t: string): string {
  if (PRIMITIVES.has(t) || t.startsWith("+")) return t;
  return /^[A-Z]/.test(t) ? `+${t}` : t;
}

export interface GlobalVariable {
  name: string;
  type: string;
  isArray?: boolean;
  defaultValue?: string;
  description?: string;
}

export function setGlobalVariable(content: Json, v: GlobalVariable, opts: { enforceConvention?: boolean } = {}) {
  if (opts.enforceConvention !== false && !GLOBAL_VAR_NAME.test(v.name))
    throw new Error(`Global variable '${v.name}' does not follow the convention gv_camelCase (e.g. gv_CountryArray)`);
  const app = appEntity(content).app;
  (app.globalVars ??= {})[v.name] = {
    type: v.type,
    isArray: v.isArray ?? false,
    name: v.name,
    ...(v.defaultValue !== undefined ? { defaultValue: v.defaultValue } : {}),
    ...(v.description ? { description: v.description } : {}),
  };
}

export function removeGlobalVariable(content: Json, name: string) {
  delete appEntity(content).app.globalVars?.[name];
}

function scriptObjectByName(content: Json, name: string): Json | undefined {
  const app = appEntity(content);
  const key = Object.entries(app.app.names as Record<string, string>).find(([k, n]) => n === name && k.includes('"scriptObject"'))?.[0];
  return key ? (app.scriptObjects ?? []).find((s: Json) => s.instanceId === key) : undefined;
}

/** Create the script object if needed; returns it. */
export function ensureScriptObject(content: Json, name: string, opts: { enforceConvention?: boolean } = {}): Json {
  const existing = scriptObjectByName(content, name);
  if (existing) return existing;
  if (opts.enforceConvention !== false && !SCRIPT_OBJECT_NAME.test(name))
    throw new Error(`Script object '${name}' does not follow the convention SO_<PURPOSE> (e.g. SO_KPI)`);
  if ([...outlineNames(content).values()].some((n) => n.name === name)) throw new Error(`Name '${name}' is already used`);
  const app = appEntity(content);
  const instanceId = JSON.stringify([{ scriptObject: randomUUID() }]);
  const so = { instanceId, payload: { functionSignatures: {}, functionImplementations: {} } };
  (app.scriptObjects ??= []).push(so);
  app.app.names[instanceId] = name;
  return so;
}

export interface ScriptFunction {
  name: string;
  returnType?: string;
  args?: { name: string; type: string; optional?: boolean; isArray?: boolean }[];
  body: string;
}

export function setFunction(content: Json, scriptObject: string, fn: ScriptFunction, opts: { enforceConvention?: boolean } = {}) {
  if (opts.enforceConvention !== false && !FUNCTION_NAME.test(fn.name))
    throw new Error(`Function '${fn.name}' does not follow the convention camelCase by purpose (e.g. setKPIValues)`);
  const so = ensureScriptObject(content, scriptObject, opts);
  so.payload.functionSignatures[fn.name] = {
    ...(fn.returnType && fn.returnType !== "void" ? { returnType: sigType(fn.returnType) } : {}),
    args: (fn.args ?? []).map((a) => ({
      name: a.name,
      type: sigType(a.type),
      ...(a.optional ? { optional: true } : {}),
      ...(a.isArray ? { isArray: true } : {}),
    })),
  };
  so.payload.functionImplementations[fn.name] = fn.body;
}

export function removeFunction(content: Json, scriptObject: string, fnName: string) {
  const so = scriptObjectByName(content, scriptObject);
  if (!so) throw new Error(`No script object '${scriptObject}'`);
  delete so.payload.functionSignatures[fnName];
  delete so.payload.functionImplementations[fnName];
}

/** Event script of a page (outline name, e.g. PAGE_1) or widget (e.g. BT_EXPORT_001); empty body removes it. */
export function setEvent(content: Json, target: string, event: string, body: string) {
  const hit = [...outlineNames(content).values()].find((n) => n.name === target);
  if (!hit) throw new Error(`No page or widget named '${target}'`);
  const events = (appEntity(content).app.events ??= {});
  const scripts = (events[hit.key] ??= {});
  if (body.trim()) scripts[event] = body;
  else delete scripts[event];
  if (!Object.keys(scripts).length) delete events[hit.key];
}

/** Everything scripted in the story, keyed by outline names. */
export function listScripts(content: Json): Json {
  const app = appEntity(content);
  const names = app.app.names as Record<string, string>;
  return {
    globalVariables: Object.values(app.app.globalVars ?? {}),
    scriptObjects: (app.scriptObjects ?? []).map((s: Json) => ({
      name: names[s.instanceId] ?? s.instanceId,
      functions: Object.entries(s.payload?.functionSignatures ?? {}).map(([fn, sig]: [string, Json]) => ({
        name: fn,
        returnType: sig.returnType ?? "void",
        args: sig.args ?? [],
        body: s.payload?.functionImplementations?.[fn] ?? "",
      })),
    })),
    events: Object.entries(app.app.events ?? {})
      .map(([key, ev]: [string, Json]) => ({ target: names[key] ?? key, scripts: Object.fromEntries(Object.entries(ev).filter(([, b]) => b)) }))
      .filter((e) => Object.keys(e.scripts).length),
  };
}

/**
 * Data action as scripting object (Outline → Scripting → Data Actions), recorded: appEntity.planningSequenceGadgets.
 * Scripts then run it with <name>.execute(); the target version is fixed here (or set via setParameterValue).
 */
export function addDataActionObject(content: Json, opts: { name: string; dataActionId: string; tenantPackage: string; targetVersion: string; autoPublish?: boolean }) {
  if ([...outlineNames(content).values()].some((n) => n.name === opts.name)) throw new Error(`Name '${opts.name}' is already used`);
  const app = appEntity(content);
  const instanceId = JSON.stringify([{ planningSequenceGadget: randomUUID() }]);
  (app.planningSequenceGadgets ??= []).push({
    instanceId,
    payload: {
      parameters: {},
      trigger: {
        triggerName: "",
        triggerDescription: "",
        planningSequenceId: `PLANNINGSEQUENCE:${opts.tenantPackage}:${opts.dataActionId}`,
        autoRunInBackground: false,
        executionSettings: {
          currency: "defaultCurrency",
          autoPublish: { enabled: opts.autoPublish ?? false, filterOutReadOnlyFacts: false },
          planningArea: { type: "Default" },
          syncMode: false,
        },
        parameters: [{ id: { displayKey: "TargetVersion" }, value: { memberId: opts.targetVersion, hierarchyName: null }, inputType: "FIXED", useDesignerValue: false }],
      },
    },
  });
  app.app.names[instanceId] = opts.name;
}
