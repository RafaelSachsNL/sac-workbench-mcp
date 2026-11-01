/**
 * SAC CSS rules as the CSS editor's linter enforces them (verified against the SAC CSS editor): a selector
 * starts with one user-defined class, followed by at most two predefined sap-custom-* classes (the second only as a
 * listed descendant of the first), descendant combinator only, pseudos only where the class allows them; properties
 * per class; no !important, var(), gradients, @-rules. A single invalid rule makes SAC drop the whole theme CSS, so
 * check before saving. Class list: templates/css_classes.txt (scraped from the SAC CSS editor).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dirOf } from "../paths.js";

interface ClassSpec {
  properties: Set<string>;
  pseudos: string[];
  descendants: Set<string>;
}

/** Properties a user-defined class may set on its own (container look). */
const USER_CLASS_PROPS = new Set(["background-color", "border", "border-top", "border-right", "border-bottom", "border-left", "opacity", "box-shadow", "border-radius"]);

let specs: Map<string, ClassSpec> | undefined;
function classSpecs(): Map<string, ClassSpec> {
  if (specs) return specs;
  specs = new Map();
  const file = resolve(dirOf(import.meta.url), "..", "..", "templates", "css_classes.txt");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.startsWith(".")) continue;
    const [cls, , props, pseudos, desc] = line.split("|").map((s) => s.trim());
    const list = (s: string) => (s && s !== "-" ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
    specs.set(cls.slice(1), { properties: new Set(list(props)), pseudos: list(pseudos), descendants: new Set(list(desc).map((d) => d.replace(/^\./, ""))) });
  }
  return specs;
}

export interface CssRule {
  selector: string;
  body: string;
  /** span of the whole rule in the original text */
  start: number;
  end: number;
}

/** Top-level rules "selector { body }" with their position in the text; comments are skipped but kept in the text. */
export function parseCss(css: string): CssRule[] {
  // same length as css, comments blanked out — indices stay valid for the original
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (c) => " ".repeat(c.length));
  const rules: CssRule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth; j++) depth += text[j] === "{" ? 1 : text[j] === "}" ? -1 : 0;
    const raw = text.slice(i, open);
    const selector = raw.trim();
    if (selector) rules.push({ selector, body: text.slice(open + 1, j - 1).trim(), start: i + raw.indexOf(selector), end: j });
    i = j;
  }
  return rules;
}

const normSelector = (s: string) => s.split(",").map((x) => x.trim().replace(/\s+/g, " ")).join(", ");

const formatRule = (r: { selector: string; body: string }) =>
  `${r.selector} {\n  ${r.body.split(";").map((d) => d.trim()).filter(Boolean).join(";\n  ")};\n}`;

/**
 * Theme CSS goes through the theme compiler, not the story CSS editor, and accepts more (tested with a dark
 * theme): SAC-internal classes (.sapLumira…, .sapFpa…, .saptheme), element selectors,
 * '>', adjoining classes, any property (overflow, outline, gradients), box-shadow on .sap-custom-button:hover.
 * Still fatal there: a pseudo the class does not support (e.g. :hover on a panel drops the whole theme CSS).
 */
function validateThemeRule(sel: string, body: string, err: (m: string) => void) {
  const cs = classSpecs();
  for (const compound of sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean)) {
    const pseudos = compound.match(/:[a-z-]+/g) ?? [];
    if (!pseudos.length) continue;
    const classes = [...compound.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
    const known = classes.map((c) => cs.get(c)).filter((x): x is ClassSpec => !!x);
    if (known.length) {
      for (const p of pseudos) if (!known.some((k) => k.pseudos.some((a) => a.startsWith(p)))) err(`${p} is not supported on ${compound} (SAC drops the whole theme CSS)`);
    } else if (!classes.some((c) => /^sap[A-Z]/.test(c) || c === "saptheme")) {
      err(`${pseudos.join("")} on ${compound}: pseudos only on predefined classes that support them (SAC drops the whole theme CSS)`);
    }
  }
  for (const decl of body.split(";").map((d) => d.trim()).filter(Boolean)) {
    const name = decl.split(":")[0].trim().toLowerCase();
    if (/!important/i.test(decl)) err(`${name}: no !important (SAC adds it)`);
    if (/var\(/i.test(decl)) err(`${name}: CSS variables are not supported`);
  }
}

/**
 * Validation errors as "<selector>: <problem>"; empty = SAC accepts it. mode "story" = rules of the story CSS editor,
 * "theme" = the more permissive theme compiler.
 */
export function validateCss(css: string, mode: "story" | "theme" = "story"): string[] {
  const errors: string[] = [];
  const cs = classSpecs();
  for (const rule of parseCss(css)) {
    if (rule.selector.startsWith("@")) {
      errors.push(`${rule.selector}: @-rules are not allowed`);
      continue;
    }
    if (mode === "theme") {
      for (const sel of rule.selector.split(",").map((s) => s.trim())) validateThemeRule(sel, rule.body, (m) => errors.push(`${sel}: ${m}`));
      continue;
    }
    for (const sel of rule.selector.split(",").map((s) => s.trim())) {
      const err = (m: string) => errors.push(`${sel}: ${m}`);
      if (/[>+~]/.test(sel)) err("only the descendant combinator (space) is allowed");
      const parts = sel.split(/\s+/).filter((x) => x && !/^[>+~]$/.test(x));
      // properties allowed on the last part decide the declarations
      let allowed: Set<string> | undefined;
      parts.forEach((part, idx) => {
        const m = part.match(/^\.([A-Za-z0-9_-]+)((?::[a-z-]+(?:\([^)]*\))?)*)$/);
        if (!m) {
          if (part === "*") allowed = undefined;
          else err(`'${part}': only class selectors (no elements, ids, adjoining classes)`);
          return;
        }
        const [, cls, pseudo] = m;
        const pseudos = pseudo.match(/:[a-z-]+/g) ?? [];
        if (idx === 0) {
          if (cls.startsWith("sap-custom-")) return err("must start with a user-defined class (e.g. .nl-card), not a predefined one");
          if (pseudos.length) err(`${pseudos.join("")} is not supported on the user-defined class .${cls}`);
          allowed = USER_CLASS_PROPS;
          return;
        }
        const spec = cs.get(cls);
        if (!spec) return err(`'.${cls}' is not a predefined SAC class here (only one user-defined class, at the start)`);
        if (idx === 2 && !cs.get(parts[1].replace(/^\.|:.*$/g, ""))?.descendants.has(cls)) err(`.${cls} is not a listed descendant of ${parts[1]}`);
        if (idx > 2) err("too deep (user class + at most two predefined classes)");
        for (const p of pseudos) if (!spec.pseudos.some((a) => a.startsWith(p))) err(`${p} is not supported on .${cls}`);
        allowed = spec.properties;
      });
      for (const decl of rule.body.split(";").map((d) => d.trim()).filter(Boolean)) {
        const [prop, ...rest] = decl.split(":");
        const name = prop.trim().toLowerCase();
        const value = rest.join(":").trim();
        if (/!important/i.test(value)) err(`${name}: no !important (SAC adds it)`);
        if (/var\(/i.test(value)) err(`${name}: CSS variables are not supported`);
        if (/gradient\(/i.test(value)) err(`${name}: gradients are not supported`);
        if (allowed && !allowed.has(name)) err(`property ${name} is not supported here (allowed: ${[...allowed].join(", ")})`);
      }
    }
  }
  return [...new Set(errors)];
}

/**
 * Rule-wise change of existing CSS: a rule whose selector already exists replaces that rule in place, new rules are
 * appended, remove drops rules by selector. Everything else (comments, formatting) stays as it is.
 */
export function mergeCss(existing: string, opts: { upsert?: string; remove?: string[] }): { css: string; replaced: string[]; added: string[]; removed: string[] } {
  const drop = new Set((opts.remove ?? []).map(normSelector));
  const incoming = parseCss(opts.upsert ?? "");
  const edits: { start: number; end: number; text: string }[] = [];
  const replaced: string[] = [];
  const removed: string[] = [];
  const used = new Set<number>();
  for (const r of parseCss(existing)) {
    const key = normSelector(r.selector);
    if (drop.has(key)) {
      edits.push({ start: r.start, end: r.end, text: "" });
      removed.push(r.selector);
      continue;
    }
    const k = incoming.findIndex((x, idx) => !used.has(idx) && normSelector(x.selector) === key);
    if (k >= 0) {
      used.add(k);
      edits.push({ start: r.start, end: r.end, text: formatRule(incoming[k]) });
      replaced.push(r.selector);
    }
  }
  let css = existing;
  for (const e of edits.sort((a, b) => b.start - a.start)) css = css.slice(0, e.start) + e.text + css.slice(e.end);
  const added = incoming.filter((_, idx) => !used.has(idx));
  if (added.length) css = `${css.replace(/\s*$/, "")}\n\n${added.map(formatRule).join("\n\n")}\n`;
  return { css: css.replace(/\n{3,}/g, "\n\n"), replaced, added: added.map((a) => a.selector), removed };
}

/** The story keeps a copy of the theme CSS and cuts it off at about this size. */
export const THEME_CSS_LIMIT = 76_000;
