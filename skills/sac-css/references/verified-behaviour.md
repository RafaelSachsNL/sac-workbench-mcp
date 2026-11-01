# SAC CSS – verified behaviour (SAC 2026.21)

Tested in a test story (copy of a planning story with table, input controls, buttons and texts).

## Linter results (CSS editor, `cm.state.lint`)

| Input | Result |
|---|---|
| `.test { color: red; }` | Property color is not supported in user-defined classes. |
| `.test { background-color:#fff; border-radius:12px; box-shadow:0 1px 4px rgba(0,0,0,.15); }` | OK |
| `.test { padding: 8px; margin: 4px; }` | padding / margin not supported in user-defined classes |
| `.test:hover { … }` | Only use user-defined class name as the first part of selector. · :hover is not a supported pseudo by .test. |
| `.sap-custom-table-data-cell .test { … }` | Only use user-defined class name as the first part … · Only use pre-defined class name here. |
| `.sap-custom-panel-widget { … }` (no custom class) | Only use user-defined class name as the first part of selector. |
| `.test .sap-custom-table-data-cell { color: red !important; }` | Do not use important value. |
| `.test .sap-custom-table-data-cell { box-shadow: … }` | Property box-shadow is not supported in .sap-custom-table-data-cell. |
| `.test .sap-custom-table-data-cell { color:#0A6ED1; font-weight:bold; }` | OK |
| `.test .sap-custom-table-row:nth-child(even)` / `:nth-child(2n+1)` | OK |
| `.test .sap-custom-chart-data-labels { color: red; }` | Property color is not supported … (use `fill`) |
| `.test .sap-custom-chart-data-labels { fill: red; }` | OK |
| `.test .sap-custom-popup-header-container .sap-custom-popup-header-font { … }` | OK (listed descendant) |
| `.test .sap-custom-table-row .sap-custom-table-data-cell { … }` | Please define class .sap-custom-table-data-cell as a descendant of .sap-custom-table-row. |
| `@media (max-width:600px) { … }` | @media not allowed here. |
| `@import url(…)` / `@font-face { … }` | not allowed here |
| `:root { --red: … }` / `color: var(--red)` | rejected · Expected color but found 'var(--red)'. |
| `.test .sap-custom-text, .test .sap-custom-button { color: red; }` | OK |
| `#abc .sap-custom-text` | Only use user-defined class name as the first part … |
| `div .sap-custom-text` | Please don't use element in a selector. |
| `.test * { color: red; }` | OK (linter accepts; effect not tested) |
| `.a .b .sap-custom-text` | Only use pre-defined class name here. |
| `.test.other .sap-custom-text` | Adjoining classes … |
| `.test > .sap-custom-text` | Only use descendant combinator. |
| `.my-theme-1 .sap-custom-button:hover { background-color:#00ff00; border-color:#0000ff; }` (SAP help example) | OK – renders green/blue on hover |
| `.test { background-color: linear-gradient(…) }` | Expected color but found 'linear-gradient(…)'. |
| `.test { background-image: … }` | not supported in user-defined classes |
| `.test { border-radius: calc(4px * 2); }`, `font-size: 1.2rem` | OK |
| `.test .sap-custom-button { cursor:pointer; transition:… }` | not supported |
| `.test .sap-custom-button { border: 1px solid red; }` | border not supported (use border-color) |
| `.test .sap-custom-text { text-align / text-transform / letter-spacing }` | not supported |
| `.test .sap-custom-dropdown-item:nth-child(2):hover { … }` | OK |

## Compiled output (what SAC injects into the page)

```css
.sap-user-defined-lab.sap-custom-default-table .reactTableComponent .tableContainer .dataCell { font-family: Arial !important; color: #1d2d3e !important; }
.sap-user-defined-lab.sap-custom-default-button .sap-custom-button:hover { background-color: #00ff00 !important; … }
.sap-user-defined-lab.sap-custom-default-viz viz-renderer::part(sap-custom-chart-data-labels) { fill: … !important; }
.sap-user-defined-card-accent { border-left: 4px solid #0A6ED1 !important; border-radius: 12px !important; }
```

- Custom class → `sap-user-defined-<name>` on the widget container, next to `sap-custom-default-<type>` (`appPage, panel, flowpanel, text, table, button, viz, composite, calcInputControlWidget, …`).
- `!important` is added automatically.

## Runtime / API findings

- SAC stores CSS written through the API without its linter: an unsupported property (`text-transform: uppercase`) was compiled and **rendered** — works today, but unsupported. (sac-workbench-mcp validates before saving.)
- Global Default Class (`lab`) applied to page, panels, texts, table, input control — **not** to a button which already had the class `button--lite` (widget class wins over the global class). After assigning `lab` to the button, its rules applied.
- A plan-version selector that is a Calculation Input Control: `sap-custom-input-control-main-label` had no effect, `sap-custom-calculation-input-control-main-label` worked.
- After changing CSS via API, an open story keeps the old stylesheet: leave the story, reload (F5), open again.
- `PA_CARD_FILTERBAR.setCssClass("lab")` / `getCssClass()` from a button onClick toggled the class at runtime (accent border removed / restored); `sac_story_check_runtime` reported no errors.

## Scraping snippet (CSS editor open)

```javascript
const cb = document.querySelector('ui5-combobox');
const out = {};
for (const item of cb.querySelectorAll('ui5-cb-item')) {
  cb.value = item.text;
  cb.dispatchEvent(new CustomEvent('selection-change', {detail: {item}, bubbles: true}));
  cb.dispatchEvent(new CustomEvent('change', {bubbles: true}));
  await new Promise(r => setTimeout(r, 700));
  out[item.text] = document.querySelector('.cssClassDefinition').textContent;
}
return JSON.stringify(out);
```
