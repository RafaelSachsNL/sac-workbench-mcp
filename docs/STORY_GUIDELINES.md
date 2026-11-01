# Story guidelines

Rules for stories created or changed through this server. They are also served to the MCP client as the prompt
`story_guidelines` and the resource `sac://guidelines/story`. Adapt them to your own design system.

## 1. Clarify before creating

If one of these is missing from the request, **ask — don't guess**:

| Item | Rule |
|---|---|
| Data model | If no model is named, list the available ones with `sac_models_list` (most recently used first) and let the user choose. Never assume a model. |
| Theme | Find the themes with `sac_design_assets` and propose them. Ranking: own prefix (`SAC_BRAND_PREFIX`) first, then the highest version in the name, then most recently changed. |
| Template | Same as theme. If there are no templates, skip the question. |
| Layout | Ask: **responsive** or **canvas**. |
| Header (canvas) | Ask whether the header should be inverted (dark). Use a logo/image if the user provides one. |

`sac_story_generate_dashboard` enforces this: without model, theme, template and layout it returns `needsInput` with
options and creates nothing.

## 2. Canvas layout

Top to bottom; only create the areas that are needed.

1. **Header:** at most 80 px high, no gap to the top, left and right. Optionally inverted. No rounded corners.
   **Header as composite (recommended):** `headerComposite` instead of the built-in 72 px header — 40 px, title only
   (composite property `Title`, set per story). Create it once with `sac_composite_header_create`.
2. **Filter bar:** only with filters/controls. One tile, exactly 40 px high; inside a flow panel with 4 px padding,
   input controls 32 px high (so they are centred vertically), 200 px wide, 8 px apart, without icon.
3. **KPI bar (flow panel):** only with KPIs; up to 5 Numeric Points. Not too wide, but readable.
4. **Body (flow panel):** only for alignment; no rounded corners, no shadow. Inside: cards, e.g. 2 × 50 % side by
   side, below a table or 3 cards.

Header, filter bar and KPI bar are **fixed**; only the body scrolls.

**Mobile (≤ 768 px container width):** the KPI bar shows the first two KPIs at 50 % (the rest hidden), body cards
100 %, input controls 50 %.

**Spacing:** every panel / flow panel used as a tile has a **4 px margin on all four sides** — 8 px between tiles and
4 px to the edge. Surrounding rows and flow panels get no spacing of their own, otherwise the values add up.

**Look:** everything except header and body container has **rounded corners** and a **shadow**.

`sac_story_generate_dashboard` with `layout: "canvas"` builds this automatically: header 72 px, KPI bar 130 px (up to
5 cards at 20 %), body with cards (charts 2 × 50 % at 400 px, table 100 %). `filters` (dimensions) add the fixed
filter bar. Input controls are page filters and filter every widget on the page; add single ones with
`sac_story_add_input_control`. Only the empty skeleton (header, filter bar, empty cards, optionally bound to a
planning model): `sac_story_canvas_create`.

### With the "Fiori Horizon" community content

SAP Community content (`Public / SAP_Community`: *SAC UX – Fiori Theming* and *SAC UX – Fiori Story Best Practices*)
provides a theme and a template whose CSS classes this layout uses:

- **Card (rounded + shadow):** panel/flow panel with CSS class `card` and border radius **12** (set on the panel).
- **Header:** CSS class `card_Header`, no radius.
- **Page background:** `page__background`.
- **Card title:** 48 px title row with `logicGroupHeader`, text with `logicGroupTitle`.
- **KPIs:** `kpi_fixed-font-size`.
- **Own classes:** one class per widget (SAC ignores further ones). Variants such as "card with red accent" are a
  complete class of their own (`sac_story_css`, action `class`).

## 3. Responsive

Title text, KPI bar in a flow panel, charts in pairs (50 %), table full width. The lane has 36 grid columns.

## 3a. Which kind of filter?

"Filter" means different things — clarify which one:

| Kind | Where | Effect | Tool |
|---|---|---|---|
| Insight filter | Data Analyzer | the one query; table and chart are two views of it | `sac_insight_create` / `sac_insight_update` (`filters`) |
| Story filter | Story | every page and widget of the dataset | `sac_story_add_filter` |
| Input control – member filter | Story | page filter: every widget on the page | `sac_story_add_input_control` |
| Input control – measure swap | Story | the viewer picks the measure the linked charts show (not a filter) | `sac_story_add_input_control` (`kind: "measureSwap"`) |
| Input control – dimension swap | Story | the viewer picks the dimension the linked charts break down by | `sac_story_add_input_control` (`kind: "dimensionSwap"`) |
| Input control – measure range | Story | keeps members whose measure value is in a range | `sac_story_add_input_control` (`kind: "measureRange"`) |
| Chart filter | one chart | member or dynamic date filter of that chart | `sac_story_chart` (`filters`) |

## 4. Naming convention (outline)

| Object | Pattern | Example |
|---|---|---|
| Widgets | `<TYPE>_<SUBTYPE?>_<CONTENT>_<NNN>[_P<nn>]` | `CH_KPI_SALES_001`, `CH_BAR_SALES_001`, `TA_SALES_001`, `TE_TITLE_001` |
| Type codes | `TA` table, `CH` chart (`KPI`, `BAR`, `COL`, `LIN`, `PIE`, `DON`, `WAT`), `TE` text, `PA` panel, `FP` flow panel, `IC` input control, `BT` button | |
| Structural containers | no number | `PA_HEADER`, `PA_BODY`, `FP_BODY`, `FP_KPI` |
| Pages | `PAGE_<n>` | `PAGE_1` |
| Script objects | `SO_<PURPOSE>` | `SO_KPI`, `SO_START` |
| Functions | camelCase by purpose | `getDimensionNames`, `setKPIValues` |
| Global variables | `gv_` + camelCase | `gv_CountryArray`, `gv_Page` |

Content in upper case, ASCII only. The page suffix is added only with several pages.

## 5. Presentation

**Minimal look:** widgets show content only, no generic extra information.

- Charts/KPIs: subtitle (unit/scale) hidden; errors and warnings stay visible. KPIs without a measure label.
- Tables: header (title, subtitle, details) and dimension headers hidden.
- Input controls: no icon.
- `sac_story_format_widget` with `minimal: true`; the generator applies it to every widget.

**KPIs are Numeric Point charts** (`sac_story_add_kpi`), bound to the model — not text fields filled by a script.

**Colours:** red and green are signal colours — only for variances, thresholds and deliberate highlights.
- Series colours neutral (dark blue, petrol, grey …), never red or green.
- If the user wants them anyway, explain the drawbacks first (everything looks "bad"/"good", real variances get lost,
  red-green colour vision deficiency) and only apply after explicit confirmation. Theme and colour tools refuse
  red/green until `confirmSignalColors: true`.

**Numbers:** default scale Million, 1 decimal (unless asked otherwise). Percentage measures (%, PCT, PERCENT in name or
caption) unscaled — otherwise "+0.0 Million". Stored scale values (recorded from the styling panel): Default = no
entry, Unformatted = `""`, Auto-Formatted = `"auto"`, otherwise Thousand/Million/Billion; any other text is shown
literally as the unit.

**Texts:** readable titles instead of technical names (filters: `title` / `customTitle` when the model only has
technical names, e.g. FISCALYEAR → "Fiscal Year"). Header and card titles without a fixed colour, so they follow the
theme (light or dark); only an inverted header sets white.

## Dashboards on SAC models (planning native / Seamless, analytic)

- `sac_story_generate_dashboard` also takes SAC models — planning (native or Seamless) and analytic (`model`: name or
  C… id, no connection/space): `responsive`, or `canvas` with a story template (the same Horizon schablone as for
  Datasphere). `filter` (story filter) works in both layouts, `filters` (filter bar with input controls) on canvas only.
  `table` is optional and is scaled like the KPIs and charts (`scale`, `decimals`).
- SAC models refuse queries that add up versions ("'Version' is not in drill and is not filtered"). The generator
  therefore sets Version = Actual on every chart, KPI and table; a KPI tile with its own Version filter (e.g.
  `public.Plan`) keeps it.
- With only one measure, the KPI tiles differ by `kpis[].filters` (Version, `dynamic` year/quarter/month/day).
- Dimensions with a hierarchy are shown flat (leaves); use `sac_story_chart` to show the hierarchy in a chart.
- Under the hood: the Datasphere building blocks are rewritten (dataset id `planning:[schema][][object]`, DataSource
  `Type Planning`, free axis with the target model's dimensions, text attribute `<Dim>.Description`); the story gets no
  metadata cache (`persistedUdm`), SAC builds it at runtime.

## Changing charts (`sac_story_chart`)

One tool for all chart types: `sac_story_chart_get` returns a description, `sac_story_chart` changes only the given
parts. "Chart B like A, but as a line" = read A, adapt, apply to B.

| Type | Measure feed | Dimension feed | Note |
|---|---|---|---|
| barcolumn, stackedbar, line, area | valueAxis | categoryAxis | plus `color`, `pattern` (e.g. Version: Actual solid, Plan hatched). `area` stacks |
| donut, pie | size | color | the dimension sits on the Columns axis of the query; `legend: true` = names in the data labels |
| treemap | weight | title | the `color` feed is a measure |
| metric (Numeric Point) | valueAxis | – | KPI tiles |

What SAC requires (otherwise "dimension altered in the model" or duplicated segments):
- A type change within a family is `type` only; between families the feeds are renamed.
- Every feed dimension is also in the query: axis (Rows; donut/pie: Columns), axes repo, dimension list (a minimal
  entry is enough, SAC completes it), `usedDimensions` (with hierarchy).
- Measures also in the measure filter and as members of the measure structure; removed measures are cleaned up.
- Switching to donut: hole (`innerRadiusRatio` 50 %), treemap label layout removed.
- Filters: `filters: [{dimension: "Version", members: ["Actual"]}]` (restricted measures need exactly one version) or a
  dynamic date `{dimension: "Date", dynamic: {granularity: "month", last: 2}}` = current month and the two before
  (year/quarter/month/day; weeks in year-week-day hierarchies are not supported yet). The granularity must fit the
  date hierarchy; month/quarter on a week hierarchy is switched to year-quarter-month.
- Hierarchy/level: `hierarchy: {Product: {id: "H_CAT", level: 1}}`. Levels count from 0 (0 = top nodes); a level
  below the leaves gives "No data". Scripts' `setHierarchyLevel` counts from 1 and overrides the stored level on start.
- Check scripts that refer to a chart's measures (e.g. `rankBy` with `getMembers(Feed.ValueAxis)`) after changes.

### KPI tiles and duplicating

- `sac_story_add_kpi`: copies a chart of the same model and turns it into a Numeric Point with one measure and
  filters (e.g. Version Actual, current month).
- `sac_story_duplicate`: widget or whole card with new ids and its own text entities; children renamed with
  `renameFrom` / `renameTo`. Scripts are not copied.
- A copy into another container gets a fixed 300 × 140 px box (adjust with `position`) and is visible even if the
  source is shown only by a script. In flow panels it is appended (`sac_story_set_layout` `order`).

### Calculations (`sac_story_calculation`)

- Restricted measure: `measure` + `restrictions: [{dimension: "Version", members: ["Actual"]}, {dimension: "Store",
  members: ["S1"]}]`, any number of dimensions. `constantSelection: ["Version"]` ignores the version from chart/page
  filters — needed when actual and target are in one chart or the context filters the version.
- Calculated measure: `formula` with `[#Name]` (story calculation) and `[MEASURE_ID]` (model measure), numbers,
  + − * / and brackets. Same name = replace (the id stays, charts stay linked).
- "No data" for a formula: usually an input returns nothing in the chart context (e.g. no constant selection while
  the context filters another version). Check the inputs one by one.
- `charts: [...]` adds the result to these charts' measures.

### Series colours (`sac_story_set_colors`)

Story-wide for all charts of the model:
- Members: `members: {Store: {S1: "#1F4E79"}}`. If the charts show a hierarchy, pass `hierarchies: {Product: "H_CAT"}`
  (key `[Product].[H_CAT].&[ID]`, parent nodes too). Other key forms are ignored by SAC.
- Version: `versions: {Plan: {color, pattern: "hatching8"}}` — Actual solid, Plan hatched (`hatching1`–`hatching8`).
- Measure/calculation: `measures: {"Sales actual": {color}}`; only where charts colour by measure.

## Checking the layout (`sac_story_inspect`)

After layout/CSS changes instead of eyeballing screenshots: `widths: [1600, 760, 420]` (below ~616 px use
`mode: "present"`, the SAC shell has a minimum width). Reports per widget: scrollbars inside containers, widgets
sticking out of their parent (scroll areas excepted) and runtime errors. `widget` + `hover` returns a PNG of that widget.

## Composites

- Reusable building blocks (Stories → Composites). Header: `sac_composite_header_create` (40 px, title only).
- Input controls inside a composite only act inside it ("No Connected Widgets" in the story) — build filter bars as a
  normal tile in the story.

## Planning stories with forecast layout

`sac_planning_forecast_story_create` creates a planning story on a Seamless planning model from the recorded template
`templates/planning_forecast_story.json` (re-targeted by text replacement; the query dimension lists are cleaned up
afterwards; the query caches stay in the template, without them the version control reports "no longer usable").

- **Current year (asymmetric):** table type *Forecast Layout*. Look Back On = Actual, Look Ahead On = plan version,
  Cut-Over Date = Today, Granularity = Month, Range = Year, Sum For = cut-over year → actuals to date, plan to year end.
- **Next year:** same, but Granularity = Quarter and Look Ahead Additional = 1 year. The current year's quarters are
  hidden, so only the current year's total and next year's quarters remain; next year is expanded.
- **Version choice:** a calculation input control (dimension Version) as Look Ahead On in both tables
  (`forecastLayout.lookAheadCIC`).
- **Hiding columns:** `data.content.hiddenTuples`. On load SAC replaces every tuple containing the Version dimension
  with its own forecast tuples, so own tuples are created on Date only.
- **Expanding:** `ffQuery.HierarchyNavigationsRepo` gets a DrillOperation (Expanded, Date member, context Version) plus
  `initialUQMExternalState.expands[0].drillPaths`.
- **Minimal look:** `dataRegion.showTitleText/showSubtitle/showDetails = false`.
- "Cannot reach the remote system" is usually a short Datasphere connection drop; a data refresh is enough.
- The template references the "Fiori Morning Horizon" theme and a header composite. Whatever your tenant does not
  have is dropped when the story is created (default theme / no header composite); the result lists it as `dropped`.

## Changing models (recorded from the modeler)

- Add a dimension = `fpa/dimension createWithResource` + `fpa/member update` (`#` and further members) +
  `fpa/model updateDesignTime` with the whole cube from `getDesignTime`. Lock version: `contentLibData.metadata.version`
  (not `updateCounter` — otherwise "INCONSISTENT_VERSION"). Without `batchMode` SAC answers synchronously; with
  `batchMode` an error only shows up as a notification id.
- Existing fact rows get the value of `initialFactColumnValue` of the new column (UI: "Select Default Members").
  Without it they stay `null` and no filter or planning reaches them; `defaultValue` has no effect.
- Parent-child hierarchy: new hierarchy = `fpa/dimension updateWithResource` with the dimension (from `getDesignTime`
  → `dependentObjects.DIMENSION`) and `{hierarchy, description, isNewHierarchy: true}`; filling it = member columns
  `<H>` (parent; empty = top node, "<root>" in the modeler grid) and `<H>_PREVID` (previous sibling = order).
  `sac_model_members_set` keeps these columns.
- `sac_plan_read` reads members flat (without hierarchy) — a parent node returns 0 there; in stories it aggregates.
- Reloading data with a new column (`sac_model_data_reload`): `dryRun` first (backup + distribution), then for real;
  the target members must exist (`sac_model_members_set`). CleanAndReplace runs per version in one request (up to
  200,000 rows); success = equal totals per version. Backups go to `captures/backups` (git-ignored).
