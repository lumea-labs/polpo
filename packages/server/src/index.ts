/**
 * @polpo-ai/server — Edge-compatible Hono route factories.
 *
 * These route factories accept dependency thunks and return OpenAPIHono apps.
 * They work on any runtime: Node.js, Cloudflare Workers, Deno, Bun.
 *
 * For routes that require Node.js (completions, files, agents avatar),
 * import from "polpo-ai" instead.
 */

// Route factories
export { taskRoutes } from "./routes/tasks.js";
export { missionRoutes } from "./routes/missions.js";
export { playbookRoutes } from "./routes/playbooks.js";
export { approvalRoutes } from "./routes/approvals.js";
export { chatRoutes } from "./routes/chat.js";
export { vaultRoutes } from "./routes/vault.js";
export { scheduleRoutes } from "./routes/schedules.js";
export { watcherRoutes } from "./routes/watchers.js";
export { stateRoutes } from "./routes/state.js";
export { healthRoutes } from "./routes/health.js";
export { completionRoutes, resumeProjectLoopRun, type CompletionRouteDeps } from "./routes/completions.js";
export { agentRoutes } from "./routes/agents.js";
export { loopRoutes, type LoopRouteDeps } from "./routes/loops.js";
export { loopRunRoutes, type LoopRunRouteDeps } from "./routes/loop-runs.js";
export { eventRoutes, type EventBridge, type EventClient } from "./routes/events.js";
export { configRoutes } from "./routes/config.js";
export { fileRoutes, type FileRouteDeps } from "./routes/files.js";
export { skillRoutes, type SkillRouteDeps } from "./routes/skills.js";
// Dependency types
export type {
  TaskRouteDeps,
  MissionRouteDeps,
  PlaybookRouteDeps,
  ApprovalRouteDeps,
  ChatRouteDeps,
  VaultRouteDeps,
  ScheduleRouteDeps,
  WatcherRouteDeps,
  StateRouteDeps,
  ConfigRouteDeps,
  AuthRouteDeps,
  AgentRouteDeps,
} from "./deps.js";

// Validation schemas (Zod — reusable by CLI for pre-flight validation)
export { AddAgentSchema, UpdateAgentSchema, RenameTeamSchema } from "./schemas.js";
export { compileLoopSource, LoopDslCompileError } from "./loop-dsl-compiler.js";

// Playbook utilities (pure logic, edge-compatible)
export { validateParams, instantiatePlaybook } from "./playbook-utils.js";
export type { PlaybookParameter, PlaybookDefinition, ValidationResult } from "./playbook-utils.js";
