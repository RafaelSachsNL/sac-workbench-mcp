/**
 * Models the user can build on. SAC lists every model (CUBE) the user can see — native SAC models and the embedded
 * references that stories create for live Datasphere models. A reference names its source (connection, space,
 * object), so it doubles as "Datasphere models used before". Browsing all Datasphere spaces needs the Datasphere
 * login of the model picker, which the MCP cannot do on its own.
 */

import { contentlib } from "./content.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface ModelOption {
  model: string;
  description: string;
  kind: "datasphere" | "sac" | "seamless";
  connection?: string;
  space?: string;
  resourceId?: string;
  lastUsed: string;
  /** the dashboard generator binds Datasphere models and SAC models (planning and analytic), responsive and canvas */
  supported: boolean;
  /** layouts the generator supports for this model */
  layouts?: ("responsive" | "canvas")[];
}

function source(cdata: unknown): { connectionName?: string; schemaName?: string; objectName?: string } | undefined {
  const text = typeof cdata === "string" ? cdata : JSON.stringify(cdata ?? "");
  const pick = (k: string) => text.match(new RegExp(`\\\\?"${k}\\\\?":\\s*\\\\?"([^"\\\\]+)`))?.[1];
  const objectName = pick("objectName");
  return objectName ? { connectionName: pick("connectionName"), schemaName: pick("schemaName"), objectName } : undefined;
}

export async function listModels(): Promise<ModelOption[]> {
  const res = await contentlib("getSearchList", { type: "CUBE", value: "*", recentlyAccessed: 500, bIncTemporary: false, spaceId: null });
  const cubes = (Array.isArray(res) ? res : []) as Json[];
  // newest first, one entry per model name
  cubes.sort((a, b) => String(b.modifiedTime ?? "").localeCompare(String(a.modifiedTime ?? "")));
  const byName = new Map<string, Json>();
  for (const c of cubes) if (c?.name && !byName.has(c.name)) byName.set(c.name, c);

  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const c of byName.values()) {
    const content = await contentlib("getContent", { resourceType: "CUBE", resourceId: c.resourceId, oOpt: {} }).catch(() => undefined);
    const src = source(content?.cdata);
    // SAC models built on Datasphere data also carry a source, but name an internal transient object
    if (src?.connectionName && !src.objectName!.includes("::")) {
      const key = `${src.connectionName}/${src.schemaName}/${src.objectName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        model: src.objectName!,
        description: c.description ?? "",
        kind: "datasphere",
        connection: src.connectionName,
        space: src.schemaName,
        lastUsed: String(c.modifiedTime ?? "").slice(0, 10),
        supported: true,
      });
    } else {
      const cd = typeof content?.cdata === "string" ? JSON.parse(content.cdata) : content?.cdata;
      // planning models carry their InA DataSource; analytic ones are addressed the same way (see planwrite sacModel)
      const planning = (cd?.type === "Planning" && Boolean(cd?.DataSource)) || content?.resourceSubtype === "ANALYTIC";
      out.push({
        model: c.name,
        description: c.description ?? "",
        kind: cd?.DataSource?.System ? "seamless" : "sac",
        resourceId: c.resourceId,
        lastUsed: String(c.modifiedTime ?? "").slice(0, 10),
        supported: planning,
        ...(planning ? { layouts: ["responsive" as const, "canvas" as const] } : {}),
      });
    }
  }
  return out;
}
