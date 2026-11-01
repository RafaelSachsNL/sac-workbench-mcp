/**
 * Tool registry — barrel that imports and registers all tool modules.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerContentTools } from "./content.js";
import { registerDataExportTools } from "./data-export.js";
import { registerDataImportTools } from "./data-import.js";
import { registerMultiActionTools } from "./multi-actions.js";
import { registerCalendarTools } from "./calendar.js";
import { registerContentTransportTools } from "./content-transport.js";
import { registerUserManagementTools } from "./user-management.js";
import { registerMonitoringTools } from "./monitoring.js";
import { registerSchedulePublicationTools } from "./schedule-publication.js";
import { registerTranslationTools } from "./translation.js";
import { registerSmartQueryTool } from "./smart-query.js";
import { registerHackTools } from "./hack.js";
import { registerStoryTools } from "./story.js";
import { registerStoryModelTools } from "./story-model.js";
import { registerWidgetTools } from "./widgets.js";
import { registerDashboardTools } from "./dashboard.js";
import { registerAnalyzerTools } from "./analyzer.js";
import { registerScriptingTools } from "./scripting.js";
import { registerModelingTools } from "./modeling.js";
import { registerCompositeTools } from "./composites.js";
import { registerPlanningDataTools } from "./planning-data.js";

export function registerTools(server: McpServer): void {
  // ── Connectivity check ──────────────────────────────────────────
  server.tool(
    "ping",
    "Returns pong — useful for verifying connectivity",
    {},
    async () => ({
      content: [{ type: "text" as const, text: "pong" }],
    }),
  );

  // ── SAC API tool modules ────────────────────────────────────────
  registerCompositeTools(server);
  registerPlanningDataTools(server);
  registerContentTools(server);
  registerDataExportTools(server);
  registerDataImportTools(server);
  registerMultiActionTools(server);
  registerCalendarTools(server);
  registerContentTransportTools(server);
  registerUserManagementTools(server);
  registerMonitoringTools(server);
  registerSchedulePublicationTools(server);
  registerTranslationTools(server);
  registerSmartQueryTool(server);
  registerHackTools(server);
  registerStoryTools(server);
  registerStoryModelTools(server);
  registerWidgetTools(server);
  registerDashboardTools(server);
  registerAnalyzerTools(server);
  registerScriptingTools(server);
  registerModelingTools(server);
}
