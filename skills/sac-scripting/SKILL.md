---
name: sac-scripting
description: Write, review and debug SAP Analytics Cloud (SAC) scripts for Optimized Story Experience stories and Analytics Designer applications — event scripts (onInitialization, onClick, onSelect, onResultChanged …), script object functions and global script variables. Works against the official SAC scripting API reference, built locally from SAP's API Reference Guides (see section 9). Use whenever SAC script code is written or explained, an SAC API method/signature is looked up, or scripts are set via the sac-workbench-mcp tools (sac_scripts_get, sac_script_event_set, sac_script_function_set, sac_script_variable_set, sac_story_check_runtime). Triggers on: SAC script, Analytics Designer, Optimized Story, setDimensionFilter, getDataSource, Planning API, Data Action script, Popup, script object, SO_*, gv_*.
---

# SAC Scripting

SAC scripts are a **statically typed JavaScript subset**. The script editor type-checks every call at design time, so a method that does not exist in the API reference, a wrong argument type or a missing cast is an error — not a runtime surprise. **Never guess an API. Look it up.**

## 1. Which reference?

| Target | Reference folder | Version |
|---|---|---|
| Optimized Story Experience (OSE) – all new stories, everything the sac-workbench-mcp story tools create | `references/ose/` | 2026.15 |
| Classic Analytics Designer application (`.../app.html#/analyticapp`) | `references/analytics-designer/` | 2026.8 |

Default to **OSE**. The two APIs share ~256 classes; OSE adds e.g. `ApplicationPage`, `StoryPopup`, `FilterPanel`, `Variance`, `PlanningModelVersion`; only AD has `DataExplorer`, `SmartDiscovery`, `Clock`.

## 2. How to look things up (cheap → detailed)

All paths relative to this skill's directory.

1. **One-line signatures** – `references/<ref>/SIGNATURES.txt` (~1,600 lines, one per member: `Class.member(params): return — short desc [kind]`). Grep it, never read it whole:
   - `grep -i 'filter' references/ose/SIGNATURES.txt`
   - `grep '^DataSource\.' references/ose/SIGNATURES.txt`
   - `grep '\[event' references/ose/SIGNATURES.txt` → all events per widget type
2. **Class detail** – OSE: `references/ose/<ClassName>.md`; Analytics Designer: section `# <ClassName>` in `references/analytics-designer/CLASSES.md` (`grep -n '^# DataSource$'`, then read from there): full descriptions, notes/restrictions, parameters, return types, `since` version, deprecations. Read this before using a method whose behaviour isn't obvious (filters, variables, planning, data actions, result sets).
3. **Class overview** – `references/<ref>/INDEX.md`: all classes with kind, superclass, type library.

Inheritance matters: `Table`/`Chart` extend `Widget`; check the superclass file (`extends [...]` in the header) when a method seems missing.

Signature notation: `name?` = optional, `[JSON]` = a JSON object literal may be passed, `static` = call on the class (`ArrayUtils.create(...)`), `<type of type>` = return type depends on the `Type` argument.

## 3. Language rules that bite

- Declare with `var`. Types are inferred from the initializer and fixed afterwards.
- **No conditional operator `a ? b : c`** — the validator rejects it ("You can't use "?" operator", verified). Use `if/else`.
- Empty arrays need a type: `var ids = ArrayUtils.create(Type.string);` then `ids.push("x");`.
- No implicit type coercion: compare same types only, convert explicitly with `ConvertUtils.stringToNumber / stringToInteger / numberToString`.
- Generic widgets (e.g. from `Application.getWidgets(...)`) must be cast before using type-specific methods: `var t = cast(Type.Table, w);` — check `cast.md`.
- No browser APIs (no `window`, `document`, `fetch`, `setTimeout`). Delays/polling → **Timer** widget (`Timer.start`, `onTimeout`). Embedding communication → `onPostMessageReceived` / `Application.postMessage`.
- Reusable logic goes into **script object functions**, not into event scripts. Event scripts should mostly call `SO_X.doSomething()`.
- Member/dimension IDs are technical IDs, not descriptions. Hierarchical/BW members often look like `[DIM].[H1].&[MEMBER]`. Don't guess them — read them from the model (`sac_model_metadata`, `sac_export_get_dimension_master`), from `getSelections()`, `getMembers()` or `console.log`.
- Selections are plain objects: `{"Region": "EMEA", "@MeasureDimension": "Revenue"}`. Use `Alias.MeasureDimension` instead of hard-coding the measure dimension key.
- `getMembers`, `getResultSet`, `getData` hit the backend. Never call them inside loops; cache results in global variables.
- Formatting: `NumberFormat.format(n)` (user settings) or `NumberFormat.create()` + `setGroupingSeparator/setDecimalSeparator/setMaximumDecimalPlaces` for a fixed format; `DateFormat.format(date, "EEEE, MMMM d, yyyy")` (LDML pattern, names in the user's profile language). No hand-written formatting helpers or name arrays. JS `new Date(y, m, d)`: month is 0-based.

## 4. Performance defaults

- Keep `onInitialization` light; load what is visible first.
- Batch filter changes: `ds.setRefreshPaused(true)` → set all filters/variables → `ds.setRefreshPaused(false)` (or `PauseMode`). OSE also has `ApplicationPage.setRefreshPaused(dataSources, paused)`.
- Pass arrays to `setDimensionFilter` instead of setting filters member by member.
- Use `Application.showBusyIndicator()` / `hideBusyIndicator()` around long blocking operations (data actions, planning publish).
- Prefer `DataAction.executeInBackground` + `onExecutionStatusUpdate` for long-running data actions.

## 5. Pitfalls (seen in practice)

| Pitfall | What happens / what to do | Status |
|---|---|---|
| Dimension gets a hierarchy | It becomes the default view; `setDimensionFilter` on leaf members returns "No data". Call `ds.setHierarchy(dim, Alias.FlatHierarchy)` first. | verified |
| `setDimensionFilter` semantics | Replaces the widget's existing filter on **that** dimension (except advanced filters, per reference). Filters on other dimensions, story/page filters and input controls still apply on top. Script filters exist only at runtime — the builder doesn't show them, so a chart can look unfiltered in edit mode. | reference + verified |
| `setCssClass` during load | Every call in `onInitialization` (even with the same class) logs "The story was marked as dirty during load…" as console error. Filters, `applyText`, `setVisible`, layout changes don't. Guard: `if (w.getCssClass() !== c) { w.setCssClass(c); }`, or set the initial class in the builder. | verified |
| `applyText` | Replaces the text set in the builder on every load (first text style only). Keep fixed headings in the widget; script only the dynamic part (scope, date) — otherwise edits in the builder seem to have no effect. | reference + verified |
| `sortByMember` on time attributes (`Date.DAY`) | Sorts as text (1, 10, 11 … 2). No script fix → model a separate dimension (ID 01–31, description 1–31). | reported |
| `rankBy`, `sortByValue`, `sortByMember` | Only in optimized view mode; `rankBy` not on charts with structures. Structure member from `chart.getMembers(Feed.ValueAxis)`. | reference |
| Result-set IDs | `rs[i]["Version"].id` / dimension `.id` carry prefixes (`public.Plan`, `[Store].[…]`) → compare with `indexOf`, not `===`. | verified |
| Unassigned member | `getMembers` can return `#` (unassigned) first — skip it before filtering. | seen |
| Restricted measures + version | Charts with only restricted measures still need exactly one version filter; values of other versions via constant selection in the measure. Relevant when filtering Version by script. | reported |
| `Application.getInnerWidth()` | Width of the **first** page (canvas width if fixed, viewport if dynamic). | reference |

## 6. Naming conventions (used by sac-workbench-mcp)

- Script objects: `SO_<PURPOSE>` (e.g. `SO_FILTER`, `SO_KPI`); functions camelCase by purpose (`SO_KPI.setKPIValues`).
- Global variables: `gv_camelCase` (e.g. `gv_selectedYear`, `gv_CountryArray`).
- Widgets: meaningful names before scripting (see `sac_story_rename_widgets`), never `Table_1`.
- Comment the *why* in script code; keep functions small.
- For existing stories that don't follow the convention, pass `enforceConvention: false` rather than renaming.
- **State + re-apply:** keep UI state in global variables (`gv_period`, `gv_store`) and write the functions that apply it (`showPeriod`, `showTreeLevel`, `select`) idempotent, so other functions can simply call them again after a change (see patterns).

## 7. Workflow with sac-workbench-mcp

Without the MCP server (e.g. claude.ai in the browser): same rules, but deliver the finished code per target (variables, script objects with signature, event scripts by widget/event) for the user to paste into the SAC script editor, and tell them to check it in view mode.

With sac-workbench-mcp (Claude Desktop / Claude Code):

1. **Read** the current state: `sac_scripts_get(storyId)` (global variables, script objects, event scripts) and `sac_story_get` for widget outline names and types. Script against the real widget names and the real model IDs.
2. **Look up** every API you plan to use (section 2). If a method's `since` is newer than the tenant version, don't use it.
3. **Write** bottom-up: variables → script object functions → event scripts.
   - `sac_script_variable_set` (name, type, isArray, defaultValue)
   - `sac_script_function_set` — exact parameters (most frequent mistake): `storyId`, `scriptObject`, `name`, `body`, `args` = `[{name, type, isArray?, optional?}]`, `returnType`, `allowalteration: true`, optional `enforceConvention`, `remove`. Widget types as plain names (`Panel`, `Text`, `Chart`); `sac_scripts_get` shows them as `+Panel`.
   - `sac_script_event_set` (target = outline name of page/widget, event, body; empty body removes)
   These change the story, so they need `allowalteration: true` — confirm with the user before modifying production stories.
4. **Verify**: `sac_story_check_runtime(storyId)` opens the story and returns script errors, console errors and SAC error messages. Fix and repeat until clean. For a closer look at runtime behaviour, add temporary `console.log(...)` lines and remove them afterwards.
5. Summarize for the user what was changed (which events/functions/variables) — the API diff is not visible to them in the story editor.

After writing scripts or CSS via the API, a story that is already open in the browser keeps the old version: navigate away, reload (F5) and reopen before checking visually.

For styling (story CSS, `setCssClass`) use the **sac-css** skill.

Debugging outside the MCP server: add `debugger;` in the script and open the story with URL parameter `debug=true` with browser dev tools open.

## 8. Patterns

See `references/patterns.md` for verified snippets: filtering, reading values, variables, planning (versions, setUserInput, publish), data actions / multi actions, popups, navigation, dynamic widget visibility, URL parameters, and dashboard patterns (flat hierarchy, hierarchy levels, segment switch, clickable tiles, progress bars, KPI from a hidden chart, fixed reference date, responsive header, top N, formatting). Every snippet's methods exist in the OSE reference — but still check the class file for restrictions before adapting.

## 9. Building the reference (once, then each quarter)

The API reference is SAP documentation and is **not shipped** with this repository. Build it locally from SAP's
public API Reference Guides (needs Python 3 with `beautifulsoup4`):

```bash
# from the repository root
pip install beautifulsoup4
curl -sL https://help.sap.com/doc/1639cb9ccaa54b2592224df577abe822/release/en-US/index.html -o ose.html
python3 skills/tools/build_reference.py ose.html skills/sac-scripting/references/ose
curl -sL https://help.sap.com/doc/958d4c11261f42e992e8d01a4c0dde25/release/en-US/index.html -o ad.html
python3 skills/tools/build_reference.py ad.html skills/sac-scripting/references/analytics-designer
python3 skills/tools/merge_ad_reference.py skills/sac-scripting/references/analytics-designer
```

The generated `references/ose/` and `references/analytics-designer/` folders are git-ignored. If they are missing,
say so and build them (or ask the user to) before writing scripts — never guess an API from memory.
