/**
 * Data actions (planning sequences), recorded from the Data Action designer: objectmgr createObjectOfType
 * PLANNINGSEQUENCE with advanced-formula steps (stepType SCRIPT, script text in scriptContent) and the target version
 * as prompt parameter. Validation: objectmgr callFunction [PLANNINGSEQUENCE, validate, …].
 *
 * Note: formulas must not name the version on the left side — the target version is chosen when running.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "../browser/session.js";
import { tenantPackage } from "./content.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "dataaction_create_recorded.json");

export async function objectmgr(body: Json): Promise<Json> {
  const res = await browser.request("POST", `/sap/fpa/services/rest/epm/objectmgr?tenant=${encodeURIComponent(browser.tenantId ?? "")}`, body);
  if (res.status >= 400) throw new Error(`objectmgr ${body.action} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 1500)}`);
  return res.body;
}

export interface DataActionSpec {
  name: string;
  description?: string;
  folderId: string;
  /** default model (SAC planning model id C…) */
  cubeId: string;
  steps: { name: string; script: string; description?: string }[];
}

function sequence(spec: DataActionSpec): Json {
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const seq = structuredClone(tpl.data.p2);
  const stepTpl = seq.planningSteps[0];
  seq.name = spec.name;
  seq.description = spec.description ?? "";
  seq.defaultCubeId = spec.cubeId;
  seq.planningSteps = spec.steps.map((s) => ({ ...structuredClone(stepTpl), id: randomUUID(), name: s.name, description: s.description ?? "", scriptContent: s.script }));
  seq.parameters = seq.parameters.map((p: Json) => ({ ...p, id: randomUUID() }));
  seq.debugData = { ...seq.debugData, dataActionName: spec.name, defaultCubeId: spec.cubeId };
  return seq;
}

/** Validate formulas; returns problems per step name (empty = fine). */
export async function validateDataAction(spec: DataActionSpec): Promise<{ ok: boolean; problems: Json[] }> {
  const seq = sequence(spec);
  const { debugData, ...meta } = seq;
  const res = await objectmgr({
    action: "callFunction",
    data: ["PLANNINGSEQUENCE", "validate", [{ scope: "DESIGNER", sequenceMetadata: meta, sequenceId: null, loadScriptContents: true, bDefaultCubeChanged: true }]],
  });
  const stepName = new Map<string, string>(seq.planningSteps.map((st: Json) => [st.id, st.name]));
  const problems: Json[] = [];
  for (const [stepId, groups] of Object.entries(res?.stepMessagesByStepId ?? {}))
    for (const msgs of Object.values(groups as Json))
      for (const m of msgs as Json[])
        problems.push({ step: stepName.get(stepId) ?? stepId, severity: m.severity, line: m.line, column: m.start, code: m.message?.code, text: m.message?.text });
  for (const m of Object.values(res?.sequenceMessages ?? {}).flat() as Json[]) problems.push({ step: "(data action)", severity: m.severity, code: m.message?.code });
  return { ok: !problems.some((p) => p.severity === "E"), problems };
}

export async function createDataAction(spec: DataActionSpec): Promise<{ dataActionId: string; validation: Json }> {
  const validation = await validateDataAction(spec);
  if (!validation.ok) throw new Error(`Formulas have errors, nothing created: ${JSON.stringify(validation.problems)}`);
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"));
  const body = structuredClone(tpl);
  body.data.p2 = sequence(spec);
  body.data.p3.resourceOptions.target = { name: spec.name, description: spec.description ?? "", parentResourceId: spec.folderId, copiedSourceObjectId: null };
  // a freshly created model is not usable right away; SAC then refuses to save with a "fatal" validation error
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await objectmgr(body);
      return { dataActionId: res?.id?.name, validation };
    } catch (e) {
      if (attempt >= 10 || !String(e).includes("FAILING_CREATE_DUE_TO_FATAL_ERROR")) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/**
 * Run a data action (what a Data Action Starter / DataAction.execute() sends). autoPublish writes the result into the
 * public target version; without it the change stays in the user's private edit of that version.
 */
export async function runDataAction(opts: {
  dataActionId: string;
  targetVersion: string;
  autoPublish?: boolean;
  context?: { type: string; resourceId: string; name: string };
}): Promise<Json> {
  const res = await objectmgr({
    action: "callFunction",
    data: {
      p1: `PLANNINGSEQUENCE:${tenantPackage()}:${opts.dataActionId}`,
      p2: "execute",
      p3: [
        {
          syncMode: true,
          localCurrency: false,
          autoPublish: { enabled: opts.autoPublish ?? false, filterOutReadOnlyFacts: false },
          planningArea: { type: "Default" },
          variables: {},
          requestId: randomUUID(),
          mdsVariables: {},
        },
        opts.context ?? { type: "PLANNINGSEQUENCE", resourceId: opts.dataActionId, name: opts.dataActionId },
        [{ id: { displayKey: "TargetVersion" }, value: { memberId: opts.targetVersion, hierarchyName: null }, source: "TRIGGER", inputType: "FIXED", useDesignerValue: false }],
        [],
      ],
    },
  });
  return res;
}
