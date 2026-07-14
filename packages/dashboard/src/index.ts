export {
  DashboardProvider,
  useDashboardApi,
  useDashboardHost,
  useDashboardHref,
} from "./host.js";
export type {
  DashboardApi,
  DashboardCapabilities,
  DashboardHost,
  DashboardMutationOptions,
} from "./host.js";
export { createSelfHostedDashboardApi } from "./self-host-api.js";
export { PageBody, PageHeader, Button, IconButton, DataTable, LoadingRows } from "./components.js";
export type { ColumnMeta } from "./components.js";
export { PageBody as V2PageBody, PageHeader as V2PageHeader } from "./v2/ui/page-header.js";
export { Button as V2Button } from "./v2/ui/button.js";
export { DataTable as V2DataTable } from "./v2/ui/data-table.js";
export { RefreshButton as V2RefreshButton } from "./v2/ui/refresh-button.js";
export { DashboardShell } from "./v2/shell/dashboard-shell.js";
export { AgentsTable as V2AgentsView } from "./v2/views/agents.js";
export type { AgentRow as V2AgentRow, TeamRow as V2TeamRow } from "./v2/views/agents.js";
export { AgentDetail as V2AgentDetail } from "./v2/agents/agent-detail.js";
export type { AgentDetailData as V2AgentDetailData } from "./v2/agents/agent-detail.js";
export { SelfHostAgentDetailView as V2AgentDetailView } from "./v2/agents/self-host-detail.js";
export { SkillsCatalog as V2SkillsView } from "./v2/views/skills.js";
export type { Skill as V2Skill } from "./v2/views/skills.js";
export { SkillDetail as V2SkillDetail } from "./v2/views/skills-detail.js";
export type { LoadedSkill as V2LoadedSkill } from "./v2/views/skills-detail.js";
export { SelfHostSkillDetailView as V2SkillDetailView } from "./v2/skills/self-host-detail.js";
export { FilesView as V2FilesView } from "./v2/views/files.js";
export { FilesBrowser as V2FilesBrowser } from "./v2/files/files-browser.js";
export { MemoryView as V2MemoryView } from "./v2/views/memory.js";
export { ProjectMemory as V2ProjectMemory } from "./v2/views/memory-project.js";
export { SelfHostSessionsView as V2SessionsView, SelfHostSessionDetailView as V2SessionDetailView } from "./v2/sessions/self-host.js";
export {
  SessionsHostProvider as V2SessionsHostProvider,
} from "./v2/sessions/host.js";
export type { SessionsHostAdapter as V2SessionsHostAdapter } from "./v2/sessions/host.js";
export {
  SessionsView as V2SessionsTable,
} from "./v2/views/sessions.js";
export { SessionsDetailView as V2SessionDetail } from "./v2/views/sessions-detail.js";
export { SelfHostPlaygroundView as V2PlaygroundView } from "./v2/playground/self-host.js";
export {
  PlaygroundHostProvider as V2PlaygroundHostProvider,
} from "./v2/playground/host.js";
export type { PlaygroundHostAdapter as V2PlaygroundHostAdapter } from "./v2/playground/host.js";
export { PlaygroundView as V2Playground } from "./v2/views/playground.js";
export { SelfHostToolsView as V2ToolsView, SelfHostToolDetailView as V2ToolDetailView } from "./v2/tools/self-host.js";
export { ToolsView as V2ToolsTable } from "./v2/tools/tools-view.js";
export type { ToolRow as V2ToolRow } from "./v2/tools/tools-view.js";
export { ToolDetail as V2ToolDetail } from "./v2/tools/tool-detail.js";
export { AgentsView } from "./views/agents.js";
export { AgentDetailView } from "./views/agent-detail.js";
export { PlaygroundView } from "./views/playground.js";
export { SessionsView } from "./views/sessions.js";
export { SessionDetailView } from "./views/session-detail.js";
export { MemoryView } from "./views/memory.js";
export { SkillsView } from "./views/skills.js";
export { FilesView } from "./views/files.js";
