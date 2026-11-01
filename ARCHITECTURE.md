# Architecture — sac-workbench-mcp

How the server talks to SAP Analytics Cloud, and how new tools are found and built. For the tool list see
[TOOLS.md](TOOLS.md); for setup the [README](README.md).

> Most interfaces below are **undocumented SAC internals** — the requests the SAC web UI sends. They can change with
> any SAC release. See the disclaimer in the README.

## Stack

| Component | Technology |
|---|---|
| Language | TypeScript (ES modules), Node.js ≥ 22 |
| MCP | `@modelcontextprotocol/sdk`, stdio transport |
| Browser session | `playwright-core` driving the installed Chrome with a persistent profile |
| Validation | `zod` (tool parameters) |

## Two ways into SAC

| Path | Used for | Authentication |
|---|---|---|
| **Browser session** (main path) | everything the SAC UI can do: stories, models, planning, themes, files | SSO once in the server's own Chrome profile (`npm run login`); requests run inside the signed-in SAC page |
| **Public REST API** `/api/v1/...` (optional) | data import/export, users (SCIM), transport, schedules, calendar, translation | OAuth client credentials, if configured — otherwise also through the browser session |

### Browser session

- `src/browser/session.ts` starts Chrome with a persistent profile (`~/.sac-mcp/browser-profile`), waits for the SSO
  login and detects the tenant id.
- Requests are executed with `fetch` **inside the SAC page**, so cookies, SSO and same-origin rules behave exactly as
  for the UI. CSRF tokens are fetched per service scope (`X-CSRF-Token: Fetch`) and retried once on 403.
- No passwords are entered or stored; session secrets never go into recordings.

### Internal services used

| Service | Path | What for |
|---|---|---|
| Content library | `/sap/fpa/services/rest/epm/contentlib` | read/write story, theme, composite and model content; folders; copy, move, delete |
| Modeler | `/sap/fpa/services/rest/fpa/model`, `/dimension`, `/member` | create models, add dimensions and hierarchies, members (`getDesignTime`, `updateDesignTime`, `createWithResource`, `updateWithResource`, `query`, `update`) |
| InA | `/sap/bc/ina/service/v2/GetResponse` and `/lcs/dwc/tunnel/<connection>/sap/bc/ina/...` | metadata of SAC and Datasphere models, plan reads/writes, publish/revert |
| Datasphere search | `/sap/fpa/services/rest/fpa/dwcDataRepository/searchLcs` | find a Datasphere model's space via the live connection (the returned token is discarded) |
| Data actions | `/sap/fpa/services/rest/...` (recorded) | create and run data actions and multi actions |

## Stories are JSON documents

An Optimized Story is one content document (`getContent` / `updateContent` of the content library). The server
loads it, changes it and saves it with optimistic locking:

- `entities[type=story].data.pages[].content.widgets[]` — the widget registry (charts carry `vizDefinition` with
  feeds, properties and the query `ffQuery`)
- `pages[].content.layouts[].definition.page.sections[]` — positions; containers have inner layouts
- the application entity — outline names (script names), scripts, events
- story-wide settings — theme copy, `colorSync` / `measureSync` / `patternSync` (series colours), calculations

`src/story/*.ts` holds one module per concern (chart, calculations, colours, CSS, layout, duplicate, themes …). Each
module documents what SAC requires and how it was found out.

## Templates

`templates/` contains payloads recorded from the SAC UI (story with a table, widget fragments, model creation, data
action, composites, the forecast planning story). Tenant-specific values in them are **placeholders** that the code
replaces at runtime with your tenant package, user, folder, model, ids and dimension names. References to objects a
tenant may not have (theme, composites) are dropped when a story is created from a template.

## Safety in the code

- Every writing tool takes `allowalteration` and calls `assertWritable()`; `readOnly: true` blocks all writes.
- `sac_story_transform` and `sac_model_data_reload` keep a local backup before they change anything.
- CSS is validated against the SAC editor's rules before saving (`src/story/css-validate.ts`); red/green series
  colours need confirmation (`src/story/colors.ts`).

## Finding out how SAC does something

1. `sac_capture_start` — record the XHR/fetch traffic of the SAC page.
2. Do the action in SAC (by hand, or with `sac_browser_ui`).
3. `sac_capture_stop`, `sac_capture_get <index>` — inspect URL, payload and response.
4. Turn the payload into a template or a builder function; parameterise what varies.
5. Verify with the real tenant (`npm run smoke`, `sac_story_check_runtime`, `sac_story_inspect`).

Typical findings this way: which fields SAC fills in itself (a minimal dimension entry in a chart query is enough),
which version number the lock wants (`contentLibData.metadata.version`), or which keys a setting really uses
(scale "Unformatted" is stored as `""`).
