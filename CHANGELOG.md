# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Published on npm (`npm install -g sac-workbench-mcp`); README describes the npm setup.
- `package.json`: `bin` path without `./`, which npm 11 dropped on publish.

## [0.3.0] — 2026-11-05 — first public release

### Added

- **Stories in one call** — `sac_story_generate_dashboard` builds a complete dashboard (header, filter bar, KPI row,
  charts, optional table) on a Datasphere model, canvas or responsive, with theme and story template; scale and decimals per
  KPI and chart, percentage measures unscaled, readable filter labels.
- **Dashboards on SAC models** — the generator also builds dashboards (responsive, or canvas with a story
  template such as the Horizon template) on SAC planning models (native and Seamless) and analytic models (Version Actual on every widget, per-tile KPI filters such as Plan or the current year, story filter and filter bar, table scaled like the KPIs); `sac_model_metadata`
  and `sac_models_list` know these models.
- **Charts, declaratively** — `sac_story_chart` / `sac_story_chart_get`: type, measures, dimensions, colour and pattern
  dimension, legend, hierarchy and level, member filters and dynamic date ranges; the chart query is kept consistent.
- **Calculations and colours** — `sac_story_calculation` (restricted measures on several dimensions with Constant
  Selection, calculated measures with formulas), `sac_story_set_colors` (per member, measure and version).
- **KPI tiles** as Numeric Point charts (`sac_story_add_kpi`) and **duplicating** widgets or whole cards with their own
  texts (`sac_story_duplicate`).
- **Layout and checks** — `sac_story_set_layout`, `sac_story_set_position`, `sac_story_set_text`;
  `sac_story_check_runtime` (script and console errors) and `sac_story_inspect` (scrollbars, overhang and errors per
  widget at several widths, widget screenshot).
- **Story internals** — `sac_story_transform` (patch by function in an isolated context, automatic snapshot), `sac_story_restore`,
  snapshots and structural diffs.
- **Themes and CSS** — `sac_theme_create` / `sac_theme_update` with CSS validation against the SAC editor rules,
  rule-wise CSS updates and syncing of the stories' theme copies; story CSS and widget classes.
- **Planning** — planning models (SAC and Seamless), `sac_model_dimension_add`, `sac_model_hierarchy_set`,
  `sac_model_members_set`, `sac_model_data_reload` (reload facts with a derived column, backup and totals check),
  plan values without a story (`sac_plan_write` / `read` / `publish` / `revert`), data actions and multi actions,
  planning stories including a forecast layout story.
- **Datasphere** — `sac_datasphere_search` finds a model's space through the live connection; metadata and the
  dashboard generator locate the space themselves.
- **Data Analyzer** — insights on Datasphere models.
- **Public REST APIs** — data import/export, users and teams (SCIM), content transport, schedules, calendar,
  translation, audit.
- **Exploring** — record and replay what the SAC UI sends (`sac_capture_*`, `sac_replay`), raw requests. The expert
  tools `sac_browser_eval`, `sac_api_request` and `sac_replay` are only loaded with `expertTools` / `SAC_EXPERT_TOOLS=true`.
- **Skills** — `sac-scripting` and `sac-css` Agent Skills (see [skills/](skills/)).

### Security

- `readOnly` is enforced centrally for every tool; write tools need `allowalteration: true`.
- No SAC passwords are stored; the SSO session lives in the server's own browser profile.

[Unreleased]: https://github.com/RafaelSachsNL/sac-workbench-mcp/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/RafaelSachsNL/sac-workbench-mcp/releases/tag/v0.3.0
