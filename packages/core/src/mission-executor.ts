import { currentMissionExecutionTasks, resumableMissions } from "./mission-inspection.js";
import type { ActiveCheckpoint, ActiveDelay } from "./types.js";
import { nanoid } from "nanoid";
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Mission, MissionStatus, MissionReport, Task, TaskExpectation, MissionQualityGate, MissionCheckpoint, MissionDelay, ScopedNotificationRules, TaskOutcome } from "./types.js";
import type { QualityController } from "./quality-controller.js";
import { sanitizeExpectations, parseMissionDocument, type MissionDocumentParsed } from "./schemas.js";
import { resolveMissionStore, resolveMissionForGroup, resolveMissionExecutionStore, type MissionStore } from "./mission-store.js";
import { assertMissionExecutionTask, MissionExecutionError, validateMissionExecutionKey, type MissionExecutionCommit, type MissionExecutionOptions, type MissionExecutionResult } from "./mission-execution.js";
import { InMemoryCheckpointStore, InMemoryDelayStore } from "./in-memory-stores.js";
import { MissionGating, parseISO8601Duration } from "./mission-gating.js";
import { resolveConfiguredModelSelection } from "./model-profiles.js";
import { normalizeRuntimeMetadata } from "./runtime-metadata.js";

/** Mission document keys holding list collections editable via the atomic data operations. */
type MissionCollectionKey = "tasks" | "checkpoints" | "delays" | "qualityGates" | "team";

/** Element type of a mission document collection. */
type MissionCollectionItem<K extends MissionCollectionKey> =
  NonNullable<MissionDocumentParsed[K]> extends Array<infer T> ? T : never;

/**
 * Mission CRUD + execution + resume + group lifecycle.
 * Runtime checkpoint/delay gating is delegated to MissionGating.
 */
export class MissionExecutor {
  private cleanedGroups = new Set<string>();
  /** Quality gates parsed from mission documents, keyed by mission group name */
  private gatesByGroup = new Map<string, MissionQualityGate[]>();
  private missions: MissionStore;
  /** Runtime checkpoint/delay gating — owns the persisted checkpoint/delay state */
  private gating: MissionGating;
  /** Optional quality controller — set by orchestrator after init */
  private qualityCtrl?: QualityController;
  /** Track the pre-execution status for scheduled/recurring missions (by group name).
   *  When a mission completes/fails, this determines whether to return to scheduled/recurring. */
  private scheduledOrigin = new Map<string, "scheduled" | "recurring">();
  private preparedExecutions = new Map<string, Promise<MissionExecutionCommit>>();
  private groupExecutions = new Map<string, Set<string>>();
  private gatingKey(group: string): string {
    if (this.preparedExecutions.has(group)) return group;
    const executions = this.groupExecutions.get(group);
    if (!executions?.size) return group;
    if (executions.size > 1) throw new MissionExecutionError("mission_execution_conflict", "Ambiguous Mission group; use its execution ID");
    return [...executions][0];
  }

  constructor(
    private ctx: OrchestratorContext,
    private taskMgr: TaskManager,
    private agentMgr: AgentManager,
  ) {
    this.missions = resolveMissionStore(ctx);
    this.gating = new MissionGating(
      ctx,
      ctx.checkpointStore ?? new InMemoryCheckpointStore(),
      ctx.delayStore ?? new InMemoryDelayStore(),
    );

    // Rebuild cleanedGroups from persisted task state — groups where ALL tasks
    // are already terminal don't need to be re-processed after a server restart.
    // Constructor cannot be async — expose ready promise for callers to await.
    this.ready = this.initStoresAndRebuild();
  }

  /** Resolves when async store loading and group rebuild are complete. */
  readonly ready: Promise<void>;

  /** Async init: load checkpoint/delay state and rebuild cleanedGroups. */
  private async initStoresAndRebuild(): Promise<void> {
    await this.gating.ready;
    await this.rebuildCleanedGroups();
  }

  /** Async init: rebuild cleanedGroups from persisted task state. */
  private async rebuildCleanedGroups(): Promise<void> {
    const allTasks = await this.ctx.taskStore.listTasks();
    const groups = new Set<string>();
    for (const t of allTasks) {
      const group = t.missionExecutionId ?? t.group;
      if (group) groups.add(group);
    }
    for (const group of groups) {
      try {
        const groupTasks = allTasks.filter(t => (t.missionExecutionId ?? t.group) === group);
        const persisted = groupTasks[0];
        // Presentation must retain its durable key even if receipt recovery is
        // temporarily unavailable. Authorization still requires the receipt below.
        if (persisted.missionExecutionId) this.gating.setExecutionIdentity({
          executionId: persisted.missionExecutionId, missionId: persisted.missionId, group: persisted.group ?? group,
        });
        if (groupTasks.every(t => t.status === "done" || t.status === "failed")) {
          const mission = await resolveMissionForGroup(this.missions, groupTasks, group);
          const receipt = groupTasks[0].missionExecutionId
            ? (await resolveMissionExecutionStore(this.ctx)?.getMissionExecutionById(groupTasks[0].missionExecutionId))?.receipt : undefined;
          if (mission?.status !== "active" || (receipt && receipt.sequence !== mission.executionCount)) this.cleanedGroups.add(group);
        }
        if (!this.cleanedGroups.has(group) && groupTasks[0].missionExecutionId) await this.prepareTaskExecution(groupTasks[0], false);
      } catch {
        // A receipt outage blocks only this execution. The dispatch barrier and
        // cleanup retry recovery later; unrelated Missions remain available.
        this.ctx.emitter.emit("log", { level: "warn", message: `Mission execution recovery deferred for ${group}` });
      }
    }
  }

  /** Set the quality controller instance (called by Orchestrator after init). */
  setQualityController(ctrl: QualityController): void {
    this.qualityCtrl = ctrl;
  }

  /** Get quality gates for a mission group. Returns empty array if none defined. */
  getQualityGates(group: string): MissionQualityGate[] {
    return this.gatesByGroup.get(this.gatingKey(group)) ?? [];
  }

  // ─── Checkpoint/delay gating (delegated to MissionGating) ─────────────

  /** Get checkpoints for a mission group. Returns empty array if none defined. */
  getCheckpoints(group: string): MissionCheckpoint[] {
    return this.gating.getCheckpoints(this.gatingKey(group));
  }

  /**
   * Check if a task is blocked by an active (unresumed) checkpoint.
   * Returns the blocking checkpoint if found, undefined if the task can proceed.
   */
  async getBlockingCheckpoint(
    group: string,
    taskTitle: string,
    taskId: string,
    tasks: Task[],
  ): Promise<{ checkpoint: MissionCheckpoint; reachedAt: string } | undefined> {
    const key = this.gatingKey(group);
    return this.gating.getBlockingCheckpoint(key, taskTitle, taskId, this.preparedExecutions.has(key) ? tasks.filter(task => task.missionExecutionId === key) : tasks);
  }

  /**
   * Resume a checkpoint, unblocking its blocksTasks.
   * Returns true if the checkpoint was active and is now resumed, false if not found.
   */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    return this.gating.resumeCheckpoint(this.gatingKey(group), checkpointName);
  }

  async resumeCheckpointByMissionId(missionId: string, checkpointName: string): Promise<boolean> {
    await this.ready;
    const mission = await this.getMission(missionId);
    if (!mission) return false;
    const task = (await this.currentExecutionTasks(mission, await this.ctx.taskStore.listTasks()))[0];
    if (!task) return false;
    await this.prepareTaskExecution(task, false);
    return this.resumeCheckpoint(task.missionExecutionId ?? task.group ?? mission.name, checkpointName);
  }

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints(): ActiveCheckpoint[] {
    return this.gating.getActiveCheckpoints();
  }

  /** Get delays for a mission group. Returns empty array if none defined. */
  getDelays(group: string): MissionDelay[] {
    return this.gating.getDelays(this.gatingKey(group));
  }

  /**
   * Check if a task is blocked by an active (unexpired) delay.
   * If afterTasks are all done and the delay hasn't started yet, starts the timer.
   * If the timer has expired, marks the delay as expired and unblocks.
   * Returns the blocking delay if found, undefined if the task can proceed.
   */
  async getBlockingDelay(
    group: string,
    taskTitle: string,
    taskId: string,
    tasks: Task[],
  ): Promise<{ delay: MissionDelay; startedAt: string; expiresAt: string } | undefined> {
    const key = this.gatingKey(group);
    return this.gating.getBlockingDelay(key, taskTitle, taskId, this.preparedExecutions.has(key) ? tasks.filter(task => task.missionExecutionId === key) : tasks);
  }

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays(): ActiveDelay[] {
    return this.gating.getActiveDelays();
  }

  async createMission(opts: {
    data: string;
    prompt?: string;
    name?: string;
    status?: MissionStatus;
    /**
     * Cron expression or ISO timestamp for scheduled execution.
     * @deprecated Use a v2 Schedule with a `legacy_mission` invocation.
     */
    schedule?: string;
    /** Absolute deadline for the entire mission (ISO timestamp). */
    deadline?: string;
    /**
     * End date for recurring schedules (ISO timestamp).
     * @deprecated Use v2 Schedule compatibility metadata.
     */
    endDate?: string;
    notifications?: ScopedNotificationRules;
    /** Opaque end-user identifier (OpenAI-compat). */
    user?: string;
    metadata?: Record<string, string>;
  }): Promise<Mission> {
    const metadata = normalizeRuntimeMetadata(opts.metadata);
    const name = opts.name ?? await this.missions.nextMissionName();
    const mission = await this.missions.createMission({
      name,
      data: opts.data,
      prompt: opts.prompt,
      status: opts.status ?? "draft",
      schedule: opts.schedule,
      deadline: opts.deadline,
      endDate: opts.endDate,
      notifications: opts.notifications,
      user: opts.user,
      metadata,
    });
    this.ctx.emitter.emit("mission:saved", { missionId: mission.id, name: mission.name, status: mission.status });
    return mission;
  }

  async getMission(missionId: string): Promise<Mission | undefined> {
    return this.missions.getMission(missionId);
  }

  async getMissionByName(name: string): Promise<Mission | undefined> {
    return this.missions.getMissionByName(name);
  }

  async listMissions(): Promise<Mission[]> {
    return await this.missions.listMissions();
  }

  async updateMission(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission> {
    return this.missions.updateMission(missionId, updates);
  }

  async deleteMission(missionId: string): Promise<boolean> {
    const mission = await this.getMission(missionId);
    if (!mission) return false;

    await this.ready;
    // An explicit Mission ID always wins over the legacy display-label fallback.
    const belongs = (task: Task) => task.missionId === missionId || (!task.missionId && task.group === mission.name);
    const tasks = (await this.ctx.taskStore.listTasks()).filter(belongs);
    const groups = new Set(tasks.map(task => task.missionExecutionId ?? task.group).filter((group): group is string => !!group));
    for (const [key, pending] of this.preparedExecutions) {
      if ((await pending).receipt.missionId === missionId) groups.add(key);
    }
    const deletedTasks = await this.taskMgr.clearTasks(belongs);
    for (const group of groups) {
      await this.agentMgr.cleanupVolatileAgents(group);
      await this.forgetExecution(group);
      this.cleanedGroups.delete(group);
    }

    // ── Delete the mission record ────────────────────────
    const result = await this.missions.deleteMission(missionId);
    if (result) {
      this.ctx.emitter.emit("mission:deleted", { missionId, deletedTasks });
    }
    return result;
  }

  private async currentExecutionTasks(mission: Mission, tasks: Task[]): Promise<Task[]> {
    return currentMissionExecutionTasks(mission, tasks, resolveMissionExecutionStore(this.ctx));
  }

  async getResumableMissions(): Promise<Mission[]> {
    await this.ready;
    return resumableMissions(await this.listMissions(), await this.ctx.taskStore.listTasks(), resolveMissionExecutionStore(this.ctx));
  }

  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> {
    await this.ready;
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    const tasks = await this.currentExecutionTasks(mission, await this.ctx.taskStore.listTasks());
    for (const task of tasks) this.cleanedGroups.delete(task.missionExecutionId ?? task.group ?? mission.name);
    // Old CRUD-only executions have no accepted snapshot. Preserve their legacy
    // resume behavior without letting edited configuration replace durable plans.
    if (tasks.some(task => !task.missionExecutionId) && this.ctx.config.settings.enableVolatileTeams !== false) {
      const doc = parseMissionDocument(JSON.parse(mission.data));
      for (const agent of doc.team ?? []) await this.agentMgr.addVolatileAgent(agent, tasks[0]?.group ?? mission.name);
    }
    const failedTasks = tasks.filter(task => task.status === "failed");
    const pendingTasks = tasks.filter(task => task.status === "pending");
    let retried = 0;
    if (opts?.retryFailed) {
      for (const task of failedTasks) {
        // Validate the receipt before making failed work runnable again.
        await this.prepareTaskExecution(task);
        try { await this.taskMgr.retryTask(task.id); retried++; }
        catch { continue; /* no retries left */ }
        await this.prepareTaskExecution((await this.ctx.taskStore.getTask(task.id))!);
      }
    }
    for (const task of pendingTasks) await this.prepareTaskExecution(task);
    if (mission.status === "failed") await this.updateMission(missionId, { status: "active" });
    this.ctx.emitter.emit("mission:resumed", { missionId, name: mission.name, retried, pending: pendingTasks.length });
    return { retried, pending: pendingTasks.length };
  }

  private async forgetExecution(group: string): Promise<void> {
    // Settle recovery before removing its definitions, so an in-flight load
    // cannot restore a cache that cleanup has just removed.
    await this.preparedExecutions.get(group);
    this.gatesByGroup.delete(group);
    this.scheduledOrigin.delete(group);
    await this.gating.removeGroup(group);
    this.preparedExecutions.delete(group);
    for (const [label, aliases] of this.groupExecutions) {
      aliases.delete(group);
      if (!aliases.size) this.groupExecutions.delete(label);
    }
  }

  /** Restore accepted runtime definitions before any task can be dispatched.
   * The durable receipt is authoritative even after Mission edits or a restart. */
  async prepareTaskExecution(task: Task, restoreAgents = true): Promise<void> {
    if (!task.missionExecutionId) return;
    const store = resolveMissionExecutionStore(this.ctx);
    if (!store) throw new MissionExecutionError("mission_execution_unsupported", "Mission execution recovery is unavailable");
    let pending = this.preparedExecutions.get(task.missionExecutionId);
    if (!pending) {
      pending = (async () => {
        await this.gating.ready;
        const admission = await store.getMissionExecutionById(task.missionExecutionId!);
        if (!admission) throw new MissionExecutionError("mission_execution_invalid", "Mission execution receipt is missing");
        const doc = parseMissionDocument(JSON.parse(admission.expected.data));
        const titles = new Map(admission.runtime?.taskTitles?.map(entry => [entry.authored, entry.accepted]));
        const translate = <T extends { afterTasks: string[]; blocksTasks: string[] }>(items: T[] = []): T[] => items.map(item => ({
          ...item, afterTasks: item.afterTasks.map(title => titles.get(title) ?? title), blocksTasks: item.blocksTasks.map(title => titles.get(title) ?? title),
        }));
        const group = admission.receipt.executionId;
        this.gating.setExecutionIdentity({ executionId: group, missionId: admission.receipt.missionId, group: admission.receipt.group });
        const aliases = this.groupExecutions.get(admission.receipt.group) ?? new Set<string>();
        aliases.add(group); this.groupExecutions.set(admission.receipt.group, aliases);
        // Definitions already persist in the receipt. Do not rewrite shared
        // checkpoint state from a second executor during admission recovery.
        this.gatesByGroup.set(group, translate(doc.qualityGates));
        await this.gating.setCheckpointDefinitions(group, translate(doc.checkpoints), false);
        await this.gating.setDelayDefinitions(group, translate(doc.delays), false);
        if (admission.expected.status === "scheduled" || admission.expected.status === "recurring") {
          this.scheduledOrigin.set(group, admission.expected.status);
        }
        return admission;
      })();
      this.preparedExecutions.set(task.missionExecutionId, pending);
      pending.catch(() => this.preparedExecutions.delete(task.missionExecutionId!));
    }
    const admission = await pending;
    assertMissionExecutionTask(task, admission.receipt);
    // Never recreate volatile agents for historical/terminal work. New active
    // tasks recover them from the accepted plan, not the edited Mission data.
    if (restoreAgents && task.status !== "done" && task.status !== "failed") {
      for (const agent of admission.runtime?.volatileAgents ?? []) {
        await this.agentMgr.addVolatileAgent(agent, admission.receipt.executionId);
      }
    }
  }

  async executeMission(missionId: string, options: MissionExecutionOptions = {}): Promise<MissionExecutionResult> {
    await this.ready;
    const persistence = resolveMissionExecutionStore(this.ctx);
    if (options.idempotencyKey !== undefined) {
      validateMissionExecutionKey(missionId, options.idempotencyKey);
      if (!persistence) throw new MissionExecutionError("mission_execution_unsupported", "Idempotent Mission execution requires atomic persistence");
      const accepted = await persistence.getMissionExecution(missionId, options.idempotencyKey);
      if (accepted) return { tasks: accepted.tasks, group: accepted.group, executionId: accepted.executionId };
    }
    let admitted = false;
    try {
      const stored = await this.missions.getMission(missionId);
      if (!stored) throw new Error("Mission not found");
      // Some custom stores return mutable objects. Hooks and awaits must not alter
      // the expected snapshot that will be compared during atomic admission.
      const mission = structuredClone(stored);
      if (!["draft", "scheduled", "recurring", "failed", "cancelled"].includes(mission.status)) {
        throw new Error(`Cannot execute mission in "${mission.status}" state`);
      }
      const sequence = (mission.executionCount ?? 0) + 1;
      const group = sequence > 1 ? `${mission.name} #${sequence}` : mission.name;
      const doc = parseMissionDocument(JSON.parse(mission.data));
      const hook = await this.ctx.hooks.runBefore("mission:execute", { missionId, mission: structuredClone(mission), taskCount: doc.tasks.length });
      if (hook.cancelled) throw new Error(`Mission execution blocked by hook: ${hook.cancelReason ?? "no reason"}`);

      const existingAgents = await this.agentMgr.getAgents();
      const volatileAgents = this.ctx.config.settings.enableVolatileTeams === false ? [] : (doc.team ?? []).filter(agent => {
        if (!agent || typeof agent.name !== "string" || !agent.name.trim()) throw new Error("Mission team requires valid agent names");
        return !existingAgents.some(existing => existing.name === agent.name);
      });
      const agents = [...existingAgents, ...volatileAgents];
      // Resolve all dependencies, including forward references, before writing.
      const byTitle = new Map(doc.tasks.map(task => [task.title, task]));
      const ordered: typeof doc.tasks = [], visited = new Set<string>(), visiting = new Set<string>();
      const visit = (title: string): void => {
        if (visited.has(title)) return;
        if (visiting.has(title)) throw new Error(`Cyclic Mission dependency at "${title}"`);
        const task = byTitle.get(title);
        if (!task) throw new Error(`Unknown Mission dependency "${title}"`);
        visiting.add(title);
        for (const dependency of task.dependsOn ?? []) visit(dependency);
        visiting.delete(title); visited.add(title); ordered.push(task);
      };
      for (const task of doc.tasks) visit(task.title);

      const createdAt = new Date().toISOString(), executionId = nanoid();
      const titleToId = new Map<string, string>(), tasks: Task[] = [];
      const referencedModels: string[] = [];
      const taskTitles: Array<{ authored: string; accepted: string }> = [];
      for (const authored of ordered) {
        const prepared = await this.taskMgr.prepareTask({
          title: authored.title, description: authored.description || authored.title,
          assignTo: authored.assignTo || agents[0]?.name || "default",
          dependsOn: (authored.dependsOn ?? []).map(title => titleToId.get(title)!),
          expectations: authored.expectations, expectedOutcomes: authored.expectedOutcomes,
          group, missionId, user: mission.user, metadata: mission.metadata, maxDuration: authored.maxDuration,
          retryPolicy: authored.retryPolicy, notifications: authored.notifications, sideEffects: authored.sideEffects,
        });
        const agent = agents.find(candidate => candidate.name === prepared.assignTo);
        if (!agent) throw new Error(`Mission references agent "${prepared.assignTo}" (task "${prepared.title}") but no such agent exists. Available agents: ${agents.map(agent => agent.name).join(", ")}`);
        if (agent.model) referencedModels.push(...resolveConfiguredModelSelection(agent.model, this.ctx.config.settings, agent.allowedModelProfiles).policy.candidates);
        const task: Task = { ...prepared, id: nanoid(), status: "pending", retries: 0, createdAt, updatedAt: createdAt,
          missionId, group, user: mission.user, metadata: normalizeRuntimeMetadata(mission.metadata), ...(persistence ? { missionExecutionId: executionId } : {}) };
        tasks.push(task); titleToId.set(authored.title, task.id);
        taskTitles.push({ authored: authored.title, accepted: task.title });
      }
      if (referencedModels.length && this.ctx.validateProviderKeys) {
        const missing = this.ctx.validateProviderKeys(referencedModels);
        if (missing.length) throw new Error(`Missing API keys for providers: ${missing.map(model => `${model.provider} (model: ${model.modelSpec})`).join(", ")}. Set the corresponding environment variables or add them to the project.json providers section.`);
      }

      if (persistence) {
        const result = await persistence.commitMissionExecution({ expected: mission, notifications: doc.notifications,
          runtime: { volatileAgents, taskTitles }, receipt: { executionId, missionId, idempotencyKey: options.idempotencyKey ?? `execution:${executionId}`,
            group, sequence, user: mission.user, metadata: normalizeRuntimeMetadata(mission.metadata), createdAt, tasks } });
        admitted = true;
        if (result.created) {
          await this.prepareTaskExecution(result.receipt.tasks[0]);
          for (const task of result.receipt.tasks) this.taskMgr.notifyTaskCreated(task);
          this.ctx.emitter.emit("mission:executed", { missionId, group, taskCount: result.receipt.tasks.length });
        }
        return { tasks: result.receipt.tasks, group: result.receipt.group, executionId: result.receipt.executionId };
      }

      // Compatibility for custom stores with only ordinary CRUD. Explicit
      // idempotency is refused above; these writes do not claim atomic admission.
      for (const agent of volatileAgents) await this.agentMgr.addVolatileAgent(agent, group);
      this.gatesByGroup.set(group, doc.qualityGates ?? []);
      if (doc.checkpoints?.length) await this.gating.setCheckpointDefinitions(group, doc.checkpoints);
      if (doc.delays?.length) await this.gating.setDelayDefinitions(group, doc.delays);
      if (mission.status === "scheduled" || mission.status === "recurring") this.scheduledOrigin.set(group, mission.status);
      const actualIds = new Map<string, string>(), created: Task[] = [];
      for (const task of tasks) {
        const storedTask = await this.ctx.taskStore.createTask({ ...task, dependsOn: task.dependsOn.map(id => actualIds.get(id)!) });
        actualIds.set(task.id, storedTask.id); created.push(storedTask); this.taskMgr.notifyTaskCreated(storedTask);
      }
      await this.missions.updateMission(missionId, { status: "active", executionCount: sequence, ...(doc.notifications ? { notifications: doc.notifications } : {}) });
      this.ctx.emitter.emit("mission:executed", { missionId, group, taskCount: created.length });
      return { tasks: created, group };
    } catch (error) {
      // Another caller may win after our initial lookup but before preflight.
      // Its accepted receipt also wins over active-state/title/hook conflicts.
      if (!admitted && persistence && options.idempotencyKey !== undefined) {
        const accepted = await persistence.getMissionExecution(missionId, options.idempotencyKey);
        if (accepted) return { tasks: accepted.tasks, group: accepted.group, executionId: accepted.executionId };
      }
      throw error;
    }
  }

  /** Check if any mission groups have all tasks terminal, and clean up their volatile agents */
  async cleanupCompletedGroups(tasks: Task[]): Promise<void> {
    const groups = new Set<string>();
    for (const t of tasks) {
      const group = t.missionExecutionId ?? t.group;
      if (group) groups.add(group);
    }
    for (const group of groups) {
      const groupTasks = tasks.filter(t => (t.missionExecutionId ?? t.group) === group);
      const label = groupTasks[0]?.group ?? group;
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");

      // If tasks went back to non-terminal (e.g. individual retry via retryTask),
      // clear the cleaned flag so the group will be re-evaluated when done again.
      if (!allTerminal && this.cleanedGroups.has(group)) {
        this.cleanedGroups.delete(group);
        continue;
      }

      if (this.cleanedGroups.has(group)) continue;
      if (!allTerminal) continue;
      const capturedTask = groupTasks.find(task => task.missionExecutionId);
      if (capturedTask) await this.prepareTaskExecution(capturedTask);

      // Auto-update mission status
      const mission = await resolveMissionForGroup(this.missions, groupTasks, group);
      const admission = capturedTask ? await resolveMissionExecutionStore(this.ctx)?.getMissionExecutionById(capturedTask.missionExecutionId!) : undefined;
      if (mission && mission.status === "active" && (!admission || admission.receipt.sequence === mission.executionCount)) {
        let allDone = groupTasks.every(t => t.status === "done");

        // Check mission quality threshold (only if all tasks passed structurally)
        if (allDone && this.qualityCtrl) {
          const thresholdResult = this.qualityCtrl.checkMissionThreshold(
            admission?.expected ?? mission,
            groupTasks,
            this.ctx.config.settings.defaultQualityThreshold,
          );
          if (!thresholdResult.passed) {
            allDone = false; // Quality threshold not met — mark mission as failed
            this.ctx.emitter.emit("log", {
              level: "warn",
              message: `Mission "${group}" quality threshold not met: ${thresholdResult.avgScore?.toFixed(2) ?? "N/A"} < ${thresholdResult.threshold}`,
            });
          }
        }

        // Determine final status based on scheduled origin
        const origin = this.scheduledOrigin.get(group);
        let finalStatus: MissionStatus;
        if (origin === "recurring") {
          // Recurring missions always return to "recurring" — ready for next cron tick
          finalStatus = "recurring";
        } else if (origin === "scheduled" && !allDone) {
          // One-shot scheduled missions return to "scheduled" on failure for retry
          finalStatus = "scheduled";
        } else {
          // Normal missions or successful one-shot scheduled missions
          finalStatus = allDone ? "completed" : "failed";
        }
        const finalized = admission
          ? await resolveMissionExecutionStore(this.ctx)!.finalizeMissionExecution(admission.receipt.executionId, finalStatus)
          : !!await this.missions.updateMission(mission.id, { status: finalStatus });
        // A retry may have made tasks runnable since this cleanup snapshot.
        // Keep definitions/agents and retry from fresh state on the next tick.
        if (!finalized) continue;
        if (finalized) {
          const report = await this.buildMissionReport(mission.id, label, groupTasks, allDone);
          this.ctx.emitter.emit("mission:completed", { missionId: mission.id, group: label, allPassed: allDone, report });
          this.qualityCtrl?.aggregateMissionMetrics(mission.id, groupTasks);
        }

      }
      if ((this.ctx.config.settings.volatileCleanup ?? "on_complete") === "on_complete") {
        await this.agentMgr.cleanupVolatileAgents(group);
      }
      await this.forgetExecution(group);
      this.cleanedGroups.add(group);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  ATOMIC MISSION DATA OPERATIONS
  //  Read-modify-write the `data` JSON blob without full replacement.
  // ═══════════════════════════════════════════════════════

  /**
   * Parse a mission's `data` JSON and return the structured document.
   * Throws if the mission is not found or if `data` is not valid JSON.
   */
  private async parseMissionData(missionId: string): Promise<{ mission: Mission; doc: MissionDocumentParsed }> {
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    const doc = parseMissionDocument(JSON.parse(mission.data));
    return { mission, doc };
  }

  /**
   * Persist an updated document back onto the mission record.
   * Re-validates through Zod to ensure integrity.
   */
  private async persistMissionData(missionId: string, doc: MissionDocumentParsed): Promise<Mission> {
    // Re-validate to catch any structural issue before persisting
    parseMissionDocument(doc);
    const mission = await this.updateMission(missionId, { data: JSON.stringify(doc) });
    // Notify listeners so SSE clients (e.g. mission detail page) refetch updated data
    this.ctx.emitter.emit("mission:saved", { missionId: mission.id, name: mission.name, status: mission.status });
    return mission;
  }

  /**
   * Generic read-modify-write for a named collection inside the mission `data`
   * document. Loads the mission, hands the collection (and the full parsed
   * document) to `mutate`, then re-validates and persists.
   *
   * - `createIfMissing` creates the collection when absent (add operations);
   *   otherwise a missing collection throws `missingError`.
   * - Optional collections left empty by the mutation are removed from the
   *   document entirely (tasks are required and never dropped).
   */
  private async mutateMissionCollection<K extends MissionCollectionKey>(
    missionId: string,
    key: K,
    mutate: (items: MissionCollectionItem<K>[], doc: MissionDocumentParsed) => void,
    opts: { createIfMissing?: boolean; missingError?: string } = {},
  ): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (!doc[key]) {
      if (!opts.createIfMissing) throw new Error(opts.missingError ?? `No ${key} in mission`);
      (doc as any)[key] = [];
    }
    mutate((doc as any)[key], doc);
    if (key !== "tasks" && (doc as any)[key]?.length === 0) delete (doc as any)[key];
    return this.persistMissionData(missionId, doc);
  }

  // ─── Task operations ────────────────────────────────

  /** Add a task to a draft mission's data. */
  async addMissionTask(missionId: string, task: {
    title: string;
    description: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: unknown[];
    expectedOutcomes?: unknown[];
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
    notifications?: unknown;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "tasks", tasks => {
      // Enforce unique title
      if (tasks.some(t => t.title === task.title)) {
        throw new Error(`Task title "${task.title}" already exists in this mission`);
      }
      tasks.push(task as MissionDocumentParsed["tasks"][number]);
    }, { createIfMissing: true });
  }

  /** Update a specific task within the mission data (matched by title). */
  async updateMissionTask(missionId: string, taskTitle: string, updates: {
    title?: string;
    description?: string;
    assignTo?: string;
    dependsOn?: string[];
    expectations?: unknown[];
    expectedOutcomes?: unknown[];
    maxDuration?: number;
    retryPolicy?: { escalateAfter?: number; fallbackAgent?: string };
    notifications?: unknown;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "tasks", tasks => {
      const idx = tasks.findIndex(t => t.title === taskTitle);
      if (idx === -1) throw new Error(`Task "${taskTitle}" not found in mission`);
      // If renaming, enforce unique title
      if (updates.title && updates.title !== taskTitle && tasks.some(t => t.title === updates.title)) {
        throw new Error(`Task title "${updates.title}" already exists in this mission`);
      }
      tasks[idx] = { ...tasks[idx], ...updates } as MissionDocumentParsed["tasks"][number];
    }, { missingError: `Task "${taskTitle}" not found in mission` });
  }

  /** Remove a task from the mission data (by title). Also cleans up dependsOn references. */
  async removeMissionTask(missionId: string, taskTitle: string): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "tasks", (tasks, doc) => {
      const idx = tasks.findIndex(t => t.title === taskTitle);
      if (idx === -1) throw new Error(`Task "${taskTitle}" not found in mission`);
      tasks.splice(idx, 1);
      // Clean up dependsOn references in remaining tasks
      for (const t of tasks) {
        if (t.dependsOn) {
          t.dependsOn = t.dependsOn.filter(d => d !== taskTitle);
        }
      }
      // Clean up quality gates and checkpoints that reference this task
      if (doc.qualityGates) {
        for (const gate of doc.qualityGates) {
          gate.afterTasks = gate.afterTasks.filter(t => t !== taskTitle);
          gate.blocksTasks = gate.blocksTasks.filter(t => t !== taskTitle);
        }
        // Remove gates that became empty
        doc.qualityGates = doc.qualityGates.filter(g => g.afterTasks.length > 0 && g.blocksTasks.length > 0);
      }
      if (doc.checkpoints) {
        for (const cp of doc.checkpoints) {
          cp.afterTasks = cp.afterTasks.filter(t => t !== taskTitle);
          cp.blocksTasks = cp.blocksTasks.filter(t => t !== taskTitle);
        }
        doc.checkpoints = doc.checkpoints.filter(cp => cp.afterTasks.length > 0 && cp.blocksTasks.length > 0);
      }
      if (doc.delays) {
        for (const dl of doc.delays) {
          dl.afterTasks = dl.afterTasks.filter(t => t !== taskTitle);
          dl.blocksTasks = dl.blocksTasks.filter(t => t !== taskTitle);
        }
        doc.delays = doc.delays.filter(dl => dl.afterTasks.length > 0 && dl.blocksTasks.length > 0);
      }
      // Ensure at least 1 task remains (Zod will catch this, but give a nicer error)
      if (tasks.length === 0) throw new Error("Cannot remove the last task from a mission");
    }, { missingError: `Task "${taskTitle}" not found in mission` });
  }

  /** Reorder tasks within the mission data. Accepts an array of task titles in the desired order. */
  async reorderMissionTasks(missionId: string, titles: string[]): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "tasks", (tasks, doc) => {
      const titleSet = new Set(titles);
      if (titleSet.size !== titles.length) throw new Error("Duplicate titles in reorder list");
      const existing = new Set(tasks.map(t => t.title));
      for (const t of titles) {
        if (!existing.has(t)) throw new Error(`Task "${t}" not found in mission`);
      }
      if (titles.length !== tasks.length) throw new Error("Reorder list must include all task titles");
      const taskMap = new Map(tasks.map(t => [t.title, t]));
      doc.tasks = titles.map(t => taskMap.get(t)!);
    });
  }

  // ─── Checkpoint operations ──────────────────────────

  /** Add a checkpoint to a mission's data. */
  async addMissionCheckpoint(missionId: string, checkpoint: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "checkpoints", checkpoints => {
      if (checkpoints.some(c => c.name === checkpoint.name)) {
        throw new Error(`Checkpoint "${checkpoint.name}" already exists in this mission`);
      }
      checkpoints.push(checkpoint);
    }, { createIfMissing: true });
  }

  /** Update a checkpoint in the mission data (matched by name). */
  async updateMissionCheckpoint(missionId: string, checkpointName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "checkpoints", checkpoints => {
      const idx = checkpoints.findIndex(c => c.name === checkpointName);
      if (idx === -1) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
      if (updates.name && updates.name !== checkpointName && checkpoints.some(c => c.name === updates.name)) {
        throw new Error(`Checkpoint "${updates.name}" already exists in this mission`);
      }
      checkpoints[idx] = { ...checkpoints[idx], ...updates };
    }, { missingError: `Checkpoint "${checkpointName}" not found in mission` });
  }

  /** Remove a checkpoint from the mission data (by name). */
  async removeMissionCheckpoint(missionId: string, checkpointName: string): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "checkpoints", checkpoints => {
      const idx = checkpoints.findIndex(c => c.name === checkpointName);
      if (idx === -1) throw new Error(`Checkpoint "${checkpointName}" not found in mission`);
      checkpoints.splice(idx, 1);
    }, { missingError: `Checkpoint "${checkpointName}" not found in mission` });
  }

  // ─── Delay operations ───────────────────────────────

  /** Add a delay to a mission's data. */
  async addMissionDelay(missionId: string, delay: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    duration: string;
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    // Validate duration format
    parseISO8601Duration(delay.duration);
    return this.mutateMissionCollection(missionId, "delays", delays => {
      if (delays.some(d => d.name === delay.name)) {
        throw new Error(`Delay "${delay.name}" already exists in this mission`);
      }
      delays.push(delay);
    }, { createIfMissing: true });
  }

  /** Update a delay in the mission data (matched by name). */
  async updateMissionDelay(missionId: string, delayName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    duration?: string;
    notifyChannels?: string[];
    message?: string;
  }): Promise<Mission> {
    if (updates.duration) parseISO8601Duration(updates.duration);
    return this.mutateMissionCollection(missionId, "delays", delays => {
      const idx = delays.findIndex(d => d.name === delayName);
      if (idx === -1) throw new Error(`Delay "${delayName}" not found in mission`);
      if (updates.name && updates.name !== delayName && delays.some(d => d.name === updates.name)) {
        throw new Error(`Delay "${updates.name}" already exists in this mission`);
      }
      delays[idx] = { ...delays[idx], ...updates };
    }, { missingError: `Delay "${delayName}" not found in mission` });
  }

  /** Remove a delay from the mission data (by name). */
  async removeMissionDelay(missionId: string, delayName: string): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "delays", delays => {
      const idx = delays.findIndex(d => d.name === delayName);
      if (idx === -1) throw new Error(`Delay "${delayName}" not found in mission`);
      delays.splice(idx, 1);
    }, { missingError: `Delay "${delayName}" not found in mission` });
  }

  // ─── Quality gate operations ────────────────────────

  /** Add a quality gate to a mission's data. */
  async addMissionQualityGate(missionId: string, gate: {
    name: string;
    afterTasks: string[];
    blocksTasks: string[];
    minScore?: number;
    requireAllPassed?: boolean;
    condition?: string;
    notifyChannels?: string[];
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "qualityGates", gates => {
      if (gates.some(g => g.name === gate.name)) {
        throw new Error(`Quality gate "${gate.name}" already exists in this mission`);
      }
      gates.push(gate);
    }, { createIfMissing: true });
  }

  /** Update a quality gate in the mission data (matched by name). */
  async updateMissionQualityGate(missionId: string, gateName: string, updates: {
    name?: string;
    afterTasks?: string[];
    blocksTasks?: string[];
    minScore?: number;
    requireAllPassed?: boolean;
    condition?: string;
    notifyChannels?: string[];
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "qualityGates", gates => {
      const idx = gates.findIndex(g => g.name === gateName);
      if (idx === -1) throw new Error(`Quality gate "${gateName}" not found in mission`);
      if (updates.name && updates.name !== gateName && gates.some(g => g.name === updates.name)) {
        throw new Error(`Quality gate "${updates.name}" already exists in this mission`);
      }
      gates[idx] = { ...gates[idx], ...updates };
    }, { missingError: `Quality gate "${gateName}" not found in mission` });
  }

  /** Remove a quality gate from the mission data (by name). */
  async removeMissionQualityGate(missionId: string, gateName: string): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "qualityGates", gates => {
      const idx = gates.findIndex(g => g.name === gateName);
      if (idx === -1) throw new Error(`Quality gate "${gateName}" not found in mission`);
      gates.splice(idx, 1);
    }, { missingError: `Quality gate "${gateName}" not found in mission` });
  }

  // ─── Team (volatile agents) operations ──────────────

  /** Add a team member to the mission's volatile team. */
  async addMissionTeamMember(missionId: string, member: {
    name: string;
    role?: string;
    model?: string;
    [key: string]: unknown;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "team", team => {
      if (team.some((m: any) => m.name === member.name)) {
        throw new Error(`Team member "${member.name}" already exists in this mission`);
      }
      team.push(member);
    }, { createIfMissing: true });
  }

  /** Update a team member in the mission data (matched by name). */
  async updateMissionTeamMember(missionId: string, memberName: string, updates: {
    name?: string;
    role?: string;
    model?: string;
    [key: string]: unknown;
  }): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "team", team => {
      const idx = team.findIndex((m: any) => m.name === memberName);
      if (idx === -1) throw new Error(`Team member "${memberName}" not found in mission`);
      if (updates.name && updates.name !== memberName && team.some((m: any) => m.name === updates.name)) {
        throw new Error(`Team member "${updates.name}" already exists in this mission`);
      }
      team[idx] = { ...team[idx], ...updates };
    }, { missingError: `Team member "${memberName}" not found in mission` });
  }

  /** Remove a team member from the mission data (by name). */
  async removeMissionTeamMember(missionId: string, memberName: string): Promise<Mission> {
    return this.mutateMissionCollection(missionId, "team", team => {
      const idx = team.findIndex((m: any) => m.name === memberName);
      if (idx === -1) throw new Error(`Team member "${memberName}" not found in mission`);
      team.splice(idx, 1);
    }, { missingError: `Team member "${memberName}" not found in mission` });
  }

  // ─── Notifications operations ───────────────────────

  /** Update the mission-level notification rules. */
  async updateMissionNotifications(missionId: string, notifications: ScopedNotificationRules | null): Promise<Mission> {
    const { doc } = await this.parseMissionData(missionId);
    if (notifications === null) {
      delete (doc as any).notifications;
    } else {
      (doc as any).notifications = notifications;
    }
    return this.persistMissionData(missionId, doc);
  }

  async buildMissionReport(missionId: string, group: string, groupTasks: Task[], allPassed: boolean): Promise<MissionReport> {
    const state = await this.ctx.taskStore.getState();
    const processes = state?.processes ?? [];

    const allFilesCreated = new Set<string>();
    const allFilesEdited = new Set<string>();
    let totalDuration = 0;
    const scores: number[] = [];
    const allOutcomes: TaskOutcome[] = [];

    const taskReports = groupTasks.map(t => {
      const duration = t.result?.duration ?? 0;
      totalDuration += duration;
      const score = t.result?.assessment?.globalScore;
      if (score !== undefined) scores.push(score);

      // Get file activity from processes (may already be gone for completed tasks)
      const proc = processes.find(p => p.taskId === t.id);
      const filesCreated = proc?.activity?.filesCreated ?? [];
      const filesEdited = proc?.activity?.filesEdited ?? [];
      for (const f of filesCreated) allFilesCreated.add(f);
      for (const f of filesEdited) allFilesEdited.add(f);

      // Aggregate outcomes across all tasks
      if (t.outcomes) {
        for (const o of t.outcomes) allOutcomes.push(o);
      }

      return {
        title: t.title,
        status: t.status as "done" | "failed",
        duration,
        score,
        filesCreated,
        filesEdited,
        outcomes: t.outcomes,
      };
    });

    const avgScore = scores.length > 0
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : undefined;

    return {
      missionId,
      group,
      allPassed,
      totalDuration,
      tasks: taskReports,
      filesCreated: [...allFilesCreated],
      filesEdited: [...allFilesEdited],
      outcomes: allOutcomes.length > 0 ? allOutcomes : undefined,
      avgScore,
    };
  }
}
