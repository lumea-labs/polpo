// ── Types ────────────────────────────────────────────────────────────────
export * from "./types.js";

export type { PolpoTool, ToolResult, ToolUpdateCallback } from "./tool-types.js";
export { extractToolUsageRecord } from "./tool-usage.js";

// ── Model runtime facts (neutral, no provider SDK imports) ───────────────
export {
  MODEL_RUNTIME_MODES,
  isModelRuntimeMode,
} from "./model-runtime.js";
export type {
  BillingOwner,
  CostSource,
  CredentialType,
  ModelInvocationContext,
  ModelInvocationRecord,
  ModelInvocationStatus,
  ModelInvocationUsage,
  ModelOperation,
  ModelRef,
  ModelRuntimeMode,
  NormalizedModelError,
  UsageExtractionInput,
} from "./model-runtime.js";
export type {
  ModelInvocationListFilter,
  ModelInvocationStore,
} from "./model-invocation-store.js";
export {
  MODEL_CATALOG_CAPABILITIES,
  MODEL_CATALOG_LEGACY_TYPES,
  MODEL_CATALOG_MODALITIES,
  MODEL_CATALOG_OUTPUT_MODALITIES,
  isModelCatalogCapability,
  isModelCatalogLegacyType,
  isModelCatalogModality,
  normalizeModelCatalogSearchFilters,
} from "./model-catalog.js";
export type {
  ModelCatalogAgentField,
  ModelCatalogCapability,
  ModelCatalogEntry,
  ModelCatalogLegacyType,
  ModelCatalogModality,
  ModelCatalogOutputModality,
  ModelCatalogPricing,
  ModelCatalogSearchInput,
  ModelCatalogSource,
  NormalizedModelCatalogSearchFilters,
} from "./model-catalog.js";
export {
  MAX_MODEL_FALLBACKS,
  isModelConfig,
  normalizeModelPolicy,
} from "./model-policy.js";
export type {
  ModelSelection,
  NormalizedModelPolicy,
  NormalizeModelPolicyOptions,
} from "./model-policy.js";
export {
  DEFAULT_MODEL_PROFILE_MAX_DEPTH,
  MODEL_PROFILE_NAME_PATTERN,
  ModelProfileResolutionError,
  isModelProfileReference,
  resolveConfiguredModelSelection,
  resolveModelProfileSelection,
} from "./model-profiles.js";
export type {
  ConfiguredModelProfiles,
  ModelProfileResolutionErrorCode,
  ResolveModelProfileSelectionOptions,
  ResolvedModelProfileSelection,
} from "./model-profiles.js";
export {
  DEFAULT_MODEL_ROUTE_MAX_INPUT_CHARS,
  DEFAULT_MODEL_ROUTE_MIN_CONFIDENCE,
  DEFAULT_MODEL_ROUTE_TIMEOUT_MS,
  MAX_MODEL_ROUTE_INPUT_CHARS,
  MAX_MODEL_ROUTE_LABELS,
  MAX_MODEL_ROUTE_LABEL_CHARS,
  MAX_MODEL_ROUTE_REASON_CHARS,
  MODEL_ROUTER_MODES,
  ModelRouteCancelledError,
  modelRouteRuntimePlanFields,
  resolveModelRoute,
} from "./model-router.js";
export type {
  ModelRouteClassifier,
  ModelRouteClassifierInput,
  ModelRouteClassifierOptions,
  ModelRouteDecision,
  ModelRouteRuntimePlanFields,
  ModelRouterConfig,
  ModelRouterMode,
  ModelRouteStatus,
  ResolvedModelRoute,
  ResolveModelRouteInput,
  ResolveModelRouteOptions,
} from "./model-router.js";

// ── Runtime planning (host-neutral, serializable execution decisions) ───
export * from "./runtime-plan/index.js";
export * from "./runtime-context/index.js";
export * from "./execution-router.js";

// ── Guardrails (host-neutral policy engine + tool middleware) ───────────
export * from "./guardrails/index.js";

// ── Runtime context (source/trust metadata + injection-safe rendering) ──
export * from "./runtime-context/index.js";

// ── Guardrails (host-neutral policy engine + tool middleware) ───────────
export * from "./guardrails/index.js";

// ── Events (pure type definitions only, TypedEmitter lives in shell) ─────
export * from "./events.js";

// ── State Machine ────────────────────────────────────────────────────────
export { VALID_TRANSITIONS, isValidTransition, assertValidTransition } from "./state-machine.js";

// ── Schemas (Zod validation) ─────────────────────────────────────────────
export * from "./schemas.js";

// ── Hooks ────────────────────────────────────────────────────────────────
export { HookRegistry } from "./hooks.js";
export type {
  LifecycleHook,
  HookPhase,
  HookContext,
  HookHandler,
  HookRegistration,
  HookPayloads,
  BeforeHookResult,
} from "./hooks.js";

// ── Store Interfaces ─────────────────────────────────────────────────────
export type { TaskStore } from "./task-store.js";
export type { RunStore, RunRecord, RunStatus } from "./run-store.js";
// Unified Run — convergence target for chat/task/mission (migration plan F0, additive/unused).
export type { UnifiedRunStatus, UnifiedRunRecord, RunEngine, RunDelivery } from "./unified-run.js";
export { isTerminalRunStatus, UNIFIED_RUN_TERMINAL_STATUSES } from "./unified-run.js";
export type { ConfigStore } from "./config-store.js";
export type { MemoryStore } from "./memory-store.js";
export { agentMemoryScope } from "./memory-store.js";
export * from "./memory/index.js";
export type { SearchProvider, SearchResult, SearchOptions } from "./search-provider.js";
export {
  parseModelString,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_TTS_MODEL,
  DEFAULT_SEARCH_PROVIDER,
  AUDIO_MODEL_CATALOG,
  listAudioModels,
  getAudioModel,
} from "./agent-models.js";
export type {
  ParsedModel,
  AudioModelCapability,
  AudioModelRouting,
  AudioModelDefinition,
} from "./agent-models.js";
export type { LogStore, LogEntry, SessionInfo } from "./log-store.js";
export type { SessionStore, Session, Message, MessageRole, ToolCallInfo, ToolCallState, SessionContentPart } from "./session-store.js";
export type { ApprovalStore } from "./approval-store.js";
export type { TeamStore } from "./team-store.js";
export type { AgentStore } from "./agent-store.js";
export type { SkillStore, SkillRecord } from "./skill-store.js";
export type { VaultStore } from "./vault-store.js";
export type { PlaybookStore } from "./playbook-store.js";

// ── FileSystem & Shell Abstractions ──────────────────────────────────────
export type { FileSystem, FileEntry, FileStat } from "./filesystem.js";
export type { Shell, ShellOptions, ShellResult } from "./shell.js";

// ── Spawner Abstraction ─────────────────────────────────────────────────
export type { Spawner, SpawnResult } from "./spawner.js";
export { resolveExecutionMode } from "./execution-mode.js";
export { resolveRuntimeSandboxOptions } from "./runtime-sandbox.js";
export type { RuntimeSandboxOptions, SandboxIsolation } from "./runtime-sandbox.js";

// ── SandboxProvider Abstraction ──────────────────────────────────────────
export type {
  SandboxProvider,
  SandboxSession,
  SandboxLifecycle,
  SandboxUsage,
} from "./sandbox-provider.js";

// ── Agent Prompt Builder ────────────────────────────────────────────────
export {
  buildAgentSystemPrompt,
  buildFilesystemWorkspacePrompt,
  resolveAgentAllowedPaths,
} from "./agent-prompt.js";
export type { AgentPromptOptions, FilesystemWorkspacePromptOptions } from "./agent-prompt.js";

// ── Skills Reader (async, FileSystem-based) ────────────────────────────
export {
  discoverSkills, loadAgentSkills, listSkillsWithAssignments,
  buildSkillPrompt, parseSkillFrontmatter, extractSkillBody,
} from "./skills-reader.js";
export type { SkillInfo, LoadedSkill, SkillWithAssignment, SkillIndex, SkillIndexEntry } from "./skills-reader.js";

// ── Model Spec Parsing ─────────────────────────────────────────────────
export { parseModelSpec, PROVIDER_ENV_MAP } from "./model-spec.js";
export type { ParsedModelSpec } from "./model-spec.js";

// ── EventBus Interface ──────────────────────────────────────────────────
export type { EventBus } from "./event-bus.js";

// ── Additional Store Interfaces ─────────────────────────────────────────
export type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
export type { DelayStore, DelayState } from "./delay-store.js";
// ── OrchestratorContext ─────────────────────────────────────────────────
export type { OrchestratorContext, AssessFn, CheckProgressEvent } from "./orchestrator-context.js";

// ── Cron (pure) ─────────────────────────────────────────────────────────
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "./cron.js";

// ── Core Managers ───────────────────────────────────────────────────────
export { TaskManager } from "./task-manager.js";
export { AgentManager } from "./agent-manager.js";
export { ApprovalManager } from "./approval-manager.js";
export { EscalationManager } from "./escalation-manager.js";
export { TaskWatcherManager } from "./task-watcher.js";
export { QualityController } from "./quality-controller.js";
export { SLAMonitor } from "./sla-monitor.js";
export { Scheduler } from "./scheduler.js";

// ── MissionExecutor ─────────────────────────────────────────────────────
export { MissionExecutor } from "./mission-executor.js";

// ── TaskRunner ──────────────────────────────────────────────────────────
export { TaskRunner } from "./task-runner.js";

// ── OrchestratorEngine ──────────────────────────────────────────────────
export { OrchestratorEngine } from "./orchestrator-engine.js";
export { TickWaiter } from "./tick-waiter.js";

// ── Mission store (canonical mission persistence contract) ──────────────
export { taskStoreMissionAdapter, resolveMissionStore, resolveMissionForTask } from "./mission-store.js";

// ── Playbook pure logic (validation + instantiation; file IO lives in @polpo-ai/file-stores) ──
export { validateParams, instantiatePlaybook, validatePlaybookDefinition } from "./playbook-logic.js";
export type { ValidationResult } from "./playbook-logic.js";
export type { MissionStore } from "./mission-store.js";

// ── Vault resolver (shared by shell, tools, and the cloud data plane) ────
export {
  resolveEnvVar,
  resolveVaultCredentials,
  resolveAgentVault,
} from "./vault-resolver.js";
export type { ResolvedVault, SmtpCredentials, ImapCredentials } from "./vault-resolver.js";
export type {
  OrchestratorEngineDeps,
  TaskRunnerPort,
  AssessmentOrchestratorPort,
  MissionExecutorPort,
  DeadlockResolverPort,
  DeadlockFacade,
  TaskWatcherManagerPort,
} from "./orchestrator-engine.js";

// ── Assessment Pipeline ──────────────────────────────────────────────────
export { AssessmentOrchestrator, type AssessmentPorts } from "./assessment-orchestrator.js";
export { buildFixPrompt, buildRetryPrompt, buildSideEffectFixPrompt, buildSideEffectRetryPrompt, buildJudgePrompt, sleep, type JudgeCorrectionFix, type JudgeCorrection, type JudgeVerdict } from "./assessment-prompts.js";
export { looksLikeQuestion, classifyAsQuestion } from "./question-detector.js";

// ── Adapter Types ────────────────────────────────────────────────────────
export type { AgentHandle, SpawnContext, ChatSessionInjection } from "./adapter.js";

// ── Assessment (pure — no Node.js deps) ─────────────────────────────────
export { assessTask, runCheck, runMetric, type AssessmentDeps, type CheckProgressEvent as AssessorCheckProgressEvent } from "./assessor.js";
export { DEFAULT_DIMENSIONS, buildRubricSection, computeWeightedScore, computeMedianScores } from "./assessment-scoring.js";
export { validateReviewPayload, ReviewPayloadSchema, ReviewScoreSchema, REVIEW_JSON_SCHEMA, type ValidatedReviewPayload } from "./assessment-schemas.js";
export { withRetry, isTransientError, type RetryOptions } from "./retry.js";

// ── Context Compaction ──────────────────────────────────────────────────
export {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  pruneToolOutputs,
  compactIfNeeded,
  getCompactionPrompt,
  PRUNE_PROTECT,
  PRUNE_MINIMUM,
  TRIGGER_THRESHOLD,
  TARGET_AFTER,
} from "./context-compactor.js";
export type {
  CompactionConfig,
  CompactionEvent,
  OnCompactionFn,
  SummarizeFn,
  CompactionInput,
  CompactionResult,
} from "./context-compactor.js";

export { EVENT_CATALOG } from "./events-catalog.js";
export type { EventCatalogGroup, EventCatalogEntry } from "./events-catalog.js";

// Configurable agentic loops (design: loop collection + pipeline + hooks). P0:
// the safe expression evaluator (replaces the gates' `new Function`) + config types.
export { evaluateExpression, SafeExpressionEvaluator } from "./loop/expression.js";
export type {
  AgentLoopConfig,
  ContextBag,
  LoopConfig,
  LoopHookAction,
  LoopLifecycleHook,
  LoopNext,
  LoopPermissionEffect,
  LoopPermissionMatch,
  LoopPermissionResource,
  LoopPolicyEffect,
  LoopStepConfig,
  LoopTraceEvent,
  LoopTraceEventType,
  LoopToolChoice,
  Pipeline,
  ProjectLoopConfig,
  ProjectLoopHooks,
  ProjectLoopKind,
  ProjectLoopPermission,
  ProjectLoopPolicy,
  ProjectLoopVersion,
  Step,
  SwitchCase,
  WhileBlock,
  Condition,
  ToolLoopStep,
  WhileLoopStep,
} from "./loop/types.js";
export { LOOP_LIFECYCLE_HOOKS, isLoopStep, isToolStep, isParallelStep, isSwitchStep, isWhileStep, isHumanStep } from "./loop/types.js";
export { normalizeProjectLoop } from "./loop/normalize.js";
export {
  buildLoopStepAgent,
  loopContextPrompt,
  maybeParseJson,
  normalizeToolInput,
  stringifyLoopContext,
} from "./loop/step-helpers.js";
export {
  agentStep,
  bash,
  defineLoop,
  defineProjectLoop,
  humanStep,
  otherwise,
  parallelStep,
  permission,
  policy,
  requireTool,
  toolAction,
  toolStep,
  whileStep,
  when,
} from "./loop/code.js";
export { LoopHookRegistry } from "./loop/hooks.js";
export type {
  LoopBeforeHookResult,
  LoopHook,
  LoopHookContext,
  LoopHookHandler,
  LoopHookPayloads,
  LoopHookPhase,
  LoopHookRegistration,
  LoopRunStatus,
  LoopRuntimeConfig,
  LoopStopReason,
  LoopToolCall,
  LoopToolResult,
} from "./loop/hooks.js";
export { LoopRunner } from "./loop/runner.js";
export type { LoopModelInput, LoopModelResult, LoopRunnerOptions, LoopRunResult } from "./loop/runner.js";
export { resolveLoopSelection, resolveActiveLoopTools, resolveActiveLoopSkills } from "./loop/selector.js";
export type { LoopSelection } from "./loop/selector.js";
export { PipelineExecutor } from "./loop/pipeline.js";
export type {
  PipelineCheckpoint,
  PipelineExecutionResult,
  PipelineExecutorOptions,
  PipelineHumanResult,
  PipelineLoopResult,
  PipelineStepPosition,
  PipelineToolResult,
  PipelineTraceEvent,
} from "./loop/pipeline.js";
export {
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  LoopPermissionDeniedError,
  LoopPolicyDeniedError,
  MemoryLoopRunStore,
} from "./loop/run-store.js";
export type {
  CreateLoopRunInput,
  LoopApprovedGate,
  LoopApprovalSnapshot,
  LoopRunListFilter,
  LoopRunRecord,
  LoopResumeState,
  ProjectLoopRunStatus,
  LoopRunStore,
} from "./loop/run-store.js";
