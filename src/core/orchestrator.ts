import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { getPolpoDir } from "./constants.js";
import { parseConfig, loadPolpoConfig, savePolpoConfig, loadEnvFile } from "./config.js";
import { findLogForTask, buildExecutionSummary } from "../assessment/transcript-parser.js";
import { FileTaskStore } from "../stores/file-task-store.js";
import { FileRunStore } from "../stores/file-run-store.js";
import { FileMemoryStore } from "../stores/file-memory-store.js";
import { FileLogStore } from "../stores/file-log-store.js";
import { FileSessionStore } from "../stores/file-session-store.js";
import type { SessionStore } from "./session-store.js";
import type { MemoryStore } from "./memory-store.js";
import type { LogStore } from "./log-store.js";
import { assessTask } from "../assessment/assessor.js";
import { analyzeBlockedTasks, resolveDeadlock, isResolving } from "./deadlock-resolver.js";
import { OrchestratorEngine } from "@polpo-ai/core";
import type { DeadlockResolverPort, DeadlockFacade } from "@polpo-ai/core";
import { TypedEmitter } from "./events.js";
import type { TaskStore } from "./task-store.js";
import type { RunStore } from "./run-store.js";
import type {
  PolpoConfig,
  AgentConfig,
  Task,
  TaskResult,
  TaskExpectation,
  ExpectedOutcome,
  Team,
  Mission,
  MissionStatus,
  RetryPolicy,
  ScopedNotificationRules,
} from "./types.js";
import { AgentManager } from "./agent-manager.js";
import { TaskManager } from "./task-manager.js";
import { MissionExecutor } from "./mission-executor.js";
import { TaskRunner } from "./task-runner.js";
import { AssessmentOrchestrator } from "./assessment-orchestrator.js";
import type { OrchestratorContext } from "./orchestrator-context.js";
import {
  buildFixPrompt,
  buildRetryPrompt,
  sleep,
} from "./assessment-prompts.js";
import type { AssessFn } from "./orchestrator-context.js";
import { setProviderOverrides, validateProviderKeys, setModelAllowlist } from "../llm/pi-client.js";
import type { GatewayConfig } from "@polpo-ai/llm";
import { HookRegistry } from "./hooks.js";
import { ApprovalManager } from "./approval-manager.js";
import { FileApprovalStore } from "../stores/file-approval-store.js";
import { FileTeamStore } from "../stores/file-team-store.js";
import { FileAgentStore } from "../stores/file-agent-store.js";
import type { TeamStore } from "./team-store.js";
import type { AgentStore } from "./agent-store.js";
import { EscalationManager } from "./escalation-manager.js";
import { SLAMonitor } from "../quality/sla-monitor.js";
import { QualityController } from "../quality/quality-controller.js";
import { Scheduler } from "../scheduling/scheduler.js";
import { TaskWatcherManager } from "./task-watcher.js";
import type { ApprovalRequest, ApprovalStatus, NotificationAction } from "./types.js";
import { EncryptedVaultStore } from "../vault/encrypted-store.js";
import type { VaultStore } from "./vault-store.js";
import type { PlaybookStore } from "./playbook-store.js";
import { FilePlaybookStore } from "../stores/file-playbook-store.js";
import { NodeSpawner } from "../adapters/node-spawner.js";
import type { Spawner } from "./spawner.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import type { Shell } from "@polpo-ai/core/shell";

// Re-export for backward compatibility (consumed by core/index.ts and external modules)
export { buildFixPrompt, buildRetryPrompt };
export type { AssessFn };

export interface OrchestratorOptions {
  workDir?: string;
  store?: TaskStore;
  runStore?: RunStore;
  assessFn?: AssessFn;
  spawner?: Spawner;
}

export class Orchestrator extends TypedEmitter {
  private registry!: TaskStore;
  private runStore!: RunStore;
  private config!: PolpoConfig;
  private polpoDir: string;
  private workDir: string;
  /** Cached resolved agent working directory (invalidated on config reload). */
  private cachedAgentWorkDir: string | null = null;
  private interactive = false;
  private stopped = false;
  private assessFn: AssessFn;
  private spawner: Spawner;
  private injectedStore?: TaskStore;
  private injectedRunStore?: RunStore;
  private memoryStore!: MemoryStore;
  private logStore!: LogStore;
  private sessionStore!: SessionStore;
  private hookRegistry = new HookRegistry();
  private approvalMgr?: ApprovalManager;
  private escalationMgr?: EscalationManager;
  private slaMonitor?: SLAMonitor;
  private qualityController?: QualityController;
  private scheduler?: Scheduler;
  private watcherMgr?: TaskWatcherManager;
  private teamStore!: TeamStore;
  private agentStore!: AgentStore;
  private configWatcher?: FSWatcher;
  private configReloadTimer?: ReturnType<typeof setTimeout>;
  private vaultStore?: VaultStore;
  private playbookStore!: PlaybookStore;
  private fs: FileSystem;
  private shell: Shell;
  private gatewayConfig: GatewayConfig | undefined;

  // Managers
  private agentMgr!: AgentManager;
  private taskMgr!: TaskManager;
  private missionExec!: MissionExecutor;
  private runner!: TaskRunner;
  private assessor!: AssessmentOrchestrator;

  // Pure orchestration engine (delegates tick, run, and all pure-logic methods)
  private engine!: OrchestratorEngine;

  getWorkDir(): string { return this.workDir; }
  getAgentWorkDir(): string {
    if (!this.cachedAgentWorkDir) {
      this.cachedAgentWorkDir = this.resolveAgentWorkDir();
    }
    return this.cachedAgentWorkDir;
  }
  getHooks(): HookRegistry { return this.hookRegistry; }
  getSLAMonitor(): SLAMonitor | undefined { return this.slaMonitor; }
  getQualityController(): QualityController | undefined { return this.qualityController; }
  getScheduler(): Scheduler | undefined { return this.scheduler; }
  getWatcherManager(): TaskWatcherManager | undefined { return this.watcherMgr; }

  /** Re-point the orchestrator at a different project directory (before init). */
  resetWorkDir(newWorkDir: string): void {
    this.workDir = resolve(newWorkDir);
    this.polpoDir = getPolpoDir(this.workDir);
    this.cachedAgentWorkDir = null;
  }

  constructor(workDirOrOptions?: string | OrchestratorOptions) {
    super();
    // Centralized fs/shell creation — the ONE place that creates Node.js defaults.
    // Everything downstream receives these via getters or SpawnContext.
    this.fs = new NodeFileSystem();
    this.shell = new NodeShell();
    if (typeof workDirOrOptions === "string" || workDirOrOptions === undefined) {
      const workDir = workDirOrOptions ?? ".";
      this.workDir = resolve(workDir);
      this.polpoDir = getPolpoDir(this.workDir);
      this.assessFn = assessTask;
      this.spawner = new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
    } else {
      const opts = workDirOrOptions;
      this.workDir = resolve(opts.workDir ?? ".");
      this.polpoDir = getPolpoDir(this.workDir);
      this.assessFn = opts.assessFn ?? assessTask;
      this.injectedStore = opts.store;
      this.injectedRunStore = opts.runStore;
      this.spawner = opts.spawner ?? new NodeSpawner({ polpoDir: this.polpoDir, cwd: this.workDir });
    }
  }

  /** Drizzle store bundle — populated when storage is "sqlite" or "postgres". */
  private drizzleStores?: import("@polpo-ai/drizzle").DrizzleStores;

  /** Create task + run stores based on the configured storage backend. */
  private async createStores(storage?: "file" | "sqlite" | "postgres", databaseUrl?: string): Promise<{
    task: TaskStore; run: RunStore;
    logStore?: LogStore; sessionStore?: SessionStore; memoryStore?: MemoryStore;
  }> {
    if (storage === "postgres") {
      const dbUrl = databaseUrl ?? this.config?.settings?.databaseUrl;
      if (!dbUrl) throw new Error('storage: "postgres" requires a databaseUrl');
      const { createPgStores, ensurePgSchema } = await import("@polpo-ai/drizzle");
      const postgres = (await import("postgres")).default;
      const { drizzle } = await import("drizzle-orm/postgres-js");
      const sql = postgres(dbUrl);
      const db = drizzle(sql);
      await ensurePgSchema(db);
      this.drizzleStores = createPgStores(db);
      return {
        task: this.drizzleStores.taskStore,
        run: this.drizzleStores.runStore,
        logStore: this.drizzleStores.logStore,
        sessionStore: this.drizzleStores.sessionStore,
        memoryStore: this.drizzleStores.memoryStore,
      };
    }
    if (storage === "sqlite") {
      const { createSqliteStores } = await import("@polpo-ai/drizzle");
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3");
      const dbPath = join(this.polpoDir, "state.db");
      const sqlite = new Database(dbPath);
      sqlite.exec("PRAGMA journal_mode = WAL");
      sqlite.exec("PRAGMA synchronous = NORMAL");
      sqlite.exec("PRAGMA foreign_keys = ON");
      const { ensureSqliteSchema } = await import("./drizzle-sqlite-schema.js");
      ensureSqliteSchema(sqlite);
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const db = drizzle(sqlite);
      this.drizzleStores = createSqliteStores(db);
      return {
        task: this.drizzleStores.taskStore,
        run: this.drizzleStores.runStore,
        logStore: this.drizzleStores.logStore,
        sessionStore: this.drizzleStores.sessionStore,
        memoryStore: this.drizzleStores.memoryStore,
      };
    }
    return {
      task: new FileTaskStore(this.polpoDir),
      run: new FileRunStore(this.polpoDir),
    };
  }

  async init(): Promise<void> {
    this.config = await parseConfig(this.workDir);

    // Apply provider overrides from config
    if (this.config.providers) {
      setProviderOverrides(this.config.providers);
    }

    // Apply model allowlist from settings
    if (this.config.settings.modelAllowlist) {
      setModelAllowlist(this.config.settings.modelAllowlist);
    }

    // Configure LLM gateway from settings
    const gatewaySettings = this.config.settings.gateway;
    if (gatewaySettings) {
      this.gatewayConfig = {
        url: gatewaySettings.url,
        apiKey: gatewaySettings.apiKeyEnv ? process.env[gatewaySettings.apiKeyEnv] : undefined,
        headers: gatewaySettings.headers,
      };
    }

    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(this.config.settings.storage, this.config.settings.databaseUrl);
    this.registry = stores.task;
    this.runStore = stores.run;

    // When storage is "postgres", Drizzle provides all stores; otherwise use file-based defaults
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.memoryStore = ("memoryStore" in stores && stores.memoryStore)
      ? stores.memoryStore
      : new FileMemoryStore(this.polpoDir);

    // Team & Agent stores — Drizzle when available, otherwise file-based
    this.teamStore = this.drizzleStores?.teamStore ?? new FileTeamStore(this.polpoDir);
    this.agentStore = this.drizzleStores?.agentStore ?? new FileAgentStore(this.polpoDir);

    // Validate API keys (after stores are available so we can read per-agent models)
    await this.validateProviders();

    await this.initManagers();

    // Sync config.teams from stores (authoritative source — agents.json / teams.json)
    await this.agentMgr.syncConfigCache();

    this.initVaultStore();
    this.playbookStore = this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir);
  }

  /**
   * Populate stores from the teams array passed to initInteractive().
   * Idempotent — skips teams/agents that already exist in the store.
   */
  private async populateStores(teams: Team[]): Promise<void> {
    if (!teams || teams.length === 0) return;

    await this.teamStore.seed(teams);

    const agentsToSeed: Array<AgentConfig & { teamName: string }> = [];
    for (const team of teams) {
      for (const agent of team.agents) {
        agentsToSeed.push({ ...agent, teamName: team.name });
      }
    }
    if (agentsToSeed.length > 0) {
      await this.agentStore.seed(agentsToSeed);
    }
  }

  private async validateProviders(): Promise<void> {
    const modelSpecs: string[] = [];
    // Default model
    if (process.env.POLPO_MODEL) modelSpecs.push(process.env.POLPO_MODEL);
    // Orchestrator model
    if (this.config.settings.orchestratorModel) {
      const om = this.config.settings.orchestratorModel;
      if (typeof om === "string") {
        modelSpecs.push(om);
      } else {
        if (om.primary) modelSpecs.push(om.primary);
        if (om.fallbacks) modelSpecs.push(...om.fallbacks);
      }
    }
    // Judge model
    if (process.env.POLPO_JUDGE_MODEL) modelSpecs.push(process.env.POLPO_JUDGE_MODEL);
    // Per-agent models (from AgentStore, not config)
    const agents = await this.agentStore.getAgents();
    for (const agent of agents) {
      if (agent.model) modelSpecs.push(agent.model);
    }

    if (modelSpecs.length === 0) {
      this.emit("log", {
        level: "warn",
        message: "No model configured for any agent. Agent spawning will fail. Set a model in .polpo/polpo.json (`settings.orchestratorModel`) or on the agent (`model` field), and set the provider API key env var.",
      });
      return;
    }

    const missing = validateProviderKeys(modelSpecs);
    if (missing.length > 0) {
      const details = missing
        .map(m => `  - ${m.provider} (model: ${m.modelSpec})`)
        .join("\n");
      this.emit("log", {
        level: "warn",
        message: `Missing API keys for providers:\n${details}\nSet the corresponding environment variables in your shell or .polpo/.env.`,
      });
    }
  }

  /** Resolve the directory where agent processes will run (settings.workDir relative to project root). */
  private resolveAgentWorkDir(): string {
    const settingsWorkDir = this.config.settings.workDir;
    if (!settingsWorkDir || settingsWorkDir === ".") return this.workDir;
    const resolved = resolve(this.workDir, settingsWorkDir);
    if (!existsSync(resolved)) mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  /** Build the shared OrchestratorContext used by all managers. */
  private buildContext(): OrchestratorContext {
    return {
      emitter: this,
      registry: this.registry,
      runStore: this.runStore,
      memoryStore: this.memoryStore,
      logStore: this.logStore,
      sessionStore: this.sessionStore,
      teamStore: this.teamStore,
      agentStore: this.agentStore,
      hooks: this.hookRegistry,
      config: this.config,
      workDir: this.workDir,
      agentWorkDir: this.getAgentWorkDir(),
      polpoDir: this.polpoDir,
      assessFn: this.assessFn,
      spawner: this.spawner,

      // Shell-specific ports (Node.js implementations)
      killProcess: (pid, signal) => { try { process.kill(pid, (signal ?? "SIGTERM") as NodeJS.Signals); } catch { /* already dead */ } },
      loadConfig: () => loadPolpoConfig(this.polpoDir),
      saveConfig: (config) => savePolpoConfig(this.polpoDir, config),
      queryLLM: async (prompt, model) => {
        const { queryText, queryTextWithFallback, resolveModelSpec, estimateCost } = await import("../llm/pi-client.js");
        const { withRetry } = await import("../llm/retry.js");
        // If ModelConfig with fallbacks, use fallback-aware query
        if (model && typeof model === "object" && (model as any).fallbacks?.length > 0) {
          return withRetry(async () => {
            const result = await queryTextWithFallback(prompt, model as any, { gateway: this.gatewayConfig });
            let costUsd: number | undefined;
            if (result.usage) { try { costUsd = estimateCost(result.model, result.usage).totalCost; } catch {} }
            return { text: result.text, usage: result.usage, model: result.model, usedSpec: result.usedSpec, costUsd };
          }, { maxRetries: 1 });
        }
        const spec = resolveModelSpec(model);
        return withRetry(async () => {
          const result = await queryText(prompt, spec, undefined, { gateway: this.gatewayConfig });
          let costUsd: number | undefined;
          if (result.usage) { try { costUsd = estimateCost(result.model, result.usage).totalCost; } catch {} }
          return { text: result.text, usage: result.usage, model: result.model, costUsd };
        }, { maxRetries: 2 });
      },
      findLogForTask: (polpoDir, taskId, runId) => findLogForTask(polpoDir, taskId, runId),
      buildExecutionSummary: (logPath) => buildExecutionSummary(logPath),
      validateProviderKeys: (modelSpecs) => validateProviderKeys(modelSpecs),
      readRunLog: (runId) => {
        const logPath = join(this.polpoDir, "logs", `run-${runId}.jsonl`);
        if (!existsSync(logPath)) return null;
        return readFileSync(logPath, "utf-8");
      },
      // Inject Drizzle stores when storage is "sqlite" or "postgres"
      ...(this.drizzleStores ? {
        approvalStore: this.drizzleStores.approvalStore,
        checkpointStore: this.drizzleStores.checkpointStore,
        delayStore: this.drizzleStores.delayStore,
        configStore: this.drizzleStores.configStore,
      } : {}),
    };
  }

  /** Create manager instances with shared context. */
  private async initManagers(): Promise<void> {
    const ctx = this.buildContext();
    this.agentMgr = new AgentManager(ctx);
    this.taskMgr = new TaskManager(ctx);
    this.missionExec = new MissionExecutor(ctx, this.taskMgr, this.agentMgr);
    await this.missionExec.ready;
    this.runner = new TaskRunner(ctx);
    this.assessor = new AssessmentOrchestrator(ctx);

    // Initialize approval gates if configured
    if (this.config.settings.approvalGates && this.config.settings.approvalGates.length > 0) {
      const approvalStore = ctx.approvalStore ?? new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Initialize escalation manager if configured
    if (this.config.settings.escalationPolicy) {
      this.escalationMgr = new EscalationManager(ctx, this.approvalMgr);
      this.escalationMgr.init();
    }

    // Initialize SLA monitor if configured
    if (this.config.settings.sla) {
      this.slaMonitor = new SLAMonitor(ctx, this.config.settings.sla);
      this.slaMonitor.init();
    }

    // Initialize quality controller (always available — zero-cost when unused)
    this.qualityController = new QualityController(ctx);
    this.qualityController.init();
    this.missionExec.setQualityController(this.qualityController);

    // Initialize scheduler (always available — zero cost when no schedules exist)
    if (this.config.settings.enableScheduler !== false) {
      this.scheduler = new Scheduler(ctx);
      this.scheduler.setExecutor((missionId) => this.missionExec.executeMission(missionId));
      this.scheduler.init();
    }

    // Build the shared action executor (used by task watchers)
    const actionExecutor = this.buildActionExecutor(ctx);

    // Initialize task watcher manager (always available — zero cost when no watchers)
    this.watcherMgr = new TaskWatcherManager(this);
    this.watcherMgr.setActionExecutor(actionExecutor);
    this.watcherMgr.start();

    // Build the deadlock resolver port (wraps the shell's deadlock-resolver module)
    const deadlockResolver: DeadlockResolverPort = {
      isResolving,
      analyzeBlockedTasks,
      resolveDeadlock: (analysis, facade: DeadlockFacade) =>
        resolveDeadlock(analysis as ReturnType<typeof analyzeBlockedTasks>, this),
    };

    // Create the pure orchestration engine
    this.engine = new OrchestratorEngine({
      ctx,
      taskManager: this.taskMgr,
      agentManager: this.agentMgr,
      missionExecutor: this.missionExec,
      taskRunner: this.runner,
      assessmentOrchestrator: this.assessor,
      approvalManager: this.approvalMgr,
      scheduler: this.scheduler,
      slaMonitor: this.slaMonitor,
      qualityController: this.qualityController,
      escalationManager: this.escalationMgr,
      deadlockResolver,
    });
  }

  /**
   * Build the action executor callback — handles create_task, execute_mission,
   * run_script actions triggered by task watchers.
   */
  private buildActionExecutor(ctx: OrchestratorContext): (action: NotificationAction) => Promise<string> {
    return async (action: NotificationAction): Promise<string> => {
      switch (action.type) {
        case "create_task": {
          const task = await this.addTask({
            title: action.title,
            description: action.description,
            assignTo: action.assignTo,
            expectations: action.expectations,
          });
          return `Task created: [${task.id}] "${task.title}" → ${task.assignTo}`;
        }
        case "execute_mission": {
          const mission = await this.registry.getMission?.(action.missionId);
          if (!mission) throw new Error(`Mission "${action.missionId}" not found`);
          const result = await this.missionExec.executeMission(action.missionId);
          return `Mission "${mission.name}" executed: ${result.tasks.length} tasks created`;
        }
        case "run_script": {
          const { execSync } = await import("node:child_process");
          const timeout = action.timeoutMs ?? 30_000;
          const result = execSync(action.command, {
            cwd: ctx.agentWorkDir,
            timeout,
            stdio: ["ignore", "pipe", "pipe"],
            maxBuffer: 5 * 1024 * 1024,
          });
          return `Script completed: ${result.toString().trim().slice(0, 200)}`;
        }
        default:
          throw new Error(`Unknown action type: ${(action as { type: string }).type}`);
      }
    };
  }

  /**
   * Initialize for interactive mode.
   * Creates .polpo dir and a minimal config from provided team info.
   */
  async initInteractive(project: string, teams: Team | Team[]): Promise<void> {
    const teamsArray = Array.isArray(teams) ? teams : [teams];
    if (!existsSync(this.polpoDir)) {
      mkdirSync(this.polpoDir, { recursive: true });
    }

    // Load .polpo/.env so ${VAR} references resolve correctly
    loadEnvFile(this.polpoDir);

    // Load persistent config if available
    const polpoConfig = loadPolpoConfig(this.polpoDir);
    const settings = polpoConfig?.settings ?? { maxRetries: 2, workDir: ".", logLevel: "normal" as const };

    const storageBackend = settings.storage as "file" | "sqlite" | "postgres" | undefined;
    const dbUrl = (settings as any).databaseUrl ?? process.env.DATABASE_URL;
    const stores = this.injectedStore
      ? { task: this.injectedStore, run: this.injectedRunStore! }
      : await this.createStores(storageBackend, dbUrl);
    this.registry = stores.task;
    this.runStore = stores.run;

    // Use Drizzle-provided stores when available, otherwise fall back to file-based
    if ("logStore" in stores && stores.logStore) {
      this.logStore = stores.logStore;
      await this.logStore.startSession();
      this.setLogSink(this.logStore);
    } else {
      await this.initLogStore();
    }
    if ("sessionStore" in stores && stores.sessionStore) {
      this.sessionStore = stores.sessionStore;
    } else {
      await this.initSessionStore();
    }
    this.memoryStore = ("memoryStore" in stores && stores.memoryStore)
      ? stores.memoryStore
      : new FileMemoryStore(this.polpoDir);

    // Team & Agent stores — Drizzle when available, otherwise file-based
    this.teamStore = this.drizzleStores?.teamStore ?? new FileTeamStore(this.polpoDir);
    this.agentStore = this.drizzleStores?.agentStore ?? new FileAgentStore(this.polpoDir);

    // Populate stores with the teams passed to initInteractive
    // (this is project creation, not migration — teams come from the caller)
    await this.populateStores(teamsArray);

    this.config = {
      version: "1",
      project: polpoConfig?.project ?? project,
      teams: [], // populated by syncConfigCache() from stores
      tasks: [],
      settings,
      providers: polpoConfig?.providers,
    };

    // Apply provider overrides and allowlist
    if (this.config.providers) {
      setProviderOverrides(this.config.providers);
    }
    if (this.config.settings.modelAllowlist) {
      setModelAllowlist(this.config.settings.modelAllowlist);
    }

    // Configure LLM gateway from settings
    const gatewaySettings = this.config.settings.gateway;
    if (gatewaySettings) {
      this.gatewayConfig = {
        url: gatewaySettings.url,
        apiKey: gatewaySettings.apiKeyEnv ? process.env[gatewaySettings.apiKeyEnv] : undefined,
        headers: gatewaySettings.headers,
      };
    }

    await this.initManagers();

    // Sync config.teams from stores (authoritative source — agents.json / teams.json)
    await this.agentMgr.syncConfigCache();

    this.initVaultStore();
    this.playbookStore = this.drizzleStores?.playbookStore ?? new FilePlaybookStore(this.workDir, this.polpoDir);
    this.interactive = true;
    await this.registry.setState({
      project,
      teams: this.config.teams,
      startedAt: new Date().toISOString(),
    });

    // Recover any tasks left in limbo from a previous crash
    const recovered = await this.runner.recoverOrphanedTasks();
    if (recovered > 0) {
      this.emit("log", { level: "warn", message: `Recovered ${recovered} orphaned task(s) from previous session` });
    }

    // Watch polpo.json for changes and auto-reload
    this.startConfigWatcher();
  }

  /**
   * Watch `.polpo/polpo.json` for changes and auto-reload the config.
   * Uses a 500ms debounce to avoid reloading multiple times on rapid saves.
   */
  private startConfigWatcher(): void {
    const configPath = join(this.polpoDir, "polpo.json");
    if (!existsSync(configPath)) return;

    try {
      this.configWatcher = watch(configPath, () => {
        // Debounce: wait 500ms after the last change event
        if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
        this.configReloadTimer = setTimeout(() => {
          this.emit("log", { level: "info", message: "[watch] polpo.json changed on disk — auto-reloading config" });
          this.reloadConfig().catch(() => {});
        }, 500);
      });

      this.emit("log", { level: "info", message: "[watch] Watching polpo.json for changes" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `[watch] Failed to watch polpo.json: ${msg}` });
    }
  }

  // ── Task Management (delegates to OrchestratorEngine → TaskManager) ──

  async addTask(opts: {
    title: string; description: string; assignTo: string;
    expectations?: TaskExpectation[]; expectedOutcomes?: ExpectedOutcome[];
    dependsOn?: string[]; group?: string; maxDuration?: number; retryPolicy?: RetryPolicy;
    notifications?: ScopedNotificationRules; sideEffects?: boolean; draft?: boolean;
  }): Promise<Task> { return this.engine.addTask(opts); }
  async updateTaskDescription(taskId: string, description: string): Promise<void> { return this.engine.updateTaskDescription(taskId, description); }
  async updateTaskAssignment(taskId: string, agentName: string): Promise<void> { return this.engine.updateTaskAssignment(taskId, agentName); }
  async updateTaskExpectations(taskId: string, expectations: TaskExpectation[]): Promise<void> { return this.engine.updateTaskExpectations(taskId, expectations); }
  async retryTask(taskId: string): Promise<void> { return this.engine.retryTask(taskId); }
  reassessTask(taskId: string): Promise<void> { return this.engine.reassessTask(taskId); }
  async killTask(taskId: string): Promise<boolean> { return this.engine.killTask(taskId); }
  async deleteTask(taskId: string): Promise<boolean> { return this.engine.deleteTask(taskId); }
  async abortGroup(group: string): Promise<number> { return this.engine.abortGroup(group); }
  async clearTasks(filter: (task: Task) => boolean): Promise<number> { return this.engine.clearTasks(filter); }
  async forceFailTask(taskId: string): Promise<void> { return this.engine.forceFailTask(taskId); }

  // ── Approval Management (delegates to OrchestratorEngine) ──

  async approveRequest(requestId: string, resolvedBy?: string, note?: string): Promise<ApprovalRequest | null> {
    return this.engine.approveRequest(requestId, resolvedBy, note);
  }
  async rejectRequest(requestId: string, feedback: string, resolvedBy?: string): Promise<ApprovalRequest | null> {
    return this.engine.rejectRequest(requestId, feedback, resolvedBy);
  }
  async canRejectRequest(requestId: string): Promise<{ allowed: boolean; rejectionCount: number; maxRejections: number }> {
    return this.engine.canRejectRequest(requestId);
  }
  async getPendingApprovals(): Promise<ApprovalRequest[]> {
    return this.engine.getPendingApprovals();
  }
  async getAllApprovals(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return this.engine.getAllApprovals(status);
  }
  async getApprovalRequest(id: string): Promise<ApprovalRequest | undefined> {
    return this.engine.getApprovalRequest(id);
  }

  // ── Store Accessors ──

  getStore(): TaskStore { return this.registry; }
  getRunStore(): RunStore { return this.runStore; }
  getPolpoDir(): string { return this.polpoDir; }
  getMemoryStore(): MemoryStore { return this.memoryStore; }
  getVaultStore(): VaultStore | undefined { return this.vaultStore; }
  getPlaybookStore(): PlaybookStore { return this.playbookStore; }
  getTeamStore(): TeamStore { return this.teamStore; }
  getFs(): FileSystem { return this.fs; }
  getShell(): Shell { return this.shell; }
  getGatewayConfig(): GatewayConfig | undefined { return this.gatewayConfig; }
  getAgentStore(): AgentStore { return this.agentStore; }

  /**
   * Initialize the vault store.
   * When storage is "sqlite" or "postgres", uses DrizzleVaultStore (AES-256-GCM encrypted in DB).
   * Otherwise falls back to EncryptedVaultStore (file-based, .polpo/vault.enc).
   * Key: POLPO_VAULT_KEY env var or auto-generated ~/.polpo/vault.key.
   */
  private initVaultStore(): void {
    try {
      this.vaultStore = this.drizzleStores?.vaultStore ?? new EncryptedVaultStore(this.polpoDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit("log", { level: "warn", message: `Vault store init failed: ${msg}. Vault features disabled.` });
    }
  }

  // ── Agent Management (delegates to OrchestratorEngine → AgentManager) ──

  async getAgents(): Promise<AgentConfig[]> { return this.engine.getAgents(); }
  async getTeams(): Promise<Team[]> { return this.engine.getTeams(); }
  async getTeam(name?: string): Promise<Team | undefined> { return this.engine.getTeam(name); }
  getConfig(): PolpoConfig | null { return this.config; }
  get isInitialized(): boolean { return this.interactive; }
  async addTeam(team: Team): Promise<void> { return this.engine.addTeam(team); }
  async removeTeam(name: string): Promise<boolean> { return this.engine.removeTeam(name); }
  async renameTeam(oldName: string, newName: string): Promise<void> { return this.engine.renameTeam(oldName, newName); }
  async addAgent(agent: AgentConfig, teamName?: string): Promise<void> { return this.engine.addAgent(agent, teamName); }
  async removeAgent(name: string): Promise<boolean> { return this.engine.removeAgent(name); }
  async updateAgent(name: string, updates: Partial<Omit<AgentConfig, "name">>): Promise<AgentConfig> { return this.engine.updateAgent(name, updates); }
  async findAgentTeam(name: string): Promise<Team | undefined> { return this.engine.findAgentTeam(name); }
  async addVolatileAgent(agent: AgentConfig, group: string): Promise<void> { return this.engine.addVolatileAgent(agent, group); }
  async cleanupVolatileAgents(group: string): Promise<number> { return this.engine.cleanupVolatileAgents(group); }


  // ─── Mission Management (delegates to OrchestratorEngine → MissionExecutor) ──

  async saveMission(opts: { data: string; prompt?: string; name?: string; status?: MissionStatus; notifications?: ScopedNotificationRules }): Promise<Mission> { return this.engine.saveMission(opts); }
  async getMission(missionId: string): Promise<Mission | undefined> { return this.engine.getMission(missionId); }
  async getMissionByName(name: string): Promise<Mission | undefined> { return this.engine.getMissionByName(name); }
  async getAllMissions(): Promise<Mission[]> { return this.engine.getAllMissions(); }
  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> { return this.engine.updateMission(missionId, updates); }
  async deleteMission(missionId: string): Promise<boolean> { return this.engine.deleteMission(missionId); }

  // ─── Atomic Mission Data Operations (delegates to OrchestratorEngine → MissionExecutor) ──

  async addMissionTask(missionId: string, task: { title: string; description: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.engine.addMissionTask(missionId, task);
  }
  async updateMissionTask(missionId: string, taskTitle: string, updates: { title?: string; description?: string; assignTo?: string; dependsOn?: string[]; expectations?: unknown[]; expectedOutcomes?: unknown[]; maxDuration?: number; retryPolicy?: { escalateAfter?: number; fallbackAgent?: string }; notifications?: unknown }): Promise<Mission> {
    return this.engine.updateMissionTask(missionId, taskTitle, updates);
  }
  async removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    return this.engine.removeMissionTask(missionId, taskTitle);
  }
  async reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission> {
    return this.engine.reorderMissionTasks(missionId, titles);
  }
  async addMissionCheckpoint(missionId: string, cp: { name: string; afterTasks: string[]; blocksTasks: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.addMissionCheckpoint(missionId, cp);
  }
  async updateMissionCheckpoint(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.updateMissionCheckpoint(missionId, name, updates);
  }
  async removeMissionCheckpoint(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionCheckpoint(missionId, name);
  }
  async addMissionQualityGate(missionId: string, gate: { name: string; afterTasks: string[]; blocksTasks: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.engine.addMissionQualityGate(missionId, gate);
  }
  async updateMissionQualityGate(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; minScore?: number; requireAllPassed?: boolean; condition?: string; notifyChannels?: string[] }): Promise<Mission> {
    return this.engine.updateMissionQualityGate(missionId, name, updates);
  }
  async removeMissionQualityGate(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionQualityGate(missionId, name);
  }
  async addMissionDelay(missionId: string, delay: { name: string; afterTasks: string[]; blocksTasks: string[]; duration: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.addMissionDelay(missionId, delay);
  }
  async updateMissionDelay(missionId: string, name: string, updates: { name?: string; afterTasks?: string[]; blocksTasks?: string[]; duration?: string; notifyChannels?: string[]; message?: string }): Promise<Mission> {
    return this.engine.updateMissionDelay(missionId, name, updates);
  }
  async removeMissionDelay(missionId: string, name: string): Promise<Mission> {
    return this.engine.removeMissionDelay(missionId, name);
  }
  async addMissionTeamMember(missionId: string, member: { name: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.engine.addMissionTeamMember(missionId, member);
  }
  async updateMissionTeamMember(missionId: string, memberName: string, updates: { name?: string; role?: string; model?: string; [key: string]: unknown }): Promise<Mission> {
    return this.engine.updateMissionTeamMember(missionId, memberName, updates);
  }
  async removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    return this.engine.removeMissionTeamMember(missionId, memberName);
  }
  async updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission> {
    return this.engine.updateMissionNotifications(missionId, notifications);
  }

  // ─── Shared Memory (delegates to OrchestratorEngine) ───

  /** Check if shared memory exists. */
  async hasMemory(): Promise<boolean> { return this.engine.hasMemory(); }

  /** Get the full shared memory content. */
  async getMemory(): Promise<string> { return this.engine.getMemory(); }

  /** Overwrite the shared memory. */
  async saveMemory(content: string): Promise<void> { return this.engine.saveMemory(content); }

  /** Append a line to the shared memory. */
  async appendMemory(line: string): Promise<void> { return this.engine.appendMemory(line); }

  /** Replace a unique substring in the shared memory. */
  async updateMemory(oldText: string, newText: string): Promise<true | string> { return this.engine.updateMemory(oldText, newText); }

  // ─── Agent Memory (delegates to OrchestratorEngine) ───

  /** Check if memory exists for a specific agent. */
  async hasAgentMemory(agentName: string): Promise<boolean> { return this.engine.hasAgentMemory(agentName); }

  /** Get the memory content for a specific agent. */
  async getAgentMemory(agentName: string): Promise<string> { return this.engine.getAgentMemory(agentName); }

  /** Overwrite the memory for a specific agent. */
  async saveAgentMemory(agentName: string, content: string): Promise<void> { return this.engine.saveAgentMemory(agentName, content); }

  /** Append a line to a specific agent's memory. */
  async appendAgentMemory(agentName: string, line: string): Promise<void> { return this.engine.appendAgentMemory(agentName, line); }

  /** Replace a unique substring in a specific agent's memory. */
  async updateAgentMemory(agentName: string, oldText: string, newText: string): Promise<true | string> { return this.engine.updateAgentMemory(agentName, oldText, newText); }

  /** Get the persistent log store. */
  getLogStore(): LogStore | undefined {
    return this.logStore;
  }

  /** Initialize the persistent log store and wire it as event sink. */
  private async initLogStore(): Promise<void> {
    this.logStore = new FileLogStore(this.polpoDir);
    await this.logStore.startSession();
    this.setLogSink(this.logStore);
    // Auto-prune: keep last 20 sessions
    try { await this.logStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  /** Get the chat session store. */
  getSessionStore(): SessionStore | undefined {
    return this.sessionStore;
  }

  /** Initialize the chat session store. */
  private async initSessionStore(): Promise<void> {
    this.sessionStore = new FileSessionStore(this.polpoDir);
    try { await this.sessionStore.prune(20); } catch { /* best-effort: non-critical */ }
  }

  // ─── Mission Resume / Execute (delegates to OrchestratorEngine → MissionExecutor) ──

  async getResumableMissions(): Promise<Mission[]> { return this.engine.getResumableMissions(); }
  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> { return this.engine.resumeMission(missionId, opts); }
  async executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }> { return this.engine.executeMission(missionId); }

  // ─── Checkpoints (delegates to OrchestratorEngine) ──

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints() { return this.engine.getActiveCheckpoints(); }

  /** Resume a checkpoint by mission group name and checkpoint name. Returns true if resumed. */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    return this.engine.resumeCheckpoint(group, checkpointName);
  }

  /** Resume a checkpoint by mission ID and checkpoint name. Returns true if resumed. */
  async resumeCheckpointByMissionId(missionId: string, checkpointName: string): Promise<boolean> {
    return this.engine.resumeCheckpointByMissionId(missionId, checkpointName);
  }

  // ─── Delays (delegates to OrchestratorEngine) ─────

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays() { return this.engine.getActiveDelays(); }

  /** Stop the supervisor loop (non-graceful — use gracefulStop for clean shutdown) */
  stop(): void {
    this.stopped = true;
    this.engine?.stop();
  }

  /**
   * Graceful shutdown: SIGTERM all runner subprocesses, wait for them to write results,
   * preserve completed work, leave in-progress tasks for recovery on restart.
   */
  async gracefulStop(timeoutMs = 5000): Promise<void> {
    await this.hookRegistry.runBefore("orchestrator:shutdown", {});
    this.stopped = true;
    const activeRuns = await this.runStore.getActiveRuns();

    if (activeRuns.length > 0) {
      this.emit("log", { level: "warn", message: `Shutting down ${activeRuns.length} running agent(s)...` });

      // Send SIGTERM to all runner subprocesses
      for (const run of activeRuns) {
        if (run.pid > 0) {
          try { process.kill(run.pid, "SIGTERM"); } catch { /* already dead */ }
        }
      }

      // Wait for runners to write their results
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stillActive = await this.runStore.getActiveRuns();
        if (stillActive.length === 0) break;
        await sleep(200);
      }

      // Force-mark any remaining active runs as killed
      for (const run of await this.runStore.getActiveRuns()) {
        await this.runStore.completeRun(run.id, "killed", {
          exitCode: 1, stdout: "", stderr: "Killed during shutdown", duration: 0,
        });
      }
    }

    // Only save completed work — leave killed/failed tasks in current state for recovery
    for (const run of await this.runStore.getTerminalRuns()) {
      const task = await this.registry.getTask(run.taskId);
      if (run.status === "completed" && run.result?.exitCode === 0 && task && task.status !== "done") {
        // Agent finished successfully — save result and mark done (skip async assessment)
        try {
          await this.registry.updateTask(run.taskId, { result: run.result });
          if (task.status === "pending") await this.registry.transition(run.taskId, "assigned");
          if (task.status === "assigned") await this.registry.transition(run.taskId, "in_progress");
          if (task.status === "in_progress") await this.registry.transition(run.taskId, "review");
          await this.registry.transition(run.taskId, "done");
        } catch { /* leave for recovery on restart */ }
      }
      // For killed/failed runs: task stays in current state (in_progress, assigned, etc.)
      // recoverOrphanedTasks() on restart will handle retry without burning retry count
      await this.runStore.deleteRun(run.id);
    }

    // Clear process list in state and close stores
    await this.registry.setState({ processes: [], completedAt: new Date().toISOString() });
    if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
    this.configWatcher?.close();
    this.approvalMgr?.dispose();
    this.escalationMgr?.dispose();
    this.slaMonitor?.dispose();
    this.qualityController?.dispose();
    this.scheduler?.dispose();
    await this.registry.close?.();
    await this.runStore.close();
    this.emit("orchestrator:shutdown", {});
    await this.hookRegistry.runAfter("orchestrator:shutdown", {});
    await this.logStore?.close();
    await this.sessionStore?.close();
  }

  // ── Config Hot Reload ──

  /**
   * Reload polpo.json at runtime without restarting the server.
   * Disposes optional subsystems (approvals, escalation, SLA,
   * quality, scheduler) and re-initializes them from the
   * freshly-read config.  Core managers (agents, tasks, missions, runner,
   * assessor) and stores are left untouched — live state is preserved.
   *
   * Returns `true` if the config was successfully reloaded.
   */
  async reloadConfig(): Promise<boolean> {
    const polpoConfig = loadPolpoConfig(this.polpoDir);
    if (!polpoConfig) {
      this.emit("log", { level: "warn", message: "[reload] polpo.json not found or unparseable — skipping reload" });
      return false;
    }

    this.emit("log", { level: "info", message: "[reload] Reloading configuration..." });

    // 1. Dispose optional subsystems (scheduler is handled separately to preserve state)
    this.qualityController?.dispose();
    this.qualityController = undefined;
    this.slaMonitor?.dispose();
    this.slaMonitor = undefined;
    this.escalationMgr?.dispose();
    this.escalationMgr = undefined;
    this.approvalMgr?.dispose();
    this.approvalMgr = undefined;

    // 2. Update config in-place (preserves the shared reference in OrchestratorContext)
    //    Settings and providers come from polpo.json; teams come from stores.
    const newSettings = polpoConfig.settings ?? this.config.settings;
    this.config.settings = newSettings;
    if (polpoConfig.providers) {
      this.config.providers = polpoConfig.providers;
      setProviderOverrides(polpoConfig.providers);
    }
    if (newSettings.modelAllowlist) {
      setModelAllowlist(newSettings.modelAllowlist);
    }

    // Re-configure LLM gateway from updated settings
    if (newSettings.gateway) {
      this.gatewayConfig = {
        url: newSettings.gateway.url,
        apiKey: newSettings.gateway.apiKeyEnv ? process.env[newSettings.gateway.apiKeyEnv] : undefined,
        headers: newSettings.gateway.headers,
      };
    }

    // Re-sync config.teams from TeamStore/AgentStore (authoritative source)
    await this.agentMgr.syncConfigCache();

    // 3. Invalidate cached agent work dir and rebuild OrchestratorContext
    this.cachedAgentWorkDir = null;
    const ctx = this.buildContext();

    // 4. Re-initialize optional subsystems from new config

    // Approval gates
    if (this.config.settings.approvalGates && this.config.settings.approvalGates.length > 0) {
      const approvalStore = this.drizzleStores?.approvalStore ?? new FileApprovalStore(this.polpoDir);
      this.approvalMgr = new ApprovalManager(ctx, approvalStore);
      this.approvalMgr.init();
    }

    // Escalation manager
    if (this.config.settings.escalationPolicy) {
      this.escalationMgr = new EscalationManager(ctx, this.approvalMgr);
      this.escalationMgr.init();
    }

    // SLA monitor
    if (this.config.settings.sla) {
      this.slaMonitor = new SLAMonitor(ctx, this.config.settings.sla);
      this.slaMonitor.init();
    }

    // Quality controller (always available)
    this.qualityController = new QualityController(ctx);
    this.qualityController.init();
    this.missionExec.setQualityController(this.qualityController);

    // Scheduler — re-init without losing existing schedule state.
    // If scheduler was already running, just refresh its mission registrations.
    // If not, create a new one.
    if (this.config.settings.enableScheduler !== false) {
      if (!this.scheduler) {
        this.scheduler = new Scheduler(ctx);
        this.scheduler.setExecutor((missionId) => this.missionExec.executeMission(missionId));
      }
      this.scheduler.init();
    } else {
      this.scheduler?.dispose();
      this.scheduler = undefined;
    }

    // Sync engine with updated optional subsystems
    this.engine.setApprovalManager(this.approvalMgr);
    this.engine.setScheduler(this.scheduler);
    this.engine.setSLAMonitor(this.slaMonitor);
    this.engine.setQualityController(this.qualityController);
    this.engine.setEscalationManager(this.escalationMgr);

    this.emit("log", { level: "info", message: "[reload] Configuration reloaded successfully" });
    this.emit("config:reloaded", { timestamp: new Date().toISOString() });
    return true;
  }

  /**
   * Recover orphaned tasks on startup.
   * Checks RunStore for active runs — if the runner PID is still alive,
   * let it keep running (zero work lost). If PID is dead, clean up the run.
   * Then requeue orphaned tasks to "pending" WITHOUT burning retry count
   * (shutdown interrupts are not real failures).
   */
  async recoverOrphanedTasks(): Promise<number> { return this.engine.recoverOrphanedTasks(); }

  private async seedTasks(): Promise<void> {
    await this.taskMgr.seedTasks();
    // Sync config cache from stores so state reflects authoritative data
    await this.agentMgr.syncConfigCache();
    // Also set initial state for non-interactive mode
    await this.registry.setState({
      project: this.config.project,
      teams: this.config.teams,
      startedAt: new Date().toISOString(),
    });
  }

  /**
   * Main supervisor loop. Runs until all tasks are done/failed.
   * In interactive mode, keeps running and waits for new tasks.
   */
  async run(): Promise<void> {
    if (!this.interactive) {
      await this.init();
      await this.seedTasks();
    }

    this.stopped = false;

    // Node.js-specific: catch unhandled promise rejections
    const rejectionHandler = (reason: unknown) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.emit("log", { level: "error", message: `Unhandled rejection in supervisor: ${msg}` });
    };

    await this.engine.run(
      this.interactive,
      () => { process.on("unhandledRejection", rejectionHandler); },
      () => { process.removeListener("unhandledRejection", rejectionHandler); },
    );
  }

  /**
   * Single tick of the supervisor loop. Returns true when all work is done.
   */
  async tick(): Promise<boolean> {
    return this.engine.tick();
  }

  // Assessment pipeline delegated to AssessmentOrchestrator
  /** @internal — test access only */
  private async retryOrFail(taskId: string, task: Task, result: TaskResult): Promise<void> {
    await this.assessor.retryOrFail(taskId, task, result);
  }

  async status(): Promise<void> {
    await this.init();
    // Emit log for CLI to consume
    const tasks = await this.registry.getAllTasks();
    const done = tasks.filter(t => t.status === "done");
    const failed = tasks.filter(t => t.status === "failed");
    this.emit("log", { level: "info", message: `Total: ${tasks.length} | Done: ${done.length} | Failed: ${failed.length}` });
  }

  /** Access the pure orchestration engine (for advanced use / testing). */
  getEngine(): OrchestratorEngine { return this.engine; }
}

