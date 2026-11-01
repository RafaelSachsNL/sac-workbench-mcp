# Tools reference

Every tool the server registers — 178 tools plus 3 expert tools — generated from the server itself (`npm run docs:tools`).
Tools marked ✏️ change something in SAC and only run with `allowalteration: true`; the others only read.
Tools marked 🔧 are expert tools, only loaded with `expertTools: true` / `SAC_EXPERT_TOOLS=true`.
Required parameters are **bold**. For what the server does as a whole see the [README](README.md).

## Contents

- [Stories & widgets](#stories--widgets) — 30 tools
- [Charts & calculations](#charts--calculations) — 8 tools
- [Themes & CSS](#themes--css) — 8 tools
- [Scripting & checks](#scripting--checks) — 6 tools
- [Planning & models](#planning--models) — 19 tools
- [Data Analyzer & live models](#data-analyzer--live-models) — 6 tools
- [Files & content](#files--content) — 11 tools
- [Data import & export (public API)](#data-import--export-public-api) — 46 tools
- [Users, teams & administration (public API)](#users-teams--administration-public-api) — 30 tools
- [Browser session, recording & raw requests](#browser-session-recording--raw-requests) — 17 tools

## Stories & widgets

| Tool | What it does | Parameters |
|---|---|---|
| `sac_composite_header_create` ✏️ | Create a lean page header composite, 40 px, title only (bold, vertically centred). Title is a composite property, so every story sets its own text: sac_story_add_composite with role "header" and properties {Title: "…"}. | **name**, description, folderId, **title**, inverted |
| `sac_fragment_extract` | Learn a widget type: after building it once in the SAC UI, lift everything SAC stores for it into a reusable fragment (templates/fragments/<name>.json). Needs a snapshot from before the widget was added (sac_story_snapshot) and compares it with the live story. Name the dimensions and measures the widget uses so they can be swapped on insert. | **storyId**, **before**, after, **widgetName**, **name**, **description**, **dimensions**, **measures**, textMarker |
| `sac_fragment_list` | List the widget fragments available for sac_story_add_widget. |  |
| `sac_stories_copy` ✏️ | Copy a story. | **sourceStoryId**, copyToFolder, newName |
| `sac_stories_delete` ✏️ | Delete a story. | **storyId** |
| `sac_stories_list` | List stories via GET /api/v1/stories. WARNING: This endpoint does NOT support OData filtering. All query parameters ($filter, $top, $orderby, etc.) are silently ignored by the SAC API — it always returns every story on the tenant (3000+). The response does NOT include an 'owner' field. Response fields per story: storyId, name, createdBy, changedBy (and optionally model metadata). TO FILTER STORIES BY USER OR TYPE use sac_filerepository_list instead, which supports real OData $filter on createdBy, modifiedBy, resourceType, createdTime, etc. | includeModels |
| `sac_stories_rename` ✏️ | Rename a story. | **storyId**, **newName** |
| `sac_story_add_button` ✏️ | Add a button with an onClick script to a container (page outline name or panel), e.g. text "Plan berechnen" and onClick "DA_PLAN_PLUS5.execute(); TA_PLANUNG_001.getDataSource().refreshData();". Name defaults to BT_<TEXT>_NNN. | **storyId**, **container**, **text**, name, onClick, left, top, width, height, right |
| `sac_story_add_composite` ✏️ | Place a composite (e.g. a filter bar from sac_composite_filterbar_create) in a story: imports it into the story's assets and adds it to a container (page outline name like PAGE_1, or a panel). Default position: full width below the 72 px header with the 4 px tile margin, height 40 px. | **storyId**, **compositeId**, role, container, properties, name, top, height, left, right |
| `sac_story_add_dataaction` ✏️ | Add a data action to a story as scripting object (e.g. DA_PLAN_COPY) with a fixed target version. Run it from a script, e.g. sac_script_event_set on a button onClick: DA_PLAN_COPY.execute(); | **storyId**, **name**, **dataActionId**, **targetVersion**, autoPublish |
| `sac_story_add_filter` ✏️ | Add a story filter (applies to all pages and widgets of the dataset) on one dimension, restricted to the given members (member keys, e.g. PC2). | **storyId**, **dimension**, **members**, datasetId |
| `sac_story_add_input_control` ✏️ | Add an input control to a container (page outline name like PAGE_1, panel or flow panel); it filters every widget on the page. kind "member" (default): member filter on a dimension. kind "measureRange": measure filter — keeps the members of the context dimension whose measure value lies in the ranges (e.g. Gross_Sales 0–100 Mio per DJ_State). kind "measureSwap" / "dimensionSwap": the viewer switches which measure / dimension the linked charts show (options + charts; dimension is ignored, pass any). Not filters: they change the chart axis. Minimal look: no header icon (hideIcon defaults to true). Name defaults to the convention (IC_<DIMENSION>_NNN). | **storyId**, **container**, kind, **dimension**, name, members, measure, ranges, options, charts, title, hideIcon, left, top, width, height |
| `sac_story_add_kpi` ✏️ | KPI tile as Numeric Point (rule: KPIs are Numeric Point charts bound to the model, not text fields filled by script). Copies a chart of the same model (sourceChart, default: the first chart found), turns it into a Numeric Point with one measure (model measure or calculation) and optional filters (Version, dynamic date …). Name e.g. CH_KPI_SALES_001. | **storyId**, **name**, **measure**, container, sourceChart, filters, position |
| `sac_story_add_widget` ✏️ | Add a widget from a fragment (see sac_fragment_list) to a story: into a container (lane/panel, by outline name) at a position in grid units, bound to the story's model with the given dimensions and measures, under an outline name. | **storyId**, **fragment**, **container**, name, content, dimensions, measures, position, datasetId, text, html |
| `sac_story_canvas_create` ✏️ | Empty canvas schablone for content added afterwards (planning tables, charts): header (40 px composite via headerComposite, or classic), optional 40 px filter bar (container FP_FILTERBAR_ITEMS for input controls), and full-width cards with a title row (heights in px). Optionally binds a planning model (native or Seamless) as data source. | **name**, description, folderId, **title**, template, headerComposite, headerInverted, filterBar, **cards**, model |
| `sac_story_create_from_template` ✏️ | Create a new story from a story template (see sac_design_assets → templates), like 'Templates' on the Stories start page. The template brings its pages, layout, theme and scripts. | **template**, **name**, description, **folderId** |
| `sac_story_create_table` ✏️ | Create a new responsive story containing one table (rows: one dimension, columns: one measure) bound to a Datasphere analytic model via a live connection, and save it into a folder. Uses SAC's internal content library (the same calls the story editor makes). Returns the new story id and URL. Example: model DEMO_SALES_MODEL in space DEMO_SPACE on connection DWC_LIVE, rowDimension DJ_State, measure Gross_Sales. | **name**, description, **folderId**, connection, space, **model**, **rowDimension**, **measure**, userId |
| `sac_story_diff` | Structural diff between two snapshots of a story (or a snapshot and the live story with to="live"). Arrays with ids are matched by id. Use it to learn how SAC stores a feature: snapshot, change one thing in the UI and save, diff. | **storyId**, **from**, to, ignore, maxValueChars, list |
| `sac_story_duplicate` ✏️ | Duplicate a widget or a whole card (panel with all children) with new ids and its own text entities (unlike the editor's Duplicate, deleting one copy does not break the other). name = outline name of the copy; children get renameFrom → renameTo (e.g. "EHR" → "DTZ") or "_2". Optional target container and position. Scripts are not copied. | **storyId**, **source**, **name**, container, renameFrom, renameTo, position |
| `sac_story_generate_dashboard` ✏️ | Follow docs/STORY_GUIDELINES.md (MCP prompt story_guidelines). Without theme, template and layout this tool returns needsInput with options instead of creating anything — ask the user, then call again. Generate a complete dashboard story in one step: title, KPI row (numeric points), bar charts (two per row) and a table, optionally a story filter and a theme profile. - responsive: one lane (template 'none'). - canvas: schablone on a story template with the Horizon CSS (e.g. "Horizon Template"): fixed 72 px header (card_Header, optionally inverted), fixed KPI row (up to 5 cards), scrolling body with cards (class card, radius 12), 10 px spacing everywhere. All widgets are bound to one Datasphere analytic model and named after the convention (TE_TITLE_001, FP_KPI, CH_KPI_SALES_001, CH_BAR_…, TA_…). - SAC models — planning (native or Seamless) and analytic; pass the model name, no connection/space: responsive or canvas (with a story template); story filter (filter) in both, input controls (filters) on canvas; every widget is filtered to Version Actual unless a KPI names its own Version filter. With one measure, KPI tiles differ by their filters (e.g. Version public.Plan, dynamic year/month). Dimensions/measures accept captions or technical names (see sac_model_metadata). | **name**, description, **folderId**, connection, space, model, **title**, filters, kpis, charts, table, filter, theme, template, layout, headerInverted, headerComposite, scale, decimals |
| `sac_story_get` | Read an optimized story. Default: a structured summary (pages with nested widget tree incl. outline names, widget ids, classes, entity types and responsive positions; datasets; scripting; entity counts). With 'path' returns the raw JSON at that path inside the content document, e.g. ["entities", {"type":"story"}, "data", "pages", 0] or ["entities", {"id":"<widget entity id>"}, "data"]. Selectors {"key":"value"} pick array elements. | **storyId**, path, maxChars |
| `sac_story_patch` ✏️ | Low-level edit of a story's content document followed by a save (optimistic locking: fails if the story was saved in between). Ops: set \| remove \| merge (shallow object merge) \| append (array push). Paths as in sac_story_get. Use sac_story_get with 'path' first to see the exact structure; prefer the dedicated tools where they exist. | **storyId**, **ops**, dryRun |
| `sac_story_remove_widget` ✏️ | Remove a widget from a story by outline name (containers are removed with their content). | **storyId**, **widget** |
| `sac_story_rename_widgets` ✏️ | Rename widgets/pages in the story outline (the script names). Identify each by its current outline name or widget id. | **storyId**, **renames** |
| `sac_story_restore` ✏️ | Write a local snapshot (sac_story_snapshot, or the one sac_story_transform keeps) back into the story — undo. | **storyId**, **label** |
| `sac_story_set_layout` ✏️ | Flow panel layout in one call: padding inside (number = all sides, or {top,right,bottom,left}), gap between children (number or {horizontal, vertical}), order of the children (outline names; unlisted ones follow) and fixed child sizes {NAME: {width, height}}. tiles: padding 4 / gap 8 instead of wrapper panels (CSS has no padding). | **storyId**, **container**, padding, gap, order, sizes |
| `sac_story_set_position` ✏️ | Position a widget in its container (canvas): pixel offsets left/top/right/bottom, or width/height. left+right (top+bottom) stretch it. Typical: a table filling a card below its 48 px title → left 8, top 56, right 8, bottom 8. container moves the widget into another container first (e.g. an input control into the filter bar flow panel). | **storyId**, **widget**, container, left, top, right, bottom, width, height |
| `sac_story_set_text` ✏️ | Change text widgets that already exist. Either one widget: text (keeps its formatting; \n = new paragraph) or html (replaces everything). Or many at once: replace [{from, to}] in all text widgets (optionally only in 'widgets') — for renaming, wording fixes and translation. Text only, tags and styles stay. | **storyId**, widget, text, html, replace, widgets |
| `sac_story_snapshot` | Save the current content of a story locally (captures/snapshots) under a label, as the 'before' or 'after' of a diff. | **storyId**, **label** |
| `sac_story_transform` ✏️ | Change a story with a JavaScript function body (story patch by function): load → run → snapshot → save, with the usual version-conflict fallback. The body gets `content` (the story document, mutate it) and `h` helpers: h.widget(name) → {id, kind, registry, layoutEntry, section, layout, entity, page}; h.innerLayout(name) (children = its sections, in order); h.names(); h.story(); h.app(); h.pages(); h.find((value, key) => bool). Return a value to get it back as 'result'. Sandboxed (no require/fetch), 5 s limit. Before saving, the old version is kept as a local snapshot (label in the answer, revert with sac_story_diff + patch). dryRun only reports result and changed paths. Example: const w = h.widget("TE_TITLE_001"); w.registry.definition.text = "<p>Neu</p>"; return w.id; | **storyId**, **code**, dryRun |

## Charts & calculations

| Tool | What it does | Parameters |
|---|---|---|
| `sac_story_add_threshold` ✏️ | Add a story-defined threshold (conditional formatting) on a measure: ranges with name, semantic (ok/warning/critical, sets icon and color), inclusive 'low' and exclusive 'high' bounds (omit for open ends). Tables and charts showing the measure pick it up. Example: ok ≥ 100000000, warning 50000000–100000000, critical < 50000000. | **storyId**, **measure**, **ranges**, title, applyTo, datasetId |
| `sac_story_add_variance` ✏️ | Add a variance to a bar/column chart comparing measure A (usually the plotted one) with measure B: variance = A − B (absolute). | **storyId**, **widget**, **compare**, **to**, datasetId |
| `sac_story_add_year_comparison` ✏️ | Turn a bar/column chart into a year-over-year comparison: creates restricted measures "<label> <current>" and "<label> <previous>" (measure filtered on a year-month dimension whose keys start with the year, e.g. 2025xx), plots both instead of the original measure and adds the variance current − previous. Works for models without a SAC time dimension. | **storyId**, **widget**, **measure**, dimension, **current**, **previous**, label, datasetId |
| `sac_story_calculation` ✏️ | Create or replace a story calculation (Calculation Editor). Restricted measure: measure + restrictions [{dimension, members, exclude?}] on any number of dimensions (Version: "Actual"), constantSelection [dims] = ignore these dimensions of the chart/filter context (e.g. Version, so Actual and Target can sit in one chart). Calculated measure: formula with [#Calculation name] and [ModelMeasureId], numbers, + - * / ( ), e.g. "100 - [#Drinks actual] / [#Actual units] * 100". charts: add the result to these charts' measures. | **storyId**, **name**, measure, restrictions, constantSelection, formula, charts, model |
| `sac_story_chart` ✏️ | Change an existing chart declaratively; only the given parts change. type (barcolumn, stackedbar, line, area, donut, pie, treemap, metric; metric = Numeric Point), measures (model measure ids or calculation names), dimensions (main dimension feed of the type: categoryAxis / donut colour / treemap title), color and pattern (dimension, e.g. Version: Actual solid, Plan hatched; [] removes), feeds {feed: [...]} for anything else, legend true/false, hierarchy {Dim: {id, level}}, filters (members, e.g. Version ["Actual"] — restricted measures need exactly one version; or dynamic date: year/quarter/month/day with last/next). Keeps the chart query in line with the feeds (axes, dimension list, measure filter), which a plain JSON patch does not. | **storyId**, **chart**, type, measures, dimensions, color, pattern, feeds, legend, hierarchy, filters |
| `sac_story_chart_get` | Read a chart as a short description: type, measures, dimensions, colour/pattern dimension, other feeds, legend, plus the dimensions and calculations it could use. Same shape as sac_story_chart accepts ("chart B like A, but line" = get A, change, apply to B). | **storyId**, **chart** |
| `sac_story_format_widget` ✏️ | Format a chart or KPI widget: title, subtitle, number scale (Thousand/Million/Billion/Auto-Formatted) and decimal places. Tables: scale and decimals for all their measures. | **storyId**, **widget**, title, subtitle, scale, decimals, minimal |
| `sac_story_set_colors` ✏️ | Story-wide series colours for all charts of a model: fixed colour per member (members {Dim: {ID: "#hex"}}, with hierarchies {Dim: "H_KAT"} when the charts show a hierarchy — parents can get a colour too), colour/pattern per measure or calculation (measures {name: {color, pattern}}) and per version (versions {Plan: {color, pattern: "hatching8"}} = Actual solid, Plan hatched). Patterns: "" solid, hatching1…hatching8. Red/green series colours only after asking (confirmSignalColors). | **storyId**, members, hierarchies, measures, versions, model, confirmSignalColors |

## Themes & CSS

| Tool | What it does | Parameters |
|---|---|---|
| `sac_design_assets` | Themes, story templates and composites available in the tenant, ranked by the rule (names, then highest version in the name, then most recently changed). The first of each list is the recommendation. |  |
| `sac_story_apply_theme` ✏️ | Apply a theme profile (see sac_theme_capture) to a story. Available profiles are listed when the name is unknown. | **storyId**, **theme** |
| `sac_story_css` ✏️ | Read or change the story CSS (Edit CSS on story level). action get \| set (replace all) \| class (insert/replace one class: className + widget type panel/flowpanel/text/button or a raw inner selector + declarations). Assign the class to widgets with sac_story_style_widget. | **storyId**, **action**, css, className, widget, declarations, forceCss |
| `sac_story_set_theme` ✏️ | Assign a theme (repository object, by name or id) to a story. | **storyId**, **theme** |
| `sac_story_style_widget` ✏️ | Set CSS class, corner radius and/or background of a widget (Styling panel). cards: cssClass 'card', radius 12. | **storyId**, **widget**, cssClass, radius, background |
| `sac_theme_capture` | Save the theme of a story (which already has the wanted theme applied in the UI) as a reusable theme profile. | **storyId**, **name** |
| `sac_theme_create` ✏️ | Create a theme (repository object) derived from a base theme (name or id, see sac_design_assets → themes) with changes: palette, theme CSS, canvas background, panel radius, variance colours. | **baseTheme**, **name**, description, **folderId**, palette, css, cssMode, cssRemove, forceCss, canvasBackground, panelRadius, positiveColor, negativeColor, confirmSignalColors |
| `sac_theme_update` ✏️ | Change an existing theme in place (palette, CSS, canvas background, panel radius, variance colours). CSS is checked against the SAC rules and the size limit of the story copy (~76,000 chars) before saving. Stories keep their own copy of the theme: pass 'stories' (ids) to update those copies too — otherwise the new theme CSS does not show there. | **themeId**, palette, css, cssMode, cssRemove, forceCss, canvasBackground, panelRadius, positiveColor, negativeColor, confirmSignalColors, stories, dryRun |

## Scripting & checks

| Tool | What it does | Parameters |
|---|---|---|
| `sac_script_event_set` ✏️ | Set the event script of a page or widget by outline name, e.g. PAGE_1 onInitialization, a button's onClick, a chart's onSelect, an input control's onSelect. An empty body removes the script. | **storyId**, **target**, **event**, **body** |
| `sac_script_function_set` ✏️ | Create or update a function in a script object (created if missing; convention SO_<PURPOSE>, functions camelCase by purpose, e.g. SO_KPI.setKPIValues). Argument/return types: string, boolean, integer, number, void or widget types such as Panel, Chart, Table, Button (written as "+Panel" internally). | **storyId**, **scriptObject**, **name**, returnType, args, **body**, remove, enforceConvention |
| `sac_script_variable_set` ✏️ | Create or update a global script variable (convention gv_camelCase, e.g. gv_CountryArray). Types: string, boolean, integer, number or an SAC type. | **storyId**, **name**, type, isArray, defaultValue, description, remove, enforceConvention |
| `sac_scripts_get` | All scripting of a story: global variables, script objects with their functions (signature + code) and event scripts per page/widget. | **storyId** |
| `sac_story_check_runtime` | Debug a story: open it in the browser (view mode by default), wait until it has loaded and return script errors, console errors/warnings, uncaught page errors and the error notifications SAC displays. Use after changing scripts. | **storyId**, mode, timeoutMs, onlyErrors |
| `sac_story_inspect` | Layout check: open the story at one or more widths (e.g. [1280, 760, 420]; below ~616 px use mode "present", the SAC shell has a min width) and report per widget: scrollbars inside containers (content larger than the box), widgets sticking out of their parent, and runtime errors. widget = outline name → PNG of that widget (hover: with mouse over it). Read-only; use after layout/CSS changes instead of screenshots by eye. | **storyId**, widths, height, mode, widget, hover |

## Planning & models

| Tool | What it does | Parameters |
|---|---|---|
| `sac_dataaction_create` ✏️ | Create a data action (planning sequence) on an SAC planning model with advanced-formula steps, e.g. MEMBERSET [d/Measures] = ("Umsatz") / DATA() = RESULTLOOKUP([d/Version] = "public.Actual") * 1.1 The target version is chosen when the data action runs (do not put the version on the left side). Formulas are validated first; validateOnly returns only the validation. | **name**, description, **folderId**, **cubeId**, **steps**, validateOnly |
| `sac_dataaction_run` ✏️ | Run a data action on a target version (e.g. public.Plan). autoPublish=true writes into the public version; otherwise the result stays in the user's private edit of that version (like running it in a story without publishing). | **dataActionId**, **targetVersion**, autoPublish |
| `sac_model_data_reload` ✏️ | Reload the fact data of an SAC model with a derived column, e.g. after sac_model_dimension_add: export all facts (backup CSV in captures/backups), set column = map[from] (otherwise "#"), CleanAndReplace per version, then compare rows and totals per version. Empty dimension values become "#". dryRun: backup + distribution only, nothing changes. | **cubeId**, **column**, **from**, **map**, otherwise, dryRun |
| `sac_model_dimension_add` ✏️ | Add a generic dimension (own dimension table) to an existing SAC model, like + Dimension in the modeler. Existing data is booked on defaultMember ("#" unassigned) for the new dimension — reload it with the new column to split it. Optional members right away. Seamless models get the dimension table in their Datasphere space. | **cubeId**, **name**, description, members, defaultMember |
| `sac_model_hierarchy_set` ✏️ | Parent-child hierarchy on a dimension of an SAC model: creates the hierarchy if missing and sets the parents. nodes in display order: [{id, description?, parent?}] — parent omitted/"" = top node; parents that are new members are listed as nodes too (e.g. categories COOKIES/DRINKS, then the products under them). Other member columns are kept. | **cubeId**, **dimension**, **hierarchy**, description, **nodes**, makeDefault |
| `sac_model_members_set` ✏️ | Add or update members (ID + description, optional further properties) of a dimension of an SAC model. | **cubeId**, **dimension**, **members** |
| `sac_model_metadata` | Live metadata of a model as SAC sees it: dimensions (technical name, caption, key/text attribute) and measures. Datasphere analytic models through the live connection (space/connection may be omitted: found via the Datasphere search) and SAC planning models, native or Seamless (model name or C… id, no connection/space). | connection, space, **model** |
| `sac_multi_action_execute` ✏️ | Execute a multi action. ID format: <packageId>:<objectId>. Body requires parameterValues array (empty if none). | **multiActionId**, parameterValues |
| `sac_multi_action_get_status` | Get execution status of a multi action. | **multiActionId**, **executionId** |
| `sac_multiaction_create` ✏️ | Create a multi action whose steps run data actions one after another, each on a fixed target version (e.g. copy Actual→Plan, then Plan +5 %). SAC validates the steps first; validateOnly=true only checks. Run it afterwards with sac_multi_action_execute (id is returned; public API access is on by default). | **name**, description, folderId, **steps**, publicApi, validateOnly |
| `sac_plan_publish` ✏️ | Publish the unpublished planning changes of a version (what "Publish Data" does) — makes them visible to everyone. Only after the user explicitly agreed to publish. | **model**, **version** |
| `sac_plan_read` | Read the current value of a (possibly aggregated) planning cell — e.g. Quantity_Sold for California, Carbonated Drinks, F01.2025, Q1 2025. | **model**, **version**, **measure**, **members**, period |
| `sac_plan_revert` ✏️ | Discard all unpublished planning changes of a version (what "Revert Data" does). | **model**, **version** |
| `sac_plan_write` ✏️ | Plan a value without opening a story: set an (aggregated) cell to a value, change it by a percentage or by a delta. SAC distributes it to the detail level like a table entry (proportionally to existing values, e.g. a quarter to its months and a category to its products). Public versions are put into edit mode; the change stays UNPUBLISHED (visible to the user only) until it is published in SAC. Use dryRun to preview before/after first. Examples: value 5000000 for Q1 2025 / California / Carbonated Drinks; percent 10 on all quantities of Nevada in 2025. | **model**, **version**, **measure**, **members**, period, value, percent, delta, dryRun |
| `sac_planning_forecast_story_create` ✏️ | Planning story with forecast layouts on a Seamless planning model (actuals to date, plan to year end, next year's quarters), in one call: header (title), filter bar with the plan version (CIC_PLANVERSION — Actual stays fixed), card 1 "Forecast <year>": Actual up to today, plan version up to year end, by month, with the year's sum; card 2 "Planung <year+1>": only "<year> (Ist + Plan)" and the quarters of next year to plan. Months of next year are planned in-year later. Rows: one dimension; one measure. | **name**, description, folderId, **title**, **model**, **rowDimension**, **measure** |
| `sac_planning_model_create` ✏️ | Create a new SAC planning model (stored in SAC) in a folder: the given measures and generic dimensions plus Date (month granularity) and Version (Actual, optionally Plan). Technical names: letters, digits, underscore. Members of the generic dimensions can be added with sac_model_members_set; data with the sac_import_* tools. | **name**, description, **folderId**, **measures**, dimensions, planVersion, datasphereSpace, fromYear, toYear |
| `sac_planning_story_create` ✏️ | Create a planning story on an SAC planning model: canvas schablone (header + card) with an input-ready table (one dimension in the rows, two measures). Without template the tool returns the available templates (ask the user). | **name**, description, **folderId**, **cubeId**, **title**, **rowDimension**, rowCaption, **measures**, tableTitle, template, headerInverted, headerComposite |
| `sac_public_dimension_create` ✏️ | Create a public (shared) generic dimension in a folder, optionally with members. Reusable across SAC models. | **name**, description, **folderId**, members |
| `sac_public_dimension_members_set` ✏️ | Add or update members of a public dimension (resource id D…). | **resourceId**, **members** |

## Data Analyzer & live models

| Tool | What it does | Parameters |
|---|---|---|
| `sac_datasphere_search` | Search Datasphere objects through the SAC live connection (no Datasphere login): model name or words → technical name, business name, space, kind, connection. Use it to find the space of a model before sac_model_metadata or sac_story_generate_dashboard. Without connection all known Datasphere connections are searched. | **query**, connection, kind, top |
| `sac_insight_create` ✏️ | Create a Data Analyzer insight (saved analysis): a table with the given dimensions on the rows (and optionally columns) and the model's measures. Model: either an SAC model (cubeId, e.g. from sac_models_list / sac_files_list) or a Datasphere model (connection/space/model), referenced directly (no live model needed). Dimensions accept captions or technical names for Datasphere models; SAC models take their dimension ids. Opening Datasphere-based insights needs a Datasphere login in the browser once. | **name**, description, folderId, cubeId, connection, space, model, **rows**, columns, measures, chart, filters |
| `sac_insight_list` | List Data Analyzer insights visible to the user (name, id, folder, last change). |  |
| `sac_insight_update` ✏️ | Change an existing insight: rows, columns, measures, filters and display (table or chart type). Pass the full layout. | **insightId**, **rows**, columns, measures, chart, filters |
| `sac_live_model_create` ✏️ | Create an SAC live model on a Datasphere analytic model (like New Model → Datasphere) in a folder. Needed for the Data Analyzer on Datasphere data; stories bind models themselves. | **name**, **folderId**, connection, space, **model**, description |
| `sac_models_list` | Models available for new stories: Datasphere models already used in the tenant (with connection and space — usable by sac_story_generate_dashboard) and SAC models; SAC planning (native or Seamless, kind sac/seamless) and analytic models work with the generator, responsive and canvas. Ask the user which one to use whenever a request does not name a model. |  |

## Files & content

| Tool | What it does | Parameters |
|---|---|---|
| `sac_filerepository_list` | List story types, enumerate content types, and filter file repository resources via GET /api/v1/filerepository/Resources. Use to list all story types (standard story, story template, analytic application), enumerate design experiences (Classic vs Optimized), or filter stories/apps by user, date, or type. OData $filter, $top, $orderby, $select, $count all work. IMPORTANT — visibility scope: By default (applyManagePrivilege=false), only content the service account has Read access to is returned (typically a small subset of tenant content). Set applyManagePrivilege=true to get ALL tenant content (all users' private folders, public folders, workspaces) — requires the service account to have the "Manage" permission for Private Files and Public Files. Always use applyManagePrivilege=true when the user wants to search/list across the whole tenant. Response fields: resourceId, objectId, name, description, resourceType, resourceSubtype, createdTime, createdBy, modifiedTime, modifiedBy, folderType, workspaceId, workspaceName, openURL, isMobile, isFeatured. Filterable fields: resourceType (values: STORY, APPLICATION, DATAACTION, PLANNINGSEQUENCE, MULTIACCOUNT, DIMENSION, ANALYTIC_MODEL), createdBy (exact username/ID), modifiedBy, createdTime, modifiedTime, name, folderType (PUBLIC, PRIVATE, SYSTEM, INPUT_SCHEDULE). STORY TYPES — resourceSubtype and objectId encoding: resourceSubtype="" (empty) → standard story (covers both Classic and Optimized design experience) resourceSubtype="TEMPLATE" → story template resourceSubtype="APPLICATION" → Analytic Application (scripted, code-based) Design experience is NOT in resourceSubtype — it is encoded in the objectId prefix: objectId prefix "t.D:" → Classic design experience (legacy) objectId prefix "t.B:" → Optimized design experience (recommended, newer) To list story types: $select=name,resourceSubtype,objectId and $orderby=resourceSubtype asc — groups stories by subtype and lets you read the objectId prefix for design experience. Filter examples: $filter=resourceType eq 'STORY' — all stories $filter=resourceType eq 'STORY' and createdBy eq 'USERNAME' — stories by a specific user $filter=resourceType eq 'STORY' and modifiedBy eq 'USERNAME' — stories last modified by user $filter=resourceType eq 'STORY' and createdTime gt 2024-01-01T00:00:00Z — recently created WORKSPACE / TEAM FILES: To list all workspaces (team files spaces), filter by folderType eq 'INPUT_SCHEDULE' and workspaceId ne null. This returns exactly one entry per workspace with its workspaceId and workspaceName. Example: $filter=folderType eq 'INPUT_SCHEDULE' and workspaceId ne null with $select=workspaceId,workspaceName and $orderby=workspaceName asc. | applyManagePrivilege, top, skip, filter, orderby, select, count |
| `sac_files_list` | List a folder in the SAC file repository (internal Files API): sub-folders, stories, models, etc. with resource ids. | **folderId**, limit, offset |
| `sac_folder_create` ✏️ | Create a folder (e.g. below My Files / SANDBOX). Returns its resourceId. | **parentId**, **name**, description |
| `sac_metadata_get` | Get OData metadata document for the SAC REST API. |  |
| `sac_repositories_list` | List repositories. Supports OData query params. | top, skip, filter, orderby, select, expand, inlinecount, format |
| `sac_resource_delete` ✏️ | Move stories, insights, models, themes or folders to Deleted Files (recoverable there, like Delete in Files). Only delete objects the user asked for. | **resourceIds** |
| `sac_resource_move` ✏️ | Move stories, insights, models or folders into another folder. | **resourceIds**, **targetFolderId** |
| `sac_resource_rename` ✏️ | Rename a story, insight, model or folder (name and optional description). | **resourceId**, **name**, description |
| `sac_resources_get` | Get a single resource by ID. | **resourceId** |
| `sac_resources_list` | List resources via GET /api/v1/Resources (OData v2, returns XML/Atom format — not recommended for filtering). Use sac_filerepository_list for JSON responses with working OData $filter support. | top, skip, filter, orderby, select, expand, inlinecount, format |
| `sac_widget_get_data` | Get widget data from a story. | **storyId**, **widgetId**, type |

## Data import & export (public API)

| Tool | What it does | Parameters |
|---|---|---|
| `sac_export_admin_metadata` | Get OData metadata for admin service. | format |
| `sac_export_create_subscription` ✏️ | Create data export subscription for delta tracking. | **NamespaceID**, **ProviderID**, **EntitySetName**, ExternalID, Filter, Selection, Description |
| `sac_export_delete_subscription` ✏️ | Delete data export subscription(s). | **namespaceId**, **providerId**, subscriptionId, deleteChain, deleteEntitySetName |
| `sac_export_get_audit_data` | Get audit data (change history). Requires Data Audit enabled on model. | **namespace**, **provider**, top, skip, filter, select, orderby, count, format |
| `sac_export_get_conversion_rates` | Get unit conversion rates. Namespace: sac_unit_conversion. | namespace, **provider**, top, skip, filter, select, format |
| `sac_export_get_currency_table` | Get currency conversion rates. Namespace: sac_currency_tables. | namespace, **provider**, top, skip, filter, select, format |
| `sac_export_get_data` | Generic: get data from any provider entity set. For Distinct queries use '{col}___Distinct'. | **namespace**, **provider**, **entitySet**, top, skip, filter, select, orderby, count, format, pagesize, delimiter, deltaid, externalid, trackChanges |
| `sac_export_get_dimension_master` | Get master data for a single dimension ({DimensionName}Master entity set). | **namespace**, **provider**, **dimension**, top, skip, filter, select, orderby, format |
| `sac_export_get_dimension_master_hierarchy` | Get master data with parent-child hierarchy for a dimension. | **namespace**, **provider**, **dimension**, top, skip, filter, select, orderby, format |
| `sac_export_get_fact_data` | Get fact data. Supports OData params, delta tracking (trackChanges/deltaid/externalid), CSV export. | **namespace**, **provider**, top, skip, filter, select, orderby, count, format, delimiter, pagesize, deltaid, externalid, trackChanges |
| `sac_export_get_fact_data_aggregation` | Get aggregated fact data grouped by dimensions and measures. PREREQUISITE: call sac_import_get_model_metadata first to discover valid dimension and measure names for $select. Use $select for dims/measures. 'provider' is the model ID — resolve name→ID via sac_filerepository_list ($filter=name eq 'MODEL_NAME' and resourceType eq 'ANALYTIC_MODEL'). Namespace for analytic models is 'sac'. | **namespace**, **provider**, **select**, filter, top, skip, orderby, count, format, deltaid, trackChanges |
| `sac_export_get_fact_data_difference` | Get measure value differences over subscription period. Requires trackChanges or deltaid. | **namespace**, **provider**, filter, select, top, skip, format, deltaid, trackChanges |
| `sac_export_get_master_data` | Get master data and level-based hierarchies for all dimensions. | **namespace**, **provider**, top, skip, filter, select, orderby, count, format |
| `sac_export_get_namespace` | Get namespace details. | **namespaceId** |
| `sac_export_get_provider_entities` | List available entity sets for a provider. | **namespace**, **provider** |
| `sac_export_get_provider_metadata` | Get OData metadata (EDMX) for a provider. | **namespace**, **provider**, format |
| `sac_export_get_public_dimension_data` | Get public dimension master data. Namespace: sac_public_dimensions. | **provider**, top, skip, filter, select, orderby, format |
| `sac_export_get_subscription` | Get subscription by composite key. | **namespaceId**, **providerId**, **subscriptionId** |
| `sac_export_list_namespaces` | List data export namespaces (sac, sac_currency_tables, sac_public_dimensions, sac_unit_conversion). |  |
| `sac_export_list_provider_subscriptions` | List subscriptions for a provider. | **namespaceId**, **providerId** |
| `sac_export_list_providers` | List data providers (models) in a namespace. | **namespaceId** |
| `sac_export_list_subscriptions` | List all data export subscriptions. |  |
| `sac_import_create_currency_conversion_job` ✏️ | Create import job for a currency conversion table. | **currencyConversionId**, importType, Mapping, JobSettings |
| `sac_import_create_job` ✏️ | Create import job for a model. Returns JobID/JobURL. | **modelId**, importType, Mapping, JobSettings |
| `sac_import_create_public_dimension_job` ✏️ | Create import job for a public dimension. | **publicDimensionId**, Mapping |
| `sac_import_create_unit_conversion_job` ✏️ | Create import job for a unit conversion table. | **unitConversionId**, importType, Mapping, DefaultValues, JobSettings |
| `sac_import_delete_job` ✏️ | Delete an import job. | **jobId** |
| `sac_import_get_currency_conversion` | Get currency conversion import types and settings. | **currencyConversionId** |
| `sac_import_get_currency_conversion_metadata` | Get currency conversion metadata: columns, types, keys. | **currencyConversionId** |
| `sac_import_get_invalid_rows` | Get rejected rows with rejection reasons. | **jobId** |
| `sac_import_get_job_status` | Get job status: READY_FOR_DATA, READY_FOR_WRITE, PROCESSING, COMPLETED, FAILED. | **jobId** |
| `sac_import_get_model` | Get model import types, versions, settings, and metadata URL. | **modelId** |
| `sac_import_get_model_metadata` | Get model dimension names, measure names and field types. Call this BEFORE sac_export_get_fact_data_aggregation to discover valid $select fields (e.g. PD_O_BusinessUnit, SignedData). Required whenever field names are unknown. Use when: aggregating fact data, exporting by dimension, querying model structure. | **modelId** |
| `sac_import_get_public_dimension` | Get public dimension import types and metadata URL. | **publicDimensionId** |
| `sac_import_get_public_dimension_metadata` | Get public dimension metadata: columns, types, keys. | **publicDimensionId** |
| `sac_import_get_unit_conversion` | Get unit conversion import types and settings. | **unitConversionId** |
| `sac_import_get_unit_conversion_metadata` | Get unit conversion metadata: columns, types, keys. | **unitConversionId** |
| `sac_import_list_currency_conversions` | List currency conversion tables for import. | top |
| `sac_import_list_jobs` | List all import jobs. | top |
| `sac_import_list_models` | List models available for data import. Does NOT support name filtering — returns all models. To find a model ID by name, use sac_filerepository_list with $filter=name eq 'MODEL_NAME' and resourceType eq 'ANALYTIC_MODEL' — the returned resourceId is the model ID. | top |
| `sac_import_list_public_dimensions` | List public dimensions available for import. | top |
| `sac_import_list_unit_conversions` | List unit conversion tables for import. | top |
| `sac_import_oneclick` ✏️ | One-click: create job, upload, validate, run in one request. | **modelId**, importType, **Data**, Mapping, DefaultValues, JobSettings |
| `sac_import_run_job` ✏️ | Execute validated import job. | **jobId**, overrideExecuteWithFailedRows |
| `sac_import_upload_data` ✏️ | Upload data to an import job. Returns upserted/failed row counts. | **jobId**, **Data**, DeletedData, Mapping, DefaultValues |
| `sac_import_validate_job` | Validate import job before running. | **jobId** |

## Users, teams & administration (public API)

| Tool | What it does | Parameters |
|---|---|---|
| `sac_audit_export` | Export audit activity logs with OData query params. | top, skip, filter, orderby, select |
| `sac_calendar_copy_event` ✏️ | Copy/create a calendar event. | **body** |
| `sac_calendar_get_event` | Get a calendar event by ID. | **eventId** |
| `sac_calendar_update_event` ✏️ | Update a calendar event (partial). | **eventId**, **body** |
| `sac_monitoring_get` | Get monitoring data for a model. | **modelId** |
| `sac_schedule_create` ✏️ | Create a publication schedule. | **body** |
| `sac_schedule_delete` ✏️ | Delete a publication schedule. | **scheduleId**, body |
| `sac_schedule_get_template` | Get schedule creation template with defaults. |  |
| `sac_schedule_update` ✏️ | Update a publication schedule (partial). | **scheduleId**, **body** |
| `sac_teams_create` ✏️ | Create a team/group (SCIM v2). | **body**, createTeamFolder |
| `sac_teams_list` | List user security groups via SCIM v2 (/api/v1/scim2/Groups). Returns groups used for role assignments and access control (e.g. T_SALES, T_HR). These are identity/authorization groups, not file storage folders. | filter, startIndex, count |
| `sac_teams_patch` ✏️ | Partial update of a team/group (SCIM v2 PATCH). | **groupId**, **body** |
| `sac_translation_download_xliff` | Download XLIFF translation file for an artifact. | **artifactId** |
| `sac_translation_download_xliff_bulk` | Download XLIFF files for multiple artifacts. | **body** |
| `sac_translation_get_artifact` | Get metadata for a translatable artifact. | **artifactId** |
| `sac_translation_list_artifacts` | List translatable artifacts. | top, skip, filter |
| `sac_transport_create_export_job` ✏️ | Create a content transport export job. | **body** |
| `sac_transport_create_import_job` ✏️ | Create a content transport import job. | **body** |
| `sac_transport_delete_content` ✏️ | Delete a content item. | **itemId** |
| `sac_transport_get_content_item` | Get content item details within a wave. | **itemId**, **waveItemId** |
| `sac_transport_get_job_status` | Get content transport job status. | **jobId** |
| `sac_transport_get_permissions` | Get permissions for a content item. | **itemId** |
| `sac_transport_move_item` ✏️ | Move a content item to a target location. | **itemId**, **targetId**, body |
| `sac_users_bulk` ✏️ | Bulk SCIM operations (create/update/delete multiple users/groups). | **body** |
| `sac_users_create` ✏️ | Create a user (SCIM v2). | **body** |
| `sac_users_delete` ✏️ | Delete a user. | **userId** |
| `sac_users_get` | Get a user by UUID. | **userId** |
| `sac_users_list` | List users (SCIM v2). | filter, startIndex, count |
| `sac_users_patch` ✏️ | Partial update of a user (SCIM v2 PATCH). | **userId**, **body** |
| `sac_users_update` ✏️ | Full replace of a user (SCIM v2 PUT). | **userId**, **body** |

## Browser session, recording & raw requests

| Tool | What it does | Parameters |
|---|---|---|
| `ping` | Returns pong — useful for verifying connectivity |  |
| `sac_api_request` ✏️ 🔧 | Send an arbitrary HTTP request to the SAC tenant — documented or undocumented endpoints. via="oauth": Bearer token of the OAuth client (works for /api/v1/...). via="browser": executed inside the logged-in SAC page (works for internal /sap/fpa/services/..., /sap/bc/ina/..., and /api/v1/... with user rights). CSRF tokens and cookies are handled automatically. Non-GET requests require allowalteration=true. | **method**, **path**, query, body, contentType, headers, via, maxChars, allHeaders |
| `sac_browser_close` | Close the browser session (profile/login is kept on disk). |  |
| `sac_browser_eval` ✏️ 🔧 | Evaluate JavaScript inside the logged-in SAC page (async allowed, use 'return' for multi-statement code). Gives access to the UI5/FPA runtime (window.sap, sap.ui.getCore(), …) for exploring internals. Requires allowalteration=true because arbitrary code can change data. | **code**, maxChars |
| `sac_browser_login` | Open a Chrome window (persistent profile) on the SAC tenant undefined and wait until the user has completed SSO login. Required once before any via="browser" call, contentlib, capture/replay or eval. The profile is reused, so later starts usually skip the login. | timeoutSeconds, headless |
| `sac_browser_screenshot` | Screenshot of the active SAC tab (coordinates in the image = CSS pixels for sac_browser_ui clicks). | fullPage |
| `sac_browser_status` | State of the browser session (login, tenant id, CSRF, capture). |  |
| `sac_browser_ui` ✏️ | Drive the SAC UI in the browser session for things that have no API (e.g. building a story, adding widgets). Target by visible text, CSS selector, or x/y from sac_browser_screenshot. Combine with sac_capture_* to record what the UI sends, then turn it into an API call via sac_replay/sac_contentlib. Actions may change data, so allowalteration=true is required. | **steps**, screenshot |
| `sac_capture_get` | Full details (URL, headers, request payload, response) of one captured call. | **index**, name, maxChars |
| `sac_capture_list` | List captured calls (current recording, or a saved capture by name). | name, onlyMutating, pathFilter |
| `sac_capture_save` | Save captured calls to <capture folder>/<name>.json (captures/ in the repo, ~/.sac-mcp/captures when installed from npm) so they can be replayed in later sessions. | **name**, indices, description |
| `sac_capture_saved` | List saved captures. |  |
| `sac_capture_start` | Start recording the SAC UI's XHR/fetch traffic in the browser session. Then perform the action in the SAC window (e.g. save a story, enter planning data, publish a version, create a folder) and call sac_capture_stop. Default filter: /sap/fpa/services, /api/v1, /sap/bc/ina. | urlFilter, clear |
| `sac_capture_stop` | Stop recording and return a summary of the captured calls. | onlyMutating |
| `sac_contentlib` ✏️ | Call SAC's internal content library service (POST /sap/fpa/services/rest/epm/contentlib?tenant=<id>) via the browser session. This is what the Files area of the SAC UI uses: browse folders, read/write resource metadata and content, copy, move, share, delete. Body is {action, data}. Payload shapes are undocumented — use sac_capture_* while doing the action in the UI to learn the exact shape, then call it here. Actions starting with get/find/search/list/check/read/load are treated as read-only; all others require allowalteration=true. | **action**, data, extra, maxChars |
| `sac_replay` ✏️ 🔧 | Replay a captured call through the browser session, optionally modified. Use this to repeat any UI action (e.g. enter a different planning value, rename a different resource) after recording it once. Modifications: 'replacements' (string or regex substitutions applied to URL and payload) and/or 'body' (full payload override). Session-bound headers (cookies, CSRF) are refreshed automatically. | **index**, name, replacements, body, maxChars |
| `smart_query` | Execute a SQL-like query against SAC. Auto-selects OData vs Widget Query based on query type. | **query**, space_id, model_id |
