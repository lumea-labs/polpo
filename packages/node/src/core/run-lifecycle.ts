/**
 * Shared run lifecycle — executeRun().
 *
 * The complete lifecycle of ONE agent run (initial run record, engine spawn,
 * transcript + activity persistence, durable-turns checkpoint sink, terminal
 * completeRun) extracted from the subprocess runner so two hosts can execute
 * the exact same code path:
 *
 *   - the detached subprocess entry (core/runner.ts, spawned by NodeSpawner):
 *     builds its own store connections, pid = process.pid, SIGTERM → abort;
 *   - the InProcessSpawner (adapters/in-process-spawner.ts): reuses the
 *     orchestrator's stores, synthetic negative pid, kill() → abort.
 *
 * Contract:
 *   - executeRun NEVER exits the process and NEVER closes the injected
 *     stores — both lifetimes belong to the host.
 *   - Every failure path is persisted on the run record via completeRun
 *     (the in-process host must never crash because a run failed).
 *   - Abort (deps.signal) carries the subprocess SIGTERM semantics: kill
 *     the engine, force exitCode 1, mark the run "killed".
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FileMemoryStore } from "@polpo-ai/file-stores";
import { spawnLoopEngine } from "../adapters/loop-engine.js";
import type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { LogEntry } from "@polpo-ai/core/log-store";
import type { RunnerConfig, TaskResult } from "@polpo-ai/core/types";
import type { AgentHandle, ChatSessionInjection } from "@polpo-ai/core/adapter";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import { sanitizeTranscriptEntry } from "../server/security.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import {
  normalizeRuntimePromptContextSegments,
  normalizeRuntimeContextTrustMode,
} from "@polpo-ai/core";
import {
  createConfiguredRunOutputPolicy,
  createConfiguredRunToolMiddleware,
  createObservationalRunToolMiddleware,
  type RunOutputPolicy,
  type RunToolMiddleware,
  type RuntimeGuardrailAuditEvent,
} from "@polpo-ai/core/guardrails";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";

const ACTIVITY_POLL_MS = 1500;
const MAX_ACTIVITY_GUARDRAIL_DECISIONS = 100;

export function errorResult(err: unknown): TaskResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { exitCode: 1, stdout: "", stderr: `Runner error: ${msg}`, duration: 0 };
}

/** Persistent per-run activity log (JSONL file in .polpo/logs/) */
export class RunActivityLog {
  private logPath?: string;
  private lastSnapshot = "";

  constructor(polpoDir: string, runId: string, taskId: string, agentName: string, pid: number) {
    try {
      const logsDir = join(polpoDir, "logs");
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
      this.logPath = join(logsDir, `run-${runId}.jsonl`);
      this.write({ _run: true, runId, taskId, agentName, startedAt: new Date().toISOString(), pid });
    } catch {
      // A remote/sandbox polpoDir is not necessarily writable by the host.
      // DB-backed hosts persist the same transcript through createLogSession;
      // the local JSONL side-channel is intentionally best-effort.
      this.logPath = undefined;
    }
  }

  /** Log activity diff — only writes if something changed */
  logActivity(activity: Record<string, unknown>): void {
    const snapshot = JSON.stringify(activity);
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    this.write({ ts: new Date().toISOString(), event: "activity", data: activity });
  }

  /** Log a transcript entry from the engine (assistant text, tool_use, tool_result, etc.) */
  logTranscript(entry: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), ...sanitizeTranscriptEntry(entry) });
  }

  /** Log a lifecycle event */
  logEvent(event: string, data?: Record<string, unknown>): void {
    this.write({ ts: new Date().toISOString(), event, ...(data ? { data } : {}) });
  }

  private write(obj: Record<string, unknown>): void {
    if (!this.logPath) return;
    try { appendFileSync(this.logPath, JSON.stringify(obj) + "\n", "utf-8"); } catch { /* best effort */ }
  }
}

/**
 * One transcript persistence session (a LogStore session scoped to this run).
 *
 * Injected as a factory instead of a LogStore because LogStore keeps its
 * "current session" as instance state: the subprocess owns a private
 * instance (startSession is safe), while the in-process host must open a
 * dedicated instance/session per run or concurrent runs would hijack each
 * other's (and the orchestrator's) session.
 */
export interface TranscriptSession {
  sessionId: string;
  append(entry: LogEntry): Promise<void>;
}

export interface ExecuteRunDeps {
  /** Run persistence. NOT closed by executeRun — the host owns it. */
  runStore: RunStore;
  /**
   * Per-run transcript session factory (DB storage modes). Undefined = file
   * mode: the JSONL activity log is the only transcript side-channel,
   * matching the historical subprocess behavior.
   */
  createLogSession?: () => Promise<TranscriptSession>;
  /** Vault store. Default: EncryptedVaultStore(polpoDir), best-effort. */
  vaultStore?: VaultStore;
  /** Memory store. Default: FileMemoryStore(polpoDir). */
  memoryStore?: MemoryStore;
  /** FileSystem for tools. Default: a fresh NodeFileSystem. */
  fs?: FileSystem;
  /** Shell for tools. Default: a fresh NodeShell. */
  shell?: Shell;
  /**
   * LLM gateway configuration for the loop's model resolution. The subprocess
   * host leaves this undefined and relies on gateway/provider env vars inside
   * the sandbox; an in-process host (proxy execution) must pass the per-tenant
   * gateway here — the loop runs in a shared process with no per-tenant env.
   */
  gatewayConfig?: unknown;
  /** Optional host-resolved tool guardrail middleware. */
  runToolMiddleware?: RunToolMiddleware;
  /** Optional host-resolved output guardrail policy. */
  runOutputPolicy?: RunOutputPolicy;
  /** Pid recorded on the run record: process.pid (subprocess) or a synthetic negative id (in-process). */
  pid: number;
  /** Where the config was persisted ("file:///path", "db://runId", "memory://…"). */
  configPath: string;
  /** Abort = graceful kill (subprocess SIGTERM / in-process spawner.kill). */
  signal?: AbortSignal;
  /**
   * Live event subscription. Optional and additive: a STREAMING host
   * (chat-via-executeRun, migration F1) passes this to receive each transcript
   * entry — assistant text, tool_use, tool_result, loop_trace, error — as the
   * engine emits it, and map it to SSE. Background hosts (task/subprocess) leave
   * it undefined, so behaviour is unchanged: it is teed alongside the existing
   * activity-log / DB-transcript persistence, never in place of it.
   *
   * Granularity note: entries arrive per TURN today (whole assistant text in one
   * entry); token-by-token deltas are a follow-up (F1b, in loop-engine).
   */
  onEvent?: (entry: Record<string, unknown>) => void;
  /**
   * Chat-session injection (F1c). When set, the run executes a chat turn-loop
   * over the injected model/prompt/tools/messages instead of the task's own
   * resolution — forwarded to SpawnContext.inject. Undefined for task runs.
   */
  inject?: ChatSessionInjection;
}

export interface ExecuteRunOutcome {
  status: RunStatus;
  result: TaskResult;
  /** True when the engine could not even be spawned (the subprocess entry exits 1 on this). */
  spawnError?: boolean;
}

/**
 * Execute one agent run end-to-end against the injected stores.
 * See module header for the host contract.
 */
export async function executeRun(config: RunnerConfig, deps: ExecuteRunDeps): Promise<ExecuteRunOutcome> {
  const { runStore, pid, configPath } = deps;
  const actLog = new RunActivityLog(config.polpoDir, config.runId, config.taskId, config.agent.name, pid);

  // When a transcript session is available (postgres/sqlite), persist the
  // transcript to the DB. This ensures it survives sandbox destruction.
  let logSession: TranscriptSession | undefined;
  if (deps.createLogSession) {
    logSession = await deps.createLogSession();
  }

  const now = new Date().toISOString();
  const initialRecord: RunRecord = {
    id: config.runId,
    taskId: config.taskId,
    pid,
    agentName: config.agent.name,
    status: "running",
    startedAt: now,
    updatedAt: now,
    // sessionId starts at the LogStore session we just opened, so the
    // run record is linked to its transcript from the very first poll.
    // Without this, downstream readers (the cloud task-activity endpoint,
    // a future dashboard, anything that joins runs to log sessions) have
    // to guess by time-proximity — fragile on cold sandboxes where the
    // log session is created hundreds of ms before the first stream
    // chunk lands. In file mode this is mostly cosmetic because
    // RunActivityLog writes a parallel JSONL side-channel; in DB mode
    // (cloud) it's the only link that ever gets persisted.
    activity: {
      filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now,
      ...(logSession ? { sessionId: logSession.sessionId } : {}),
    },
    configPath,
    engine: "agent",
    delivery: deps.inject ? "stream" : "background",
  };
  // In DB mode, run record already exists (created by spawner) — update it with PID
  await runStore.upsertRun(initialRecord);
  actLog.logEvent("spawning", { task: config.task.title });

  let handle: AgentHandle;
  const guardrailDecisions: RuntimeGuardrailAuditEvent[] = [];
  let guardrailDecisionsTruncated = false;
  try {
    // Use the injected vault store when available (postgres/sqlite or
    // orchestrator-owned), fall back to file-based
    let vaultStore: VaultStore | undefined = deps.vaultStore;
    if (!vaultStore) {
      try { vaultStore = new EncryptedVaultStore(config.polpoDir); } catch { /* vault unavailable */ }
    }

    const memoryStore: MemoryStore = deps.memoryStore ?? new FileMemoryStore(config.polpoDir);
    const contextTrust = normalizeRuntimeContextTrustMode(
      config.contextTrust ?? deps.inject?.contextTrust,
    );
    const promptContextSegments = contextTrust === "enforce"
      ? normalizeRuntimePromptContextSegments(config.promptContextSegments)
      : [];
    const handleTranscript = (entry: Record<string, unknown>) => {
      // F1a: live subscription for streaming hosts (chat-via-executeRun). Teed
      // first, best-effort — it must never break persistence below.
      try { deps.onEvent?.(entry); } catch { /* a subscriber error can't sink the run */ }
      actLog.logTranscript(entry);
      // Persist transcript to DB when a log session is available
      if (logSession) {
        const event = entry.type === "assistant" ? "transcript:assistant"
          : entry.type === "tool_result" ? "transcript:tool_result"
          : entry.type === "tool_use" ? "transcript:tool_use"
          : `transcript:${entry.type ?? "unknown"}`;
        logSession.append({ ts: new Date().toISOString(), event, data: sanitizeTranscriptEntry(entry) })
          .catch(() => {}); // best-effort, don't block engine
      }
    };
    const onGuardrailDecision = (event: RuntimeGuardrailAuditEvent) => {
      if (guardrailDecisions.length < MAX_ACTIVITY_GUARDRAIL_DECISIONS) {
        guardrailDecisions.push(event);
      } else {
        guardrailDecisionsTruncated = true;
      }
      handleTranscript({
        type: "guardrail_decision",
        event,
      });
    };
    const configuredToolMiddleware = createConfiguredRunToolMiddleware(
      config.guardrails,
      { onDecision: onGuardrailDecision },
    );
    const runToolMiddleware = deps.runToolMiddleware
      ?? (config.guardrailMode === "audit" && configuredToolMiddleware
        ? createObservationalRunToolMiddleware(configuredToolMiddleware)
        : configuredToolMiddleware);
    const runOutputPolicy = deps.runOutputPolicy
      ?? createConfiguredRunOutputPolicy(
        config.guardrails,
        { onDecision: onGuardrailDecision },
      );

    const spawnCtx = {
      polpoDir: config.polpoDir,
      runId: config.runId,
      outputDir: config.outputDir,
      emailAllowedDomains: config.emailAllowedDomains,
      reasoning: config.reasoning,
      modelProfiles: config.modelProfiles,
      modelAllowlist: config.modelAllowlist,
      vaultStore,
      memoryStore,
      // Per-tenant gateway for the in-process host (undefined for subprocess,
      // which resolves the gateway from sandbox env).
      gatewayConfig: deps.gatewayConfig,
      contextTrust,
      promptContextSegments,
      runToolMiddleware,
      // Chat output is owned by the completion route so it can respect stream
      // buffering. Background tasks enforce here before transcript/result
      // persistence.
      runOutputPolicy: deps.inject ? undefined : runOutputPolicy,
      runOutputPolicyMode: config.guardrailMode ?? "enforce",
      // Subprocess hosts create their own fs/shell; the in-process host
      // injects the orchestrator's instances.
      fs: deps.fs ?? new NodeFileSystem(),
      shell: deps.shell ?? new NodeShell(),
      // Durable turns: resume checkpoint handed over by orphan recovery,
      // and the per-turn checkpoint sink (one RunStore write per turn,
      // best-effort — a flaky store must never fail a healthy run).
      resumeState: config.resumeState,
      // Chat injection already carries its fully assembled system prompt.
      // Task runs receive the immutable snapshot through prepareSpawn.
      runtimeContext: deps.inject ? undefined : config.runtimeContext,
      onTurnCheckpoint: async (state: LoopResumeState) => {
        try {
          await runStore.updateResumeState?.(config.runId, state);
        } catch { /* best effort */ }
      },
      // F1b: route token deltas to the streaming subscriber as {type:"text-delta"}
      // events on the SAME onEvent hook as turn events (F1a) — but via ctx.onDelta,
      // NOT onTranscript, so persistence stays turn-granularity. No-op when no
      // subscriber is attached (background hosts).
      onDelta: deps.onEvent
        ? (delta: { text: string; kind?: "text" | "reasoning" }) => {
            try {
              deps.onEvent?.({ type: delta.kind === "reasoning" ? "reasoning-delta" : "text-delta", text: delta.text });
            } catch { /* can't sink the run */ }
          }
        : undefined,
      // F1c: chat-session injection — makes the engine run a chat turn-loop
      // over pre-resolved inputs. Undefined for task runs (unchanged path).
      inject: deps.inject,
      onTranscript: handleTranscript,
    };
    handle = spawnLoopEngine(config.agent, config.task, config.cwd, spawnCtx);
    if (config.resumeState) {
      actLog.logEvent("resuming", {
        loopName: config.resumeState.loopName,
        fromTurn: (config.resumeState.turn ?? -1) + 1,
      });
    }
    // Propagate the LogStore sessionId onto the agent's activity blob so
    // the poll loop's updateActivity() persists it on every tick. Without
    // this the run record has activity.sessionId = undefined forever, and
    // downstream readers (cloud task-activity endpoint, dashboards) can't
    // resolve the transcript except via fragile time-proximity fallback.
    if (logSession) {
      handle.activity.sessionId = logSession.sessionId;
    }
    if (runToolMiddleware || runOutputPolicy) {
      handle.activity.guardrailDecisions = guardrailDecisions;
    }
    if (guardrailDecisionsTruncated) {
      handle.activity.guardrailDecisionsTruncated = true;
    }
    // Wire transcript persistence — every agent message gets written to the run log.
    // The same callback is also passed in SpawnContext so early in-process
    // events emitted before the handle is returned are not lost.
    handle.onTranscript = handleTranscript;
    actLog.logEvent("spawned");
  } catch (err) {
    const result = errorResult(err);
    actLog.logEvent("error", { message: result.stderr });
    await runStore.completeRun(config.runId, "failed", result);
    return { status: "failed", result, spawnError: true };
  }

  // Activity polling + persistent logging
  const poll = setInterval(async () => {
    try {
      await runStore.updateActivity(config.runId, handle.activity);
      actLog.logActivity({ ...handle.activity });
    } catch { /* DB temporarily locked */
    }
  }, ACTIVITY_POLL_MS);

  // Abort handler: graceful kill (SIGTERM in the subprocess host,
  // spawner.kill()/timeout in the in-process host)
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    actLog.logEvent("sigterm");
    handle.kill();
  };
  if (deps.signal?.aborted) onAbort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await handle.done;
    clearInterval(poll);
    if (handle.activity.guardrailDecisions && guardrailDecisionsTruncated) {
      handle.activity.guardrailDecisionsTruncated = true;
    }
    // Final activity + sessionId flush before marking terminal
    try { await runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logActivity({ ...handle.activity });

    // Store auto-collected outcomes on the run record
    if (handle.outcomes && handle.outcomes.length > 0) {
      try { await runStore.updateOutcomes(config.runId, handle.outcomes); } catch { /* best effort */ }
      actLog.logEvent("outcomes", { count: handle.outcomes.length, types: handle.outcomes.map((o: any) => o.type) });
    }

    // If we were aborted (timeout/shutdown/kill), force exitCode=1 regardless
    // of what the engine returned — an aborted task is not a successful task.
    if (aborted) {
      result.exitCode = 1;
      result.stderr = (result.stderr ? result.stderr + "\n" : "") + "Killed by SIGTERM (timeout or shutdown)";
    }
    const status: RunStatus = aborted ? "killed" : (result.exitCode === 0 ? "completed" : "failed");
    actLog.logEvent("done", { status, exitCode: result.exitCode, duration: result.duration });
    await runStore.completeRun(config.runId, status, result);
    return { status, result };
  } catch (err) {
    clearInterval(poll);
    try { await runStore.updateActivity(config.runId, handle.activity); } catch { /* best effort */ }
    actLog.logEvent("error", { message: err instanceof Error ? err.message : String(err) });
    const result = errorResult(err);
    await runStore.completeRun(config.runId, "failed", result);
    return { status: "failed", result };
  } finally {
    deps.signal?.removeEventListener("abort", onAbort);
  }
}
