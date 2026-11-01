/**
 * outline naming convention:
 *   <TYPE>_<SUBTYPE?>_<CONTENT>_<NNN>[_P<nn>]
 * e.g. CH_KPI_SALES_001, CH_BAR_SALES_001, TA_SALES_001, TE_TITLE_001;
 * structural containers without number: PA_HEADER, FP_BODY.
 * Pages: PAGE_1, PAGE_2, …
 * Script objects: SO_<PURPOSE> (SO_KPI, SO_START, SO_CHANGEWIDGET); their functions camelCase by what they do
 * (getDimensionNames, setKPIValues, loadData).
 * Global variables: gv_<camelCase> (gv_CountryArray, gv_Page).
 */

export const PAGE_NAME = (n: number) => `PAGE_${n}`;
export const SCRIPT_OBJECT_NAME = /^SO_[A-Z0-9_]+$/;
export const FUNCTION_NAME = /^[a-z][A-Za-z0-9]*$/;
export const GLOBAL_VAR_NAME = /^gv_[A-Za-z][A-Za-z0-9]*$/;

export const TYPE_CODES: Record<string, { type: string; subtype?: string; structural?: boolean }> = {
  chart_bar: { type: "CH", subtype: "BAR" },
  kpi_numeric_point: { type: "CH", subtype: "KPI" },
  table: { type: "TA" },
  text: { type: "TE" },
  flow_panel: { type: "FP", structural: true },
  panel: { type: "PA", structural: true },
  panel_card: { type: "PA", structural: true },
  panel_flow_item: { type: "PA", structural: true },
  panel_group_header: { type: "PA", structural: true },
  flowpanel_inner: { type: "FP", structural: true },
  input_control: { type: "IC" },
  button: { type: "BT" },
  composite: { type: "CO" },
};

/** Uppercase, ASCII only, underscores — valid as SAC script name part. */
export function normalizeContent(content: string): string {
  return content
    .normalize("NFKD")
    .replace(/ä/gi, "AE")
    .replace(/ö/gi, "OE")
    .replace(/ü/gi, "UE")
    .replace(/ß/g, "SS")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

export function conventionName(fragment: string, content: string, existing: Iterable<string>, page?: number): string {
  const code = TYPE_CODES[fragment];
  if (!code) throw new Error(`No naming code for fragment '${fragment}' — pass an explicit name`);
  const base = [code.type, code.subtype, normalizeContent(content)].filter(Boolean).join("_");
  const suffix = page !== undefined ? `_P${String(page).padStart(2, "0")}` : "";
  const taken = new Set(existing);
  if (code.structural) {
    const name = base + suffix;
    if (!taken.has(name)) return name;
  }
  for (let n = 1; n < 1000; n++) {
    const name = `${base}_${String(n).padStart(3, "0")}${suffix}`;
    if (!taken.has(name)) return name;
  }
  throw new Error(`No free number for ${base}`);
}
