/**
 * Story CSS (Edit CSS on story level): app.cssStyles[""].script. Theme CSS lives in the theme and is not touched here.
 *
 * SAC wraps every widget; style it through a class on the widget plus the widget's inner element, e.g.
 *   .my-class .sap-custom-panel-widget { … }      panels         .my-class .sap-custom-flow-panel-widget { … }
 *   .my-class .sap-custom-text-widget { … }       text           .my-class .sap-custom-default-* (charts/tables)
 * Classes written by this module are fenced with marker comments so they can be updated in place.
 */

import { appEntity } from "./content.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const WIDGET_SELECTORS: Record<string, string> = {
  panel: ".sap-custom-panel-widget",
  flowpanel: ".sap-custom-flow-panel-widget",
  text: ".sap-custom-text-widget",
  button: ".sap-custom-button",
  any: "",
};

export function getStoryCss(content: Json): string {
  return appEntity(content).app.cssStyles?.[""]?.script ?? "";
}

export function setStoryCss(content: Json, css: string) {
  const app = appEntity(content).app;
  (app.cssStyles ??= {})[""] = { script: css, invalid: false };
}

/** Insert or replace one class definition (fenced by marker comments). */
export function upsertCssClass(content: Json, className: string, widget: keyof typeof WIDGET_SELECTORS | string, declarations: string): string {
  if (!/^[A-Za-z_][\w-]*$/.test(className)) throw new Error(`Invalid CSS class name '${className}'`);
  const inner = WIDGET_SELECTORS[widget] ?? widget;
  const selector = inner ? `.${className} ${inner}` : `.${className}`;
  const body = declarations.trim().replace(/^\{|\}$/g, "").trim();
  const block = `/* mcp:${className} */\n${selector} {\n  ${body.split(/;\s*/).filter(Boolean).join(";\n  ")};\n}\n/* /mcp:${className} */`;
  const re = new RegExp(`/\\* mcp:${className} \\*/[\\s\\S]*?/\\* /mcp:${className} \\*/`);
  const css = getStoryCss(content);
  const next = re.test(css) ? css.replace(re, block) : `${css.trimEnd()}${css.trim() ? "\n\n" : ""}${block}\n`;
  setStoryCss(content, next);
  return block;
}
