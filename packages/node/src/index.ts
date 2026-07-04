// Core abstractions (includes orchestrator, config, session-reader, state-machine,
// types, events, hooks, playbooks, templates, ink, quality, scheduling, etc.)
export * from "./core/index.js";

// Stores
export { FileTaskStore, FileRunStore, JsonTaskStore } from "@polpo-ai/file-stores";

// Engine
export { spawnLoopEngine } from "./adapters/loop-engine.js";

// Spawners — subprocess (default) and in-process (settings.taskExecution: "in-process")
export { NodeSpawner } from "./adapters/node-spawner.js";
export { InProcessSpawner } from "./adapters/in-process-spawner.js";
export { CompositeSpawner } from "./adapters/composite-spawner.js";
export type { InProcessSpawnerDeps } from "./adapters/in-process-spawner.js";
export { executeRun } from "./core/run-lifecycle.js";
export type { ExecuteRunDeps, ExecuteRunOutcome, TranscriptSession } from "./core/run-lifecycle.js";

// Assessment
export { assessTask, runCheck, runMetric } from "./assessment/assessor.js";
export { runLLMReview, computeWeightedScore, buildRubricSection, DEFAULT_DIMENSIONS, validateReviewPayload, ReviewPayloadSchema, findLogForTask, buildExecutionSummary } from "./assessment/index.js";
export type { LLMQueryFn } from "./assessment/llm-review.js";
export type { ValidatedReviewPayload, ExecutionSummaryResult } from "./assessment/index.js";

// Server
export { PolpoServer, createApp, SSEBridge } from "./server/index.js";
export type { AppOptions } from "./server/index.js";
export type {
  ServerConfig,
  ApiResponse,
  ApiError,
  SSEEvent,
  CreateTaskRequest,
  UpdateTaskRequest,
  CreateMissionRequest,
  UpdateMissionRequest,
  AddAgentRequest,
} from "./server/index.js";

// Route factories (for data-plane wiring)
export {
  taskRoutes,
  missionRoutes,
  agentRoutes,
  eventRoutes,
  chatRoutes,
  skillRoutes,
  approvalRoutes,
  playbookRoutes,
  stateRoutes,
  completionRoutes,
  scheduleRoutes,
  watcherRoutes,
  vaultRoutes,
  fileRoutes,
  configRoutes,
  publicConfigRoutes,
  healthRoutes,
} from "./server/index.js";

// Security
export { safeEnv, bashSafeEnv } from "@polpo-ai/tools";

// Extended Tools
export { createSystemTools, createSystemTools as createCodingTools, createAllTools, TOOL_CATALOG } from "@polpo-ai/tools";
export type { ExtendedToolName, CreateAllToolsOptions } from "@polpo-ai/tools";
export { createBrowserTools, ALL_BROWSER_TOOL_NAMES } from "@polpo-ai/tools";
export { createHttpTools, ALL_HTTP_TOOL_NAMES } from "@polpo-ai/tools";
export { createExcelTools, ALL_EXCEL_TOOL_NAMES } from "@polpo-ai/tools";
export { createPdfTools, ALL_PDF_TOOL_NAMES } from "@polpo-ai/tools";
export { createDocxTools, ALL_DOCX_TOOL_NAMES } from "@polpo-ai/tools";
export { createEmailTools, ALL_EMAIL_TOOL_NAMES } from "@polpo-ai/tools";
export { createVaultTools, ALL_VAULT_TOOL_NAMES } from "@polpo-ai/tools";
export { createAudioTools, ALL_AUDIO_TOOL_NAMES } from "@polpo-ai/tools";
export { createImageTools, ALL_IMAGE_TOOL_NAMES } from "@polpo-ai/tools";
