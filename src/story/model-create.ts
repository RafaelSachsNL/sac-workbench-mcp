/**
 * New SAC planning model (Modeler → Model → Start with an empty model → SAC storage), recorded from the modeler.
 *
 *   1. fpa/dimension createWithResource  per dimension (generic dimensions, Date = TimeHANA, Version = VersionDim)
 *   2. fpa/member update                 default members (# Unassigned, public.Actual / public.Plan)
 *   3. fpa/model createDesignTime        the cube: fact columns, dimension references, measures, planning settings
 *
 * Payload shapes come from templates/model_create_recorded.json; ids are generated, names/descriptions replaced.
 */

import { newCubeId } from "./binding.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "../browser/session.js";
import { tenantPackage } from "./content.js";
import { substitute } from "./fragments.js";
import { dirOf } from "../paths.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const TEMPLATE = resolve(dirOf(import.meta.url), "..", "..", "templates", "model_create_recorded.json");
const RECORDED_CUBE = "Cwun7lextsf8bfpswtjkitghmeo";
const RECORDED_FOLDER = "0123456789ABCDEF0123456789ABCDEF";

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,29}$/;

export interface PlanningModelSpec {
  name: string;
  description?: string;
  folderId: string;
  measures: { name: string; description?: string; decimals?: number }[];
  dimensions: { name: string; description?: string }[];
  /** add a Plan version next to Actual (default true) */
  planVersion?: boolean;
  /**
   * Seamless Planning: store the data in this Datasphere space (must be enabled for SAC planning). Recorded from
   * New Model → Data Storage Location "SAP Datasphere": only repositoryId {spaceId, type DWC} on the dimensions and
   * the cube differs (and the cube loses isRemote).
   */
  datasphereSpace?: string;
  /** time range of the Date dimension; default last year … two years ahead */
  fromYear?: number;
  toYear?: number;
}


async function fpa(service: "dimension" | "member" | "model", body: Json): Promise<Json> {
  const tenant = browser.tenantId;
  const res = await browser.request("POST", `/sap/fpa/services/rest/fpa/${service}?tenant=${encodeURIComponent(tenant ?? "")}`, body);
  if (res.status >= 400) throw new Error(`fpa/${service} ${body.action} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 1500)}`);
  return res.body;
}

/** Dimensions are created asynchronously (batch mode); retry while SAC reports them as not existing yet. */
async function whenExists<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      // right after creation SAC may also refuse with UNAUTHORIZED until the dimension's rights are in place
      if (attempt >= 15 || !/OBJECT_NOT_EXIST|UNAUTHORIZED/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function createPlanningModel(spec: PlanningModelSpec): Promise<{ cubeId: string; modelId: string }> {
  for (const n of [...spec.measures.map((m) => m.name), ...spec.dimensions.map((d) => d.name)])
    if (!NAME.test(n)) throw new Error(`'${n}' is not a valid technical name (letters, digits, _; max 30)`);
  const reserved = new Set(["Date", "Version", "Account", "Measures"]);
  for (const d of spec.dimensions) if (reserved.has(d.name)) throw new Error(`Dimension name '${d.name}' is reserved`);

  const cubeId = newCubeId();
  const pkg = `${tenantPackage()}.${cubeId}`;
  const modelId = `${pkg}:${cubeId}`;
  const raw = readFileSync(TEMPLATE, "utf8");
  const tpl = JSON.parse(substitute(raw, [[RECORDED_CUBE, cubeId], [RECORDED_FOLDER, spec.folderId]]));
  const dimId = (name: string) => `${pkg}:${name}`;
  const repo = spec.datasphereSpace ? { spaceId: spec.datasphereSpace.toUpperCase(), type: "DWC" } : undefined;
  const onDatasphere = (body: Json) => {
    if (repo) body.data.masterdataDimension.repositoryId = repo;
    return body;
  };

  // 1. dimensions
  for (const d of spec.dimensions) {
    const body = structuredClone(tpl["createWithResource:Region"]);
    const md = body.data.masterdataDimension;
    Object.assign(md, { dimensionId: d.name, id: dimId(d.name), name: d.name, description: d.description ?? d.name, resourceId: dimId(d.name) });
    body.data.resourceId = dimId(d.name);
    await fpa("dimension", onDatasphere(body));
  }
  const year = new Date().getFullYear();
  const dateBody = JSON.parse(
    JSON.stringify(tpl["createWithResource:Date"])
      .replace(/"fromYear":"\d{4}"/, `"fromYear":"${spec.fromYear ?? year - 1}"`)
      .replace(/"toYear":"\d{4}"/, `"toYear":"${spec.toYear ?? year + 2}"`),
  );
  await fpa("dimension", onDatasphere(dateBody));
  await fpa("dimension", onDatasphere(structuredClone(tpl["createWithResource:Version"])));

  // 2. default members of the generic dimensions
  for (const d of spec.dimensions) {
    const body = structuredClone(tpl["update:Region"]);
    body.data.dimensionId = dimId(d.name);
    await whenExists(() => fpa("member", body));
  }

  // 3. the model
  const body = structuredClone(tpl["createDesignTime:model"]);
  const cube = body.data.cube;
  const measureTpl = cube.measures[0];
  const dimTpl = cube.dimensions.find((x: Json) => x.name === "Region");
  const colTpl = cube.columns.find((x: Json) => x.name === "Region.ID");
  const measureCol = cube.columns.find((x: Json) => x.name === measureTpl.columnReference);
  Object.assign(cube, { name: spec.name, shortDescription: spec.description ?? spec.name, description: spec.description ?? "" });
  cube.measures = spec.measures.map((m) => ({ ...structuredClone(measureTpl), name: m.name, description: m.description ?? m.name, columnReference: m.name }));
  cube.dimensions = [
    ...cube.dimensions.filter((x: Json) => x.name === "Version" || x.name === "Date"),
    ...spec.dimensions.map((d) => {
      const x = structuredClone(dimTpl);
      x.name = d.name;
      x.description = d.description ?? d.name;
      x.properties[0].columnReference = `${d.name}.ID`;
      x.properties[0].masterDataReference.referenceId = dimId(d.name);
      return x;
    }),
  ];
  cube.columns = [
    ...cube.columns.filter((x: Json) => x.name === "Version.ID" || x.name === "Date.CALMONTH"),
    ...spec.measures.map((m) => ({ ...structuredClone(measureCol), name: m.name, scale: m.decimals ?? measureCol.scale })),
    ...spec.dimensions.map((d) => ({ ...structuredClone(colTpl), name: `${d.name}.ID` })),
  ];
  body.data.parentResId = spec.folderId;
  if (repo) {
    cube.repositoryId = repo;
    delete cube.isRemote;
  }
  await whenExists(() => fpa("model", body));

  // Version members (after the model, like the modeler)
  const versions = structuredClone(tpl["update:Version"]);
  if (spec.planVersion ?? true)
    versions.data.members.push({ ID: "public.Plan", _DESCRIPTION: "Plan", VERSION: "Plan", CATEGORY: "Planning", CURRENCY_CONVERSION_CATEGORY: "Planning", RATE_VERSION: "" });
  await whenExists(() => fpa("member", versions));
  return { cubeId, modelId };
}

/** Add or change members of a dimension of a model (ID + description). */
type MemberInput = { id: string; description?: string; [prop: string]: string | undefined };

/** Members of a dimension as the modeler grid loads them (recorded: fpa/member action query), all columns. */
export async function queryMembers(cubeId: string, dimensionId: string): Promise<Json[]> {
  const out: Json[] = [];
  for (let from = 0; ; from += 1000) {
    const res = await fpa("member", {
      action: "query",
      data: {
        dimensionId,
        filter: [],
        orderby: [{ attributeId: "ID", order: "asc" }],
        cubeId,
        paging: { fromIndex: from, pageSize: 1000 },
        action: "query",
        includeOverwrites: false,
        layout: "combined",
        needPrevId: true,
        modelingFrontendRequest: true,
      },
    });
    const page: Json[] = res?.Data?.members ?? [];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/**
 * The update writes whole member rows: a column that is not sent is emptied (e.g. the parent in a hierarchy column
 * like H_KAT when only the description changes). So existing members are read first and only the given columns change.
 */
async function mergedRows(cubeId: string, dimensionId: string, members: MemberInput[]): Promise<Json[]> {
  const existing = new Map((await queryMembers(cubeId, dimensionId)).map((m) => [String(m.ID), m]));
  return members.map(({ id, description, ...rest }) => {
    const { _PREV_ID, ...old } = existing.get(id) ?? {};
    void _PREV_ID;
    const row: Json = { ...old, ID: id, _DESCRIPTION: description ?? old._DESCRIPTION ?? id };
    for (const [k, v] of Object.entries(rest)) if (v !== undefined) row[k] = v;
    return row;
  });
}

export async function upsertMembers(cubeId: string, dimension: string, members: MemberInput[]) {
  const pkg = `${tenantPackage()}.${cubeId}`;
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"))["update:Region"];
  const body = structuredClone(tpl);
  body.data.cubeId = `${pkg}:${cubeId}`;
  body.data.dimensionId = `${pkg}:${dimension}`;
  body.data.members = await mergedRows(body.data.cubeId, body.data.dimensionId, members);
  return fpa("member", body);
}

/** Public (shared) dimension in a folder — recorded: Modeler → Public Dimension Tables → Dimension Table (Generic). */
export async function createPublicDimension(opts: {
  name: string;
  description?: string;
  folderId: string;
  members?: { id: string; description?: string }[];
}): Promise<{ resourceId: string; dimensionId: string }> {
  if (!NAME.test(opts.name)) throw new Error(`'${opts.name}' is not a valid technical name (letters, digits, _; max 30)`);
  const resourceId = "D" + newCubeId().slice(1);
  const dimensionId = `${tenantPackage()}:${opts.name}`;
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"))["createWithResource:Region"];
  const body = structuredClone(tpl);
  body.data = {
    ...body.data,
    resourceId,
    parentResId: opts.folderId,
    masterdataDimension: {
      ...body.data.masterdataDimension,
      dimensionId: opts.name,
      id: dimensionId,
      name: opts.name,
      description: opts.description ?? opts.name,
      isLocal: false,
      translation: { enabled: false, originalLanguage: "en" },
      parentResId: opts.folderId,
      resourceId,
    },
  };
  await fpa("dimension", body);
  const members = [{ id: "#", description: "Unassigned" }, ...(opts.members ?? [])];
  await whenExists(() => upsertPublicMembers(resourceId, members));
  return { resourceId, dimensionId };
}

/** Add or change members of a public dimension. */
export async function upsertPublicMembers(resourceId: string, members: MemberInput[]) {
  const tpl = JSON.parse(readFileSync(TEMPLATE, "utf8"))["update:Region"];
  const body = structuredClone(tpl);
  const id = `${tenantPackage()}:${resourceId}`;
  body.data.cubeId = id;
  body.data.dimensionId = id;
  body.data.members = await mergedRows(id, id, members);
  return fpa("member", body);
}

/** Current model definition as the modeler loads it (recorded: fpa/model getDesignTime). */
export async function getDesignTime(cubeId: string): Promise<{ cube: Json; parentResId: string; version: number }> {
  const res = await fpa("model", { action: "getDesignTime", data: { resourceId: cubeId, metadata: { contentLibOptions: { name: true, ancestorPath: { name: true }, updateCounter: true, packageId: true } } } });
  const cube = res?.modelingData?.cube;
  if (!cube) throw new Error(`Model ${cubeId} not found`);
  const ancestors = res.contentLibData?.ancestorPath ?? [];
  // the optimistic-lock version is contentLibData.metadata.version, not the updateCounter ("INCONSISTENT_VERSION")
  return { cube, parentResId: ancestors[0]?.resourceId ?? ancestors[0]?.name, version: res.contentLibData?.metadata?.version ?? 1 };
}

/**
 * Add a generic dimension (private dimension table) to an existing model — recorded from the modeler
 * (2026-10-30): fpa/dimension createWithResource, fpa/member update "#", fpa/model updateDesignTime with the whole
 * cube plus the new fact column (isNew, initialFactColumnValue) and dimension reference. Existing fact rows get the
 * default member ("#" unless another member is given — it has to exist, so other members are created first).
 */
export async function addModelDimension(
  cubeId: string,
  d: { name: string; description?: string; defaultMember?: string; members?: { id: string; description?: string }[] },
): Promise<{ dimensionId: string }> {
  if (!NAME.test(d.name)) throw new Error(`'${d.name}' is not a valid technical name (letters, digits, _; max 30)`);
  const { cube, parentResId, version } = await getDesignTime(cubeId);
  if (cube.dimensions.some((x: Json) => x.name.toLowerCase() === d.name.toLowerCase())) throw new Error(`Model already has a dimension '${d.name}'`);
  const pkg = cube.packageName as string;
  const dimId = `${pkg}:${d.name}`;
  const tpl = JSON.parse(substitute(readFileSync(TEMPLATE, "utf8"), [[RECORDED_CUBE, cubeId]]));

  const dimBody = structuredClone(tpl["createWithResource:Region"]);
  Object.assign(dimBody.data.masterdataDimension, { dimensionId: d.name, id: dimId, name: d.name, description: d.description ?? d.name, resourceId: dimId });
  dimBody.data.resourceId = dimId;
  // Seamless models keep their dimension tables in the Datasphere space too
  if (cube.repositoryId) dimBody.data.masterdataDimension.repositoryId = cube.repositoryId;
  await fpa("dimension", dimBody);
  const members = structuredClone(tpl["update:Region"]);
  members.data.dimensionId = dimId;
  // "#" plus the given members — a default member other than "#" must exist before the model update
  members.data.members.push(...(d.members ?? []).filter((m) => m.id !== "#").map((m) => ({ ID: m.id, _DESCRIPTION: m.description ?? m.id })));
  await whenExists(() => fpa("member", members));

  normalizeForUpdate(cube);
  // existing fact rows get this member ("Select Default Members" in the modeler); without it they stay null and no
  // filter or planning reaches them
  cube.columns.push({ name: `${d.name}.ID`, dataTypeName: "NVARCHAR", initialFactColumnValue: d.defaultMember ?? "#", length: 256, isNew: true, excludeNullValues: false });
  cube.dimensions.push({
    name: d.name,
    description: d.description ?? d.name,
    hierarchies: [],
    properties: [{ name: "ID", description: "Member ID", propertyType: "ID", descriptionProperty: null, columnReference: `${d.name}.ID`, masterDataReference: { referenceId: dimId } }],
  });
  Object.assign(cube, { isSample: false, isTemporary: false });
  // batchMode false: SAC answers synchronously; with batchMode a failed job only shows up as a notification id
  const body = { action: "updateDesignTime", data: { resourceId: cubeId, parentResId, options: { batchMode: false }, cube, metadata: tpl["createDesignTime:model"].data.metadata, version } };
  await whenExists(() => fpa("model", body));
  return { dimensionId: dimId };
}

/** The loaded cube in the shape the modeler sends it back (recorded updateDesignTime, 2026-10-30). */
function normalizeForUpdate(cube: Json) {
  for (const k of ["cubePrivileges", "descriptions"]) delete cube[k];
  for (const k of ["currencyDimension", "defaultCurrency", "rateSourceType", "repositoryId"]) if (cube[k] == null || cube[k] === "") delete cube[k];
  if (cube.isRemote === false) delete cube.isRemote;
  cube.sources = (cube.sources ?? []).map((src: Json) => ({ origin: src.origin, reference: src.reference }));
  cube.capability = { ...(cube.capability ?? {}), queryBasedCurrencyConversion: cube.capability?.queryBasedCurrencyConversion ?? true };
  for (const c of cube.columns) {
    c.isNew = false;
    if (c.defaultValue == null) delete c.defaultValue;
  }
  for (const d of cube.dimensions) {
    d.hierarchies ??= [];
    for (const p of d.properties ?? []) {
      if (p.semanticType == null) delete p.semanticType;
      delete p.masterDataReference?.publishMismatchedFacts;
    }
  }
  for (const m of cube.measures) {
    for (const k of ["currencyTranslation", "unitTranslation"]) if (m[k] == null) delete m[k];
    if (m.jsonFormula === "") delete m.jsonFormula;
    m.rateType ??= "";
  }
  if (cube.translation) {
    if (Array.isArray(cube.translation.languages) && !cube.translation.languages.length) delete cube.translation.languages;
    delete cube.translation.status;
  }
  if (cube.planning?.checks && !("maxInitialPrivateVersionSize" in cube.planning.checks)) cube.planning.checks.maxInitialPrivateVersionSize = null;
}

export interface HierarchyNode {
  id: string;
  description?: string;
  /** parent member id; omit or "" for a top node */
  parent?: string;
}

/**
 * Parent-child hierarchy on a dimension of an SAC model (recorded from the modeler, 2026-10-30):
 * 1. new hierarchy → fpa/dimension updateWithResource with the dimension (from getDesignTime's dependentObjects) plus
 *    {hierarchy, description, isNewHierarchy: true}; 2. fpa/member update with column <H> = parent ("" = top node)
 *    and <H>_PREVID = previous sibling (order). Nodes not yet in the dimension are created; other columns are kept.
 */
export async function setHierarchy(
  cubeId: string,
  dimension: string,
  hierarchy: { id: string; description?: string; nodes: HierarchyNode[]; makeDefault?: boolean },
): Promise<{ created: boolean; nodes: number }> {
  if (!NAME.test(hierarchy.id)) throw new Error(`'${hierarchy.id}' is not a valid hierarchy id`);
  const res = await fpa("model", { action: "getDesignTime", data: { resourceId: cubeId, metadata: { contentLibOptions: { updateCounter: true } } } });
  const dep = (res?.modelingData?.dependentObjects?.DIMENSION ?? []).find((e: Json) => e.metadata?.id?.name === dimension);
  if (!dep) throw new Error(`Model ${cubeId} has no own dimension '${dimension}' (public dimensions: edit them directly)`);
  const dim = dep.data;
  const exists = (dim.hierarchies ?? []).some((h: Json) => h.hierarchy === hierarchy.id);
  if (!exists) {
    const tpl = JSON.parse(substitute(readFileSync(TEMPLATE, "utf8"), [[RECORDED_CUBE, cubeId]]))["createWithResource:Region"];
    const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
    const md = {
      isEmbedded: false,
      dimensionId: dim.dimensionId ?? dimension,
      id: dim.id,
      name: dim.name ?? dimension,
      type: dim.type,
      description: dim.description,
      isLocal: dim.isLocal,
      capability: pick(dim.capability ?? {}, ["simpleColumnNames", "replicatedMemberPropertiesReadOnly", "addNonReplicatedMembers", "dacHideParents", "multiLangBackendEnabled", "multiLangEnabled"]),
      dacEnabled: !!dim.dacEnabled,
      properties: (dim.properties ?? []).map((p: Json) => pick(p, ["property", "propertyType", "description", "dataTypeName", "length", "scale", "semanticType", "isMandatory", "isUnique"])),
      hierarchies: [
        ...(dim.hierarchies ?? []).map((h: Json) => ({ hierarchy: h.hierarchy, description: h.description, isMandatory: !!h.isMandatory })),
        { hierarchy: hierarchy.id, description: hierarchy.description ?? hierarchy.id, isNewHierarchy: true, isMandatory: false },
      ],
      version: dep.metadata.version,
      defaultHierarchy: hierarchy.makeDefault || !dim.defaultHierarchy ? hierarchy.id : dim.defaultHierarchy,
      isSingleColumnDim: false,
      parentResId: cubeId,
      resourceId: dim.resourceId ?? dim.id,
      skipMandatoryPropertyValidation: true,
      isTemporary: false,
      restNode: dim.restNode ?? "",
      ...(dim.repositoryId ? { repositoryId: dim.repositoryId } : {}),
    };
    await fpa("dimension", { action: "updateWithResource", data: { resourceId: md.resourceId, parentResId: cubeId, options: { batchMode: false }, metadata: tpl.data.metadata, masterdataDimension: md, version: dep.metadata.version } });
  }
  // order among siblings = order in the list
  const lastChild = new Map<string, string>();
  const rows = hierarchy.nodes.map((n) => {
    const parent = n.parent && n.parent !== "<root>" ? n.parent : "";
    const prev = lastChild.get(parent) ?? "";
    lastChild.set(parent, n.id);
    return { id: n.id, description: n.description, [hierarchy.id]: parent, [`${hierarchy.id}_PREVID`]: prev } as MemberInput;
  });
  const known = new Set([...hierarchy.nodes.map((n) => n.id), ...(await queryMembers(`${dim.packageName}:${cubeId}`, dim.id)).map((m: Json) => String(m.ID))]);
  const missing = hierarchy.nodes.map((n) => n.parent).filter((p): p is string => !!p && p !== "<root>" && !known.has(p));
  if (missing.length) throw new Error(`Unknown parents: ${[...new Set(missing)].join(", ")} — add them as nodes (with description)`);
  await whenExists(() => upsertMembers(cubeId, dimension, rows));
  return { created: !exists, nodes: rows.length };
}
