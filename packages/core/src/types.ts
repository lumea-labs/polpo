/**
 * Core types — barrel.
 *
 * Split by domain under ./types/:
 *   - task.ts          — Task, TaskStatus, TaskResult, expectations, outcomes, watchers
 *   - mission.ts       — Mission, checkpoint/delay/quality-gate/approval-gate, report, SLA, scheduling
 *   - agent.ts         — AgentConfig, Team, identity, vault, activity, multi-team helpers
 *   - config.ts        — PolpoConfig, PolpoSettings, file config, providers, runner config, state
 *   - notifications.ts — notification channels/rules/actions, scoped rules, escalation
 *   - assessment.ts    — AssessmentResult, DimensionScore, EvalDimension, reviewers, ReviewContext
 *
 * This barrel preserves the public `@polpo-ai/core/types` subpath and every
 * internal `./types.js` import.
 */

export * from "./types/task.js";
export * from "./types/mission.js";
export * from "./types/agent.js";
export * from "./types/config.js";
export * from "./types/notifications.js";
export * from "./types/assessment.js";
export type {
  RuntimeSandboxLifecycleOptions,
  RuntimeSandboxOptions,
  RuntimeSandboxVolumeSelection,
  SandboxIsolation,
  SandboxReleasePolicy,
  SandboxVolumeAccess,
  SandboxVolumeWriteBack,
} from "./runtime-sandbox.js";
