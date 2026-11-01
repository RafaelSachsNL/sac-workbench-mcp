---
name: sac-css
description: Write, review and debug custom CSS for SAP Analytics Cloud (SAC) Optimized Stories — story CSS (Edit CSS / Global Settings), global default class, per-widget CSS class names, theme CSS, and runtime setCssClass(). Contains the complete list of the 245 supported sap-custom-* classes for all 38 object types (table, chart, input controls, button, popup, page, panel …) with their allowed properties, pseudos and descendants, scraped from the SAC CSS editor, plus the editor's validation rules as verified in practice. Use whenever SAC styling/CSS/theme work is done or the sac-workbench-mcp tools sac_story_css, sac_story_style_widget, sac_theme_* are used. Triggers on: SAC CSS, story CSS, theme CSS, sap-custom-, Global Default Class Name, styling a SAC table/chart/button.
---

# SAC Story CSS

SAC does **not** accept free CSS. Every rule must be
`.<your-class> .<sap-custom-class>[:pseudo] { <allowed properties> }`
and SAC compiles it into internal selectors with `!important`. Before writing any rule, look up the class in `references/CSS_CLASSES.txt` and only use the properties listed there.

## 1. Look-up

- `references/CSS_CLASSES.txt` – one line per class: `.class | object type | properties | pseudos | descendants`. Grep it:
  - `grep 'table' references/CSS_CLASSES.txt`
  - `grep '| Chart |' references/CSS_CLASSES.txt`
- `references/css-classes.md` – same data grouped by object type.
- `references/verified-behaviour.md` – what was tested in practice (validation messages, compiled output, pitfalls).

Data source: CSS editor of an Optimized Story (SAC 2026.21). SAP publishes no complete list; the editor dropdown is the source. To refresh, see section 7.

## 2. Selector grammar (enforced by the editor linter)

| Allowed | Example |
|---|---|
| Custom class alone | `.card { border-radius: 12px; }` |
| Custom class + one predefined class | `.my-theme .sap-custom-table-data-cell { color: #1d2d3e; }` |
| Pseudo on the predefined class (only those listed) | `.my-theme .sap-custom-button:hover { … }`, `.my-theme .sap-custom-table-row:nth-child(even) { … }` |
| Chained pseudos | `.my-theme .sap-custom-dropdown-item:nth-child(2):hover { … }` |
| Listed descendants (3 levels) | `.my-theme .sap-custom-popup-header-container .sap-custom-popup-header-font { … }` |
| Comma-separated selectors, comments, `calc()`, `rem`, `rgba()` | ✓ |

| Rejected (linter message) |
|---|
| `!important` → "Do not use important value." |
| Pseudo on the custom class `.my-x:hover` → "… is not a supported pseudo by .my-x" |
| Predefined class first / without custom class → "Only use user-defined class name as the first part of selector." |
| Two custom classes `.a .b .sap-custom-text`, compound `.a.b` → rejected |
| `#id`, element selectors (`div`), child combinator `>` → rejected |
| `@media`, `@import`, `@font-face`, `:root`, CSS variables `var(--x)` → rejected |
| `linear-gradient` in `background-color`; `background-image` on custom classes → rejected |
| Any property not listed for the class (e.g. `padding`, `margin`, `cursor`, `transition`, `text-align` on text, `text-transform`, `letter-spacing`) → "Property X is not supported in …" |
| Descendant that isn't listed (`.sap-custom-table-row .sap-custom-table-data-cell`) → rejected |

**Custom class alone** accepts `background-color, border, border-top/right/bottom/left, opacity, box-shadow, border-radius` (the SAP help page says only `background-color` and `border` — the editor allows more).

**Charts are SVG**: text classes use `fill`, not `color` (`.sap-custom-chart-data-labels { fill: … }`). Lines use `stroke`.

## 3. How classes are applied

- SAC compiles `.my-x .sap-custom-table-data-cell` to `.sap-user-defined-x.sap-custom-default-table <internal selectors>` — your class sits **on the widget itself**, not on an ancestor. A widget only receives a rule if *its own* class matches.
- **Global Default Class Name** (Outline → Global Settings) is put on every widget, page and popup that has no own class. A **widget CSS class overrides the global class completely** – the widget then gets none of the global rules. Theme/fragment classes count too (e.g. MCP buttons carry `button--lite`), so a themed widget ignores your global theme until you assign the class explicitly.
- Consequence: put all rules for one look into **one class** (e.g. `my-theme`) and use it as global default; for special widgets create a second full class or accept that only that class's rules apply.
- Widget type ≠ dropdown label you'd guess: a page input control on a version/measure is a **Calculation Input Control** (`sap-custom-calculation-input-control-*`), not `input-control-*`. Check `sap_story_get` (`class`, e.g. `UQMInputControlWidget`) or the DOM class `sap-custom-default-<type>` if a rule has no effect.
- Priority (SAP): CSS editor > theme CSS > font scaling > Format panel > theme settings. CSS colors override threshold/conditional colors in charts.
- Font sizes via CSS can truncate texts/data labels (known issue with `.sap-custom-chart-data-labels`, SAP KBA 3769947).

## 4. Structure that works

- One global class (e.g. `my-theme`), set as Global Default Class Name; all story-wide rules hang on it.
- Extra classes for single widgets (e.g. `card-accent`), each a complete class — a widget gets only one class.
- Reusable across stories → load the story CSS into the theme (Theme settings → Enable Theme CSS → Load Story CSS)
  instead of copying it into every story.

## 5. Workflow with sac-workbench-mcp

Without the MCP server (e.g. claude.ai in the browser): deliver the CSS for Outline → Global Settings → Edit CSS plus which class name goes into which widget's Styling panel (or the Global Default Class Name). Check every rule against section 2 and `CSS_CLASSES.txt` before handing it over.

With sac-workbench-mcp (Claude Desktop / Claude Code):

1. Inspect: `sac_story_get` (widget names/types/classes), `sac_story_css action:get`, Global Default Class Name in the story.
2. Write CSS that follows section 2, using only classes/properties from `CSS_CLASSES.txt`.
3. **Validate** — `sac_story_css` and `sac_theme_create`/`_update` check the CSS against these rules and refuse it (unless `forceCss`). Theme CSS is checked by the more permissive theme-compiler rules. SAC itself stores and even renders some unsupported properties (e.g. `text-transform`), but they may break with updates. For edge cases use the editor linter (section 6).
4. Write: `sac_story_css action:set` (replace all) or `action:class`; assign classes with `sac_story_style_widget cssClass:…`. Global default class: Outline → Global Settings (UI).
5. Verify visually: open the story in view mode (full reload: navigate away + F5 — SPA hash navigation keeps the old stylesheet), `sac_browser_screenshot`; `sac_story_check_runtime` for errors.
6. Runtime switching: `Widget.setCssClass("…")` / `getCssClass()` (also `ApplicationPage`, `Popup`) — verified working (see the sac-scripting skill).

## 6. Linting via the editor (programmatic)

With the story open in edit mode and the CSS editor tab open (Outline → Global Settings → CSS icon), run via `sac_browser_eval` (`allowalteration: true`; it only changes the unsaved editor buffer — restore it afterwards or don't save):

```javascript
const cm = document.querySelector('.CodeMirror').CodeMirror;
const original = cm.getValue();
cm.setValue(CSS_TO_CHECK);
await new Promise(r => setTimeout(r, 1500));
const msgs = (cm.state.lint.marked || []).map(m => m.__annotation.message);
cm.setValue(original);
return JSON.stringify(msgs);   // [] = valid
```

## 7. Refreshing the class list

In the open CSS editor, iterate the `ui5-combobox` items, fire `selection-change`, read `.cssClassDefinition` (see `references/verified-behaviour.md` for the snippet), save the JSON and run `python3 skills/tools/build_css_reference.py <raw.json> skills/sac-css/references <date>` from the repository root.

## 8. Example

All rules pass the linter; rendered and checked on screen except the chart rule (only the compiled selector was verified).

```css
.my-theme .sap-custom-page { background-color: #f4f5f7; }
.my-theme .sap-custom-panel-widget { border-radius: 12px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12); }
.my-theme .sap-custom-text { color: #1d2d3e; }
.my-theme .sap-custom-table-dimension-header-cell { background-color: #eef1f4; font-weight: bold; color: #1d2d3e; }
.my-theme .sap-custom-table-row:nth-child(even) { background-color: #fafbfc; }
.my-theme .sap-custom-table-data-cell { font-family: Arial; color: #1d2d3e; }
.my-theme .sap-custom-table-editable-cell { background-color: #eef6fd; }
.my-theme .sap-custom-table-grid-line { border-color: #e5e7eb; }
.my-theme .sap-custom-calculation-input-control-main-label { color: #0A6ED1; font-weight: bold; }
.my-theme .sap-custom-button { background-color: #0A6ED1; border-color: #0A6ED1; border-radius: 8px; color: #ffffff; font-weight: bold; }
.my-theme .sap-custom-button:hover { background-color: #0854a0; border-color: #0854a0; }
.my-theme .sap-custom-chart-data-labels { fill: #1d2d3e; font-weight: bold; }
.card-accent { border-left: 4px solid #0A6ED1; border-radius: 12px; }
```
