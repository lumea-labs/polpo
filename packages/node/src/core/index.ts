export * from "@polpo-ai/core/types";
export * from "@polpo-ai/core/runtime-plan";
export * from "./events.js";
export { VALID_TRANSITIONS, isValidTransition, assertValidTransition } from "@polpo-ai/core/state-machine";
export type { TaskStore } from "@polpo-ai/core/task-store";
export type { AgentHandle } from "@polpo-ai/core/adapter";
export type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
export type { ConfigStore } from "@polpo-ai/core/config-store";
export type { MemoryStore } from "@polpo-ai/core/memory-store";
export type { LogStore, LogEntry, SessionInfo } from "@polpo-ai/core/log-store";
export type { SessionStore, Session, Message, MessageRole, ToolCallInfo, ToolCallState, SessionContentPart } from "@polpo-ai/core/session-store";
export type { ApprovalStore } from "@polpo-ai/core/approval-store";
export { Orchestrator, buildRetryPrompt } from "./orchestrator.js";
export type { OrchestratorOptions, AssessFn } from "./orchestrator.js";
export { parseConfig, loadPolpoConfig, savePolpoConfig, generatePolpoConfigDefault, validateAgents } from "./config.js";
export { readSessionSummary, readSessionSummaryFromPath, getRecentMessages, findTranscriptPath } from "./session-reader.js";
export { looksLikeQuestion, classifyAsQuestion } from "./question-detector.js";
export { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
// Hooks
export { HookRegistry } from "@polpo-ai/core/hooks";
export type {
  LifecycleHook,
  HookPhase,
  HookContext,
  HookHandler,
  HookRegistration,
  HookPayloads,
  BeforeHookResult,
} from "@polpo-ai/core/hooks";

// Approval
export { ApprovalManager } from "@polpo-ai/core/approval-manager";

// Escalation
export { EscalationManager } from "@polpo-ai/core/escalation-manager";

// Quality Layer
export { SLAMonitor } from "../quality/sla-monitor.js";
export { QualityController } from "../quality/quality-controller.js";

// Scheduling
export { Scheduler } from "../scheduling/scheduler.js";
export { parseCron, matchesCron, nextCronOccurrence, isCronExpression } from "../scheduling/cron.js";

// Task Watchers
export { TaskWatcherManager } from "@polpo-ai/core/task-watcher";

// Playbooks
export { validateParams, instantiatePlaybook, validatePlaybookDefinition } from "@polpo-ai/core";
export { discoverPlaybooks, loadPlaybook, savePlaybook, deletePlaybook } from "@polpo-ai/file-stores";
export type { PlaybookParameter, PlaybookDefinition, PlaybookInfo } from "@polpo-ai/core/playbook-store";
export type { ValidationResult } from "@polpo-ai/core";
export type { PlaybookStore } from "@polpo-ai/core/playbook-store";

// Backward-compat aliases (deprecated)

// Ink Registry
export {
  parseInkSource,
  hashContent,
  discoverInkPackages,
  validateInkPlaybook,
  validateInkAgent,
  validateInkCompany,
  readInkLock,
  writeInkLock,
  upsertInkLockEntry,
  removeInkLockEntry,
  isInkSourceInstalled,
  getInkLockEntry,
  stripInkMetadata,
} from "./ink.js";
export type {
  InkPackageType,
  InkSource,
  InkPackage,
  InkPackageMetadata,
  InkVerdictLevel,
  InkVerdict,
  InkLockEntry,
  InkLockPackage,
  InkLockFile,
  InkValidationResult,
} from "./ink.js";
