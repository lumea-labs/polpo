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

import { watchRunState } from "@polpo-ai/core/run-state-monitor";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FileMemoryStore } from "@polpo-ai/file-stores";
import { spawnLoopEngine } from "../adapters/loop-engine.js";
import type { RunStore, RunRecord, RunStatus } from "@polpo-ai/core/run-store";
import type { LoopResumeState } from "@polpo-ai/core/loop-run-store";
import type { LogEntry } from "@polpo-ai/core/log-store";
import type { RunnerConfig, TaskResult } from "@polpo-ai/core/types";
import type { AgentHandle, ChatSessionInjection } from "@polpo-ai/core/adapter";
import {
  InMemorySteeringController,
  type SteeringController,
} from "@polpo-ai/core/steering";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";
import { sanitizeTranscriptEntry } from "../server/security.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "@polpo-ai/core/vault-store";
import type { MemoryStore } from "@polpo-ai/core/memory-store";
import {
  createToolInvocationContext,
  normalizeRuntimeMetadata,
  normalizeAgentIdentity,
  AgentIdentityError,
  normalizeRuntimePromptContextSegments,
  normalizeRuntimeContextTrustMode,
} from "@polpo-ai/core";
import {
  GuardrailBlockedError,
  createConfiguredRunPreflightPolicy,
  createConfiguredRunOutputPolicy,
  createConfiguredRunToolMiddleware,
  createObservationalRunToolMiddleware,
  type RunOutputPolicy,
  type RunPreflightPolicy,
  type RunToolMiddleware,
  type RuntimeGuardrailAuditEvent,
} from "@polpo-ai/core/guardrails";
import type {
  BrainReadService,
  BrainServiceContext,
} from "@polpo-ai/core/brain";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import { createLocalBrainRuntime } from "../brain/local-runtime.js";
import {
  ALL_BRAIN_TOOL_NAMES,
  matchToolPattern,
} from "@polpo-ai/tools";

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
  /** Null explicitly disables environment/local Data fallback for a host-bound runner. */
  data?: import("@polpo-ai/core/data").DataClient | null;
  /** Run persistence. NOT closed by executeRun — the host owns it. */
  runStore: RunStore;
  /**
   * Per-run transcript session factory (DB storage modes). Undefined = file
   * mode: the JSONL activity log is the only transcript side-channel,
   * matching the historical subprocess behavior.
   */
  createLogSession?: (context: { signal: AbortSignal }) => Promise<TranscriptSession>;
  /** Vault store. Default: EncryptedVaultStore(polpoDir), best-effort. */
  vaultStore?: VaultStore;
  /** Memory store. Default: FileMemoryStore(polpoDir). */
  memoryStore?: MemoryStore;
  /** Typed Memory store. Default: FileMemoryItemStore(polpoDir). */
  memoryItemStore?: import("@polpo-ai/core").MemoryItemStore;
  /** Scoped Brain reader. Must be supplied together with brainContext. */
  brainService?: BrainReadService;
  /** Host-resolved Brain actor and scopes. Must accompany brainService. */
  brainContext?: BrainServiceContext;
  /** FileSystem for tools. Default: a fresh NodeFileSystem. */
  fs?: FileSystem;
  /** Shell for tools. Default: a fresh NodeShell. */
  shell?: Shell;
  /** Optional host checkpoint for manually managed hydrated sandbox volumes. */
  checkpointSandboxVolume?: (name?: string) => Promise<void>;
  /** Host-owned resolver for strict logical Connection slots. */
  connectionCapabilityResolver?: import("@polpo-ai/core").ConnectionCapabilityResolver;
  resolveCustomTools?: import("@polpo-ai/core").ResolveCustomTools;
  resolveMcpCapabilities?: import("@polpo-ai/core").ResolveMcpRuntimeCapabilities;
  /** Finalize run-scoped host resources before terminal persistence. */
  finalize?: () => Promise<void>;
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
  /** Optional host-resolved input/context/model guardrail policy. */
  runPreflightPolicy?: RunPreflightPolicy;
  /** Pid recorded on the run record: process.pid (subprocess) or a synthetic negative id (in-process). */
  pid: number;
  /** Where the config was persisted ("file:///path", "db://runId", "memory://…"). */
  configPath: string;
  /** Abort = graceful kill (subprocess SIGTERM / in-process spawner.kill). */
  signal?: AbortSignal;
  /** Deadline for initial preparation/preflight only (default 30 seconds).
   * Requests cancellation; pending non-cooperative I/O remains owned and awaited.
   * Hosts must adopt resources inside callbacks before returning them. */
  preparationTimeoutMs?: number;
  /**
   * Run-scoped steering controller. Hosts expose ingress; executeRun consumes
   * it at model/tool safe points. A local controller is restored from a
   * durable checkpoint when the host does not provide one.
   */
  steering?: SteeringController;
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

/** A stalled persistence lookup must not prevent local owner cleanup. */
async function boundedRunPersistence<T>(work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Run persistence timed out")), 5000);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}

function requestsBrainTools(allowedTools: readonly string[] | undefined): boolean {
  if (!allowedTools?.length) return false;
  return allowedTools.some((pattern) =>
    ALL_BRAIN_TOOL_NAMES.some((toolName) =>
      matchToolPattern(pattern, toolName),
    ),
  );
}

/**
 * Execute one agent run end-to-end against the injected stores.
 * See module header for the host contract.
 */
export async function executeRun(config: RunnerConfig, deps: ExecuteRunDeps): Promise<ExecuteRunOutcome> {
  const abort = new AbortController();
  const steering = deps.steering ?? new InMemorySteeringController({ delivery: config.resumeState?.steering?.delivery });
  const onSteeringStop = () => abort.abort(steering.signal.reason);
  if (steering.signal.aborted) onSteeringStop();
  else steering.signal.addEventListener("abort", onSteeringStop, { once: true });
  const onHostAbort = () => abort.abort(deps.signal?.reason);
  if (deps.signal?.aborted) onHostAbort();
  else deps.signal?.addEventListener("abort", onHostAbort, { once: true });
  const timeoutMs = deps.preparationTimeoutMs ?? 30_000;
  const validTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300_000;
  const preparationDeadline = validTimeout
    ? setTimeout(() => abort.abort(new Error("Run preparation timed out")), timeoutMs)
    : undefined;
  preparationDeadline?.unref?.();
  const finishPreparation = () => clearTimeout(preparationDeadline);
  let monitor: ReturnType<typeof watchRunState> | undefined;
  const onPersistedStop = () => abort.abort(monitor?.signal.reason);
  try {
    return await executeRegisteredRun(config, { ...deps, steering, signal: abort.signal }, () => {
      if (monitor) return;
      monitor = watchRunState({ runId: config.runId, runStore: deps.runStore });
      monitor.signal.addEventListener("abort", onPersistedStop, { once: true });
    }, finishPreparation);
  } finally {
    finishPreparation();
    monitor?.dispose();
    monitor?.signal.removeEventListener("abort", onPersistedStop);
    deps.signal?.removeEventListener("abort", onHostAbort);
    steering.signal.removeEventListener("abort", onSteeringStop);
  }
}

async function executeRegisteredRun(
  config: RunnerConfig, deps: ExecuteRunDeps, observe: () => void, finishPreparation: () => void,
): Promise<ExecuteRunOutcome> {
  let finalization: Promise<void> | undefined;
  const finalize = (): Promise<void> => finalization ??= Promise.resolve().then(() => deps.finalize?.());
  const { runStore, pid, configPath } = deps;
  const readRun = () => boundedRunPersistence(() => runStore.getRun(config.runId));
  const persistOutcome = async (status: RunStatus, result: TaskResult, spawnError = false): Promise<ExecuteRunOutcome> => {
    // An error or timeout can occur after a successful commit. Always confirm
    // against durable state, including a cancellation committed by another host.
    try { await boundedRunPersistence(() => runStore.completeRun(config.runId, status, result)); } catch { /* read below */ }
    try {
      const persisted = await readRun();
      if (!persisted || persisted.status === "running") throw new Error("Unconfirmed run outcome");
      return { status: persisted.status, result: persisted.result ?? result,
        ...(spawnError && persisted.status === "failed" ? { spawnError: true } : {}) };
    } catch {
      // No success can be inferred from a local result if its authoritative row
      // disappeared or persistence is unavailable. Never recreate a missing Run.
      return { status: "failed", result: errorResult(new Error("Run outcome was not confirmed by persistence")),
        ...(spawnError ? { spawnError: true } : {}) };
    }
  };
  const actLog = new RunActivityLog(config.polpoDir, config.runId, config.taskId, config.agent.name, pid);
  const steering: SteeringController = deps.steering!;
  const checkPreparation = () => {
    deps.signal?.throwIfAborted();
    steering.signal.throwIfAborted();
  };
  let logSession: TranscriptSession | undefined;
  let correlatedSessionId = deps.inject?.sessionId;
  const now = new Date().toISOString();
  const initialRecord: RunRecord = {
    id: config.runId,
    taskId: config.taskId,
    pid,
    agentName: config.agent.name,
    ...(correlatedSessionId ? { sessionId: correlatedSessionId } : {}),
    status: "running",
    startedAt: now,
    updatedAt: now,
    // sessionId starts at the transcript session or injected conversation, so
    // the run record is linked to its activity from the very first poll.
    // Without this, downstream readers (the cloud task-activity endpoint,
    // a future dashboard, anything that joins runs to log sessions) have
    // to guess by time-proximity — fragile on cold sandboxes where the
    // log session is created hundreds of ms before the first stream
    // chunk lands. In file mode this is mostly cosmetic because
    // RunActivityLog writes a parallel JSONL side-channel; in DB mode
    // (cloud) it's the only link that ever gets persisted.
    activity: {
      filesCreated: [], filesEdited: [], toolCalls: 0, totalTokens: 0, lastUpdate: now,
      ...(correlatedSessionId ? { sessionId: correlatedSessionId } : {}),
    },
    configPath,
    engine: "agent",
    delivery: deps.inject ? "stream" : "background",
  };
  let handle: AgentHandle;
  const guardrailDecisions: RuntimeGuardrailAuditEvent[] = [];
  let guardrailDecisionsTruncated = false;
  const stopBeforeSpawn = async (): Promise<ExecuteRunOutcome | undefined> => {
    let current = await readRun();
    if (!current) throw new Error("Run record is unavailable before execution");
    if (current.status === "running" && !deps.signal?.aborted && !steering.signal.aborted) return;
    finishPreparation();
    await finalize();
    steering.close();
    if (current.status === "running") {
      actLog.logEvent("sigterm");
      await boundedRunPersistence(() => runStore.completeRun(config.runId, "killed", errorResult(new Error("Killed by SIGTERM (timeout or shutdown) before engine start"))));
      current = await readRun();
      if (!current || current.status === "running") throw new Error("Run cancellation was not persisted");
    }
    return { status: current.status, result: current.result ?? {
      exitCode: current.status === "completed" ? 0 : 1, stdout: "", stderr: "", duration: 0,
    } };
  };
  try {
    const preparationTimeoutMs = deps.preparationTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(preparationTimeoutMs) || preparationTimeoutMs < 1 || preparationTimeoutMs > 300_000) {
      throw new Error("Run preparation requires a bounded positive deadline");
    }
    checkPreparation();
    // TaskRunner already owns a durable Run. Observe it before initial log or
    // steering I/O. A fresh file-mode run has no row yet, so start its observer
    // only after registration; missing rows are never given grace afterwards.
    const existing = await readRun();
    checkPreparation();
    if (existing) {
      observe();
      const stoppedBeforePreparation = await stopBeforeSpawn();
      if (stoppedBeforePreparation) return stoppedBeforePreparation;
    }
    if (config.resumeState?.steering) {
      await steering.restore(config.resumeState.steering, { signal: deps.signal! });
      checkPreparation();
    }
    if (deps.createLogSession) {
      // Do not race this promise against abort: the host may still allocate a
      // session/resource. Its finalizer retains ownership until it settles.
      logSession = await deps.createLogSession({ signal: deps.signal! });
      checkPreparation();
    }
    correlatedSessionId = logSession?.sessionId ?? deps.inject?.sessionId;
    if (correlatedSessionId) {
      initialRecord.sessionId = correlatedSessionId;
      initialRecord.activity.sessionId = correlatedSessionId;
    }
    if (existing) {
      const stoppedBeforeRegistration = await stopBeforeSpawn();
      if (stoppedBeforeRegistration) return stoppedBeforeRegistration;
    }
    checkPreparation();
    // Keep an uncertain/late commit owned until it settles. Never retry this
    // registration after lost acknowledgement or cancellation.
    await runStore.upsertRun(initialRecord);
    observe();
    checkPreparation();
    actLog.logEvent("spawning", { task: config.task.title });
    const stoppedAtRegistration = await stopBeforeSpawn();
    if (stoppedAtRegistration) return stoppedAtRegistration;
    const agentIdentity = config.agentIdentity === undefined ? undefined : normalizeAgentIdentity(config.agentIdentity);
    if ((agentIdentity && agentIdentity.name !== config.agent.name)
      || (config.toolInvocation?.agent && (config.toolInvocation.agent.name !== agentIdentity?.name
        || config.toolInvocation.agent.incarnation !== agentIdentity?.incarnation))) throw new AgentIdentityError();
    // Snapshot host-owned identity before any content guardrail can rewrite it.
    const toolInvocation = config.toolInvocation ? createToolInvocationContext({
      ...config.toolInvocation,
      metadata: { ...config.toolInvocation.metadata },
      ...(agentIdentity ? { agent: agentIdentity } : {}),
    }) : createToolInvocationContext({
      ...(agentIdentity ? { agent: agentIdentity } : {}),
      requestId: config.runId,
      runId: config.runId,
      ...(correlatedSessionId ? { sessionId: correlatedSessionId } : {}),
      ...(config.task.user ? { user: config.task.user } : {}),
      metadata: normalizeRuntimeMetadata(config.task.metadata) ?? {},
      surface: "task",
    });
    // Use the injected vault store when available (postgres/sqlite or
    // orchestrator-owned), fall back to file-based
    let vaultStore: VaultStore | undefined = deps.vaultStore;
    if (!vaultStore) {
      try { vaultStore = new EncryptedVaultStore(config.polpoDir); } catch { /* vault unavailable */ }
    }

    const memoryStore: MemoryStore = deps.memoryStore ?? new FileMemoryStore(config.polpoDir);
    const { FileMemoryItemStore } = await import("@polpo-ai/file-stores");
    checkPreparation();
    const memoryItemStore = deps.memoryItemStore
      ?? new FileMemoryItemStore(config.polpoDir);
    const contextTrust = normalizeRuntimeContextTrustMode(
      config.contextTrust ?? deps.inject?.contextTrust,
    );
    let promptContextSegments = contextTrust === "enforce"
      ? normalizeRuntimePromptContextSegments(config.promptContextSegments)
      : [];
    let guardedAgent = config.agent;
    let guardedTask = config.task;
    let guardedRuntimeContext = config.runtimeContext;
    if ((deps.brainService === undefined) !== (deps.brainContext === undefined)) {
      throw new Error(
        "brainService and brainContext must be provided together",
      );
    }
    const localBrain = deps.brainService || !requestsBrainTools(config.agent.allowedTools)
      ? undefined
      : createLocalBrainRuntime({
          workDir: config.cwd,
          polpoDir: config.polpoDir,
        });
    const brainService = deps.brainService ?? localBrain?.service;
    const brainContext = deps.brainContext ?? localBrain?.context({
        actor: "agent",
        actorId: config.agent.name,
        agentName: config.agent.name,
        ...(config.task.user
          ? { externalUserId: config.task.user }
          : {}),
      });
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
    const runPreflightPolicy = deps.runPreflightPolicy
      ?? createConfiguredRunPreflightPolicy(
        config.guardrails,
        { onDecision: onGuardrailDecision },
      );
    if (runPreflightPolicy && !deps.inject) {
      const mode = config.guardrailMode ?? "enforce";
      const context = {
        runId: config.runId,
        agent: config.agent.name,
        surface: "task" as const,
        source: "task" as const,
        ...(config.task.user
          ? { metadata: { externalUserId: config.task.user } }
          : {}),
      };
      const guardedInput = await runPreflightPolicy.evaluate({
        phase: "input",
        value: guardedTask,
        mode,
        context,
        signal: deps.signal,
      });
      if (
        !guardedInput.value
        || typeof guardedInput.value !== "object"
        || guardedInput.value.id !== config.task.id
      ) {
        throw new GuardrailBlockedError(
          "Guardrail rewrote task identity during preflight",
          guardedInput.decisions,
        );
      }
      checkPreparation();
      guardedTask = guardedInput.value;

      const guardedContext = await runPreflightPolicy.evaluate({
        phase: "context",
        value: {
          promptContextSegments,
          runtimeContext: guardedRuntimeContext,
        },
        mode,
        context,
        signal: deps.signal,
      });
      if (!guardedContext.value || typeof guardedContext.value !== "object") {
        throw new GuardrailBlockedError(
          "Guardrail rewrote task context to an invalid value",
          guardedContext.decisions,
        );
      }
      checkPreparation();
      promptContextSegments = normalizeRuntimePromptContextSegments(
        guardedContext.value.promptContextSegments,
      );
      guardedRuntimeContext = guardedContext.value.runtimeContext;

      const guardedModelInput = await runPreflightPolicy.evaluate({
        phase: "model.preflight",
        value: {
          agent: guardedAgent,
          task: guardedTask,
          promptContextSegments,
          runtimeContext: guardedRuntimeContext,
        },
        mode,
        context,
        signal: deps.signal,
      });
      if (
        !guardedModelInput.value
        || typeof guardedModelInput.value !== "object"
        || !guardedModelInput.value.agent
        || typeof guardedModelInput.value.agent !== "object"
        || guardedModelInput.value.agent.name !== config.agent.name
        || !guardedModelInput.value.task
        || typeof guardedModelInput.value.task !== "object"
        || guardedModelInput.value.task.id !== config.task.id
      ) {
        throw new GuardrailBlockedError(
          "Guardrail rewrote run identity during model preflight",
          guardedModelInput.decisions,
        );
      }
      checkPreparation();
      guardedAgent = guardedModelInput.value.agent;
      guardedTask = guardedModelInput.value.task;
      promptContextSegments = normalizeRuntimePromptContextSegments(
        guardedModelInput.value.promptContextSegments,
      );
      guardedRuntimeContext = guardedModelInput.value.runtimeContext;
    }
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
      toolInvocation,
      outputDir: config.outputDir,
      emailAllowedDomains: config.emailAllowedDomains,
      reasoning: config.reasoning,
      modelProfiles: config.modelProfiles,
      modelAllowlist: config.modelAllowlist,
      vaultStore,
      memoryStore,
      memoryItemStore,
      brainService,
      brainContext,
      data: deps.data === undefined
        ? (await import("../data/index.js")).runnerDataClient(config.polpoDir, config.agent.name)
        : deps.data ?? undefined,
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
      checkpointSandboxVolume: deps.checkpointSandboxVolume,
      connectionCapabilityResolver: deps.connectionCapabilityResolver,
      resolveCustomTools: deps.resolveCustomTools,
      resolveMcpCapabilities: deps.resolveMcpCapabilities,
      // Durable turns: resume checkpoint handed over by orphan recovery,
      // and the per-turn checkpoint sink (one RunStore write per turn,
      // best-effort — a flaky store must never fail a healthy run).
      resumeState: config.resumeState,
      steering,
      // Chat injection already carries its fully assembled system prompt.
      // Task runs receive the immutable snapshot through prepareSpawn.
      runtimeContext: deps.inject ? undefined : guardedRuntimeContext,
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
        ? (delta: { text: string; kind?: "text" | "reasoning" | "structured" | "structured-reset" }) => {
            try {
              const type = delta.kind === "reasoning"
                ? "reasoning-delta"
                : delta.kind === "structured"
                  ? "structured-delta"
                  : delta.kind === "structured-reset"
                    ? "structured-reset"
                    : "text-delta";
              deps.onEvent?.({ type, text: delta.text });
            } catch { /* can't sink the run */ }
          }
        : undefined,
      // F1c: chat-session injection — makes the engine run a chat turn-loop
      // over pre-resolved inputs. Undefined for task runs (unchanged path).
      inject: deps.inject,
      onTranscript: handleTranscript,
    };
    // Preflight and host preparation can await network work. Recheck after
    // those waits, before creating model/tool capabilities for this run.
    const stoppedAfterPreparation = await stopBeforeSpawn();
    if (stoppedAfterPreparation) return stoppedAfterPreparation;
    checkPreparation();
    handle = spawnLoopEngine(guardedAgent, guardedTask, config.cwd, spawnCtx);
    finishPreparation();
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
    if (correlatedSessionId) {
      handle.activity.sessionId = correlatedSessionId;
    }
    if (runPreflightPolicy || runToolMiddleware || runOutputPolicy) {
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
    finishPreparation();
    const result = errorResult(err);
    actLog.logEvent("error", { message: result.stderr });
    if (guardrailDecisions.length > 0) {
      try {
        await boundedRunPersistence(() => runStore.updateActivity(config.runId, {
          ...initialRecord.activity,
          guardrailDecisions,
          ...(guardrailDecisionsTruncated
            ? { guardrailDecisionsTruncated: true }
            : {}),
        }));
      } catch {
        // The runtime failure remains authoritative when audit persistence fails.
      }
    }
    try { await finalize(); } catch { /* preserve the primary spawn error */ }
    const requestedStatus = deps.signal?.aborted || steering.signal.aborted ? "killed" : "failed";
    steering.close();
    return persistOutcome(requestedStatus, result, true);
  }

  // Activity polling + persistent logging
  const poll = setInterval(async () => {
    try {
      await boundedRunPersistence(() => runStore.updateActivity(config.runId, handle.activity));
      actLog.logActivity({ ...handle.activity });
    } catch { /* DB temporarily locked */
    }
  }, ACTIVITY_POLL_MS);

  // Abort handler: graceful kill (SIGTERM in the subprocess host,
  // spawner.kill()/timeout in the in-process host)
  let aborted = false;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    actLog.logEvent("sigterm");
    handle.kill();
  };
  if (deps.signal?.aborted) onAbort();
  else deps.signal?.addEventListener("abort", onAbort, { once: true });
  const onSteeringAbort = () => onAbort();
  if (steering?.signal.aborted) onSteeringAbort();
  else steering?.signal.addEventListener("abort", onSteeringAbort, { once: true });

  try {
    const result = await handle.done;
    clearInterval(poll);
    if (handle.activity.guardrailDecisions && guardrailDecisionsTruncated) {
      handle.activity.guardrailDecisionsTruncated = true;
    }
    // Final activity + sessionId flush before marking terminal
    try { await boundedRunPersistence(() => runStore.updateActivity(config.runId, handle.activity)); } catch { /* best effort */ }
    actLog.logActivity({ ...handle.activity });

    // Store auto-collected outcomes on the run record
    if (handle.outcomes && handle.outcomes.length > 0) {
      try { await boundedRunPersistence(() => runStore.updateOutcomes(config.runId, handle.outcomes!)); } catch { /* best effort */ }
      actLog.logEvent("outcomes", { count: handle.outcomes.length, types: handle.outcomes.map((o: any) => o.type) });
    }

    // If we were aborted (timeout/shutdown/kill), force exitCode=1 regardless
    // of what the engine returned — an aborted task is not a successful task.
    if (aborted) {
      result.exitCode = 1;
      result.stderr = (result.stderr ? result.stderr + "\n" : "") + "Killed by SIGTERM (timeout or shutdown)";
    }
    await finalize();
    const status: RunStatus = aborted ? "killed" : (result.exitCode === 0 ? "completed" : "failed");
    actLog.logEvent("done", { status, exitCode: result.exitCode, duration: result.duration });
    return await persistOutcome(status, result);
  } catch (err) {
    clearInterval(poll);
    try { await finalize(); } catch (finalizeError) {
      if (!(err instanceof Error)) err = finalizeError;
    }
    try { await boundedRunPersistence(() => runStore.updateActivity(config.runId, handle.activity)); } catch { /* best effort */ }
    actLog.logEvent("error", { message: err instanceof Error ? err.message : String(err) });
    const result = errorResult(err);
    const requestedStatus = aborted ? "killed" : "failed";
    return await persistOutcome(requestedStatus, result);
  } finally {
    try { await finalize(); } catch { /* the terminal result already captured finalization */ }
    deps.signal?.removeEventListener("abort", onAbort);
    steering?.signal.removeEventListener("abort", onSteeringAbort);
    steering?.close();
  }
}
