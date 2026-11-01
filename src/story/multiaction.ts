/**
 * Multi actions, recorded from the Multi Action designer: objectmgr createObjectOfType MULTIACTIONS with
 * multiActionTasks chained via taskDependency (first step depends on $$STARTING_TASK$$). Validation before saving:
 * callFunction [MULTIACTIONS, validateTasks, …] → taskMessages per step.
 *
 * Supported steps: data actions with a fixed target version (cube taken from the data action's parameters).
 * Running: the official API (sac_multi_action_execute) with the returned executeId (package:id).
 */

import { randomUUID } from "node:crypto";
import { browser } from "../browser/session.js";
import { tenantPackage } from "./content.js";
import { objectmgr } from "./dataaction.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface MultiActionStep {
  /** step label shown in the designer */
  name: string;
  /** data action resource id (32 hex chars) */
  dataActionId: string;
  /** target version member, e.g. public.Plan */
  targetVersion: string;
  autoPublish?: boolean;
}

async function dataActionMeta(id: string): Promise<Json> {
  const res = await browser.request("GET", `/sap/fpa/services/rest/v5/internal/dataActions/${tenantPackage()}:${id}?tenant=${encodeURIComponent(browser.tenantId ?? "")}`);
  if (res.status >= 400) throw new Error(`Data action ${id} not found (${res.status})`);
  return (res.body as Json).dataAction;
}

async function tasks(steps: MultiActionStep[]): Promise<Json[]> {
  const out: Json[] = [];
  for (const s of steps) {
    const meta = await dataActionMeta(s.dataActionId);
    const target = meta.parameters?.find((p: Json) => p.isTargetVersionParameter);
    if (!target) throw new Error(`Data action ${meta.name} has no target version parameter`);
    out.push({
      id: randomUUID(),
      name: s.name,
      taskType: "DATA_ACTION",
      taskMetadata: [
        { name: "dataActionId", value: `${tenantPackage()}:${s.dataActionId}` },
        { name: "autoPublish", value: { enabled: s.autoPublish ?? false, filterOutReadOnlyFacts: false } },
        { name: "applyPlanningArea", value: "Default" },
      ],
      taskFields: [
        { fieldName: target.name, type: "MEMBER", cubeId: target.modelId, dimensionId: target.dimensionId, value: { memberIds: [s.targetVersion], hierarchyName: null } },
      ],
    });
  }
  return out;
}

export async function validateMultiAction(steps: MultiActionStep[]): Promise<{ ok: boolean; problems: Json[] }> {
  const multiActionTasks = await tasks(steps);
  const res = await objectmgr({
    action: "callFunction",
    data: { p1: "MULTIACTIONS", p2: "validateTasks", p3: [{ validateSavedDefinition: false, needValidateRelatedParameterDefinitions: false, multiActionTasks, parameters: [] }] },
  });
  const byId = new Map(multiActionTasks.map((t) => [t.id, t.name]));
  const problems = (res?.taskMessages ?? []).flatMap((m: Json) => (m.messages ?? []).map((x: Json) => ({ step: byId.get(m.taskId), ...x })));
  return { ok: !problems.some((p: Json) => String(p.severity ?? p.type ?? "error").toLowerCase().includes("error")), problems };
}

export async function createMultiAction(opts: {
  name: string;
  description?: string;
  folderId: string;
  steps: MultiActionStep[];
  /** callable via the public API (default true) */
  publicApi?: boolean;
}): Promise<{ multiActionId: string; executeId: string; validation: Json }> {
  if (!opts.steps.length) throw new Error("A multi action needs at least one step");
  const validation = await validateMultiAction(opts.steps);
  if (!validation.ok) throw new Error(`Multi action is invalid: ${JSON.stringify(validation.problems).slice(0, 1500)}`);
  const multiActionTasks = await tasks(opts.steps);
  multiActionTasks.forEach((t, i) => (t.taskDependency = { dependentTaskId: i ? multiActionTasks[i - 1].id : "$$STARTING_TASK$$" }));
  const res = await objectmgr({
    action: "createObjectOfType",
    data: {
      p1: "MULTIACTIONS",
      p2: { name: "", description: "", publicAPIAccess: opts.publicApi ?? true, multiActionTasks, parameters: [], bUseTempService: true },
      p3: {
        resourceOptions: {
          metadata: { name: true, description: true, parentResId: true },
          target: { parentResourceId: opts.folderId, name: opts.name, description: opts.description ?? "" },
        },
      },
    },
  });
  return { multiActionId: res.id.name, executeId: `${res.id.package}:${res.id.name}`, validation };
}
