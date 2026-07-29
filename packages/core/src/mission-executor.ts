import type { OrchestratorContext } from "./orchestrator-context.js";
import type { TaskManager } from "./task-manager.js";
import type { AgentManager } from "./agent-manager.js";
import type { Mission, MissionStatus, MissionReport, Task, TaskExpectation, MissionQualityGate, MissionCheckpoint, MissionDelay, ScopedNotificationRules, TaskOutcome } from "./types.js";
import type { QualityController } from "./quality-controller.js";
import { sanitizeExpectations, parseMissionDocument, type MissionDocumentParsed } from "./schemas.js";
import { resolveMissionStore, resolveMissionForGroup, type MissionStore } from "./mission-store.js";
import { InMemoryCheckpointStore, InMemoryDelayStore } from "./in-memory-stores.js";
import { MissionGating, parseISO8601Duration } from "./mission-gating.js";
import { resolveConfiguredModelSelection } from "./model-profiles.js";

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
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      const groupTasks = allTasks.filter(t => t.group === group);
      if (groupTasks.every(t => t.status === "done" || t.status === "failed")) {
        this.cleanedGroups.add(group);
      }
    }
  }

  /** Set the quality controller instance (called by Orchestrator after init). */
  setQualityController(ctrl: QualityController): void {
    this.qualityCtrl = ctrl;
  }

  /** Get quality gates for a mission group. Returns empty array if none defined. */
  getQualityGates(group: string): MissionQualityGate[] {
    return this.gatesByGroup.get(group) ?? [];
  }

  // ─── Checkpoint/delay gating (delegated to MissionGating) ─────────────

  /** Get checkpoints for a mission group. Returns empty array if none defined. */
  getCheckpoints(group: string): MissionCheckpoint[] {
    return this.gating.getCheckpoints(group);
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
    return this.gating.getBlockingCheckpoint(group, taskTitle, taskId, tasks);
  }

  /**
   * Resume a checkpoint, unblocking its blocksTasks.
   * Returns true if the checkpoint was active and is now resumed, false if not found.
   */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    return this.gating.resumeCheckpoint(group, checkpointName);
  }

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints(): Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }> {
    return this.gating.getActiveCheckpoints();
  }

  /** Get delays for a mission group. Returns empty array if none defined. */
  getDelays(group: string): MissionDelay[] {
    return this.gating.getDelays(group);
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
    return this.gating.getBlockingDelay(group, taskTitle, taskId, tasks);
  }

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays(): Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }> {
    return this.gating.getActiveDelays();
  }

  async createMission(opts: {
    data: string;
    prompt?: string;
    name?: string;
    status?: MissionStatus;
    /** Cron expression or ISO timestamp for scheduled execution. */
    schedule?: string;
    /** Absolute deadline for the entire mission (ISO timestamp). */
    deadline?: string;
    /** End date for recurring schedules (ISO timestamp). */
    endDate?: string;
    notifications?: ScopedNotificationRules;
    /** Opaque end-user identifier (OpenAI-compat). */
    user?: string;
  }): Promise<Mission> {
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

    // ── Cascade cleanup ──────────────────────────────────

    // 1. Kill running processes and remove all tasks belonging to this mission
    const missionGroup = mission.name;
    const deletedTasks = await this.taskMgr.clearTasks(
      t => t.missionId === missionId || t.group === missionGroup,
    );

    // 2. Clean up volatile agents registered for this mission group
    await this.agentMgr.cleanupVolatileAgents(missionGroup);

    // 3. Clean up in-memory quality gates
    this.gatesByGroup.delete(missionGroup);
    // Also clean numbered groups for recurring missions (e.g. "mission-1 #2", "mission-1 #3")
    for (const key of this.gatesByGroup.keys()) {
      if (key.startsWith(missionGroup + " #")) this.gatesByGroup.delete(key);
    }

    // 4. Clean up persisted checkpoints and delays (incl. numbered recurring-run groups)
    await this.gating.removeGroupAndRuns(missionGroup);

    // 5. Clean up scheduled origin cache
    this.scheduledOrigin.delete(missionGroup);
    for (const key of this.scheduledOrigin.keys()) {
      if (key.startsWith(missionGroup + " #")) this.scheduledOrigin.delete(key);
    }

    // 6. Allow re-cleanup if the group is ever recreated
    this.cleanedGroups.delete(missionGroup);
    for (const key of this.cleanedGroups) {
      if (key.startsWith(missionGroup + " #")) this.cleanedGroups.delete(key);
    }

    // ── Delete the mission record ────────────────────────
    const result = await this.missions.deleteMission(missionId);
    if (result) {
      this.ctx.emitter.emit("mission:deleted", { missionId, deletedTasks });
    }
    return result;
  }

  async getResumableMissions(): Promise<Mission[]> {
    const missions = await this.listMissions();
    const state = await this.ctx.taskStore.getState();
    return missions.filter(m => {
      // Non-resumable statuses: draft (never executed), scheduled/recurring (scheduler handles),
      // completed (done), cancelled (aborted)
      if (m.status === "draft" || m.status === "scheduled" || m.status === "recurring" ||
          m.status === "completed" || m.status === "cancelled") return false;
      const tasks = state.tasks.filter(t => t.group === m.name);
      if (tasks.length === 0) return false;
      return tasks.some(t => t.status === "pending" || t.status === "failed");
    });
  }

  async resumeMission(missionId: string, opts?: { retryFailed?: boolean }): Promise<{ retried: number; pending: number }> {
    const mission = await this.getMission(missionId);
    if (!mission) throw new Error("Mission not found");

    // Re-register volatile agents if they were cleaned up
    this.cleanedGroups.delete(mission.name);
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && mission.data) {
      try {
        const doc = JSON.parse(mission.data) as MissionDocumentParsed;
        if (doc?.team && Array.isArray(doc.team)) {
          for (const a of doc.team) {
            if (!a.name) continue;
            const { name, ...rest } = a;
            await this.agentMgr.addVolatileAgent({ name, ...rest }, mission.name);
          }
        }
      } catch (err) {
        this.ctx.emitter.emit("log", { level: "warn", message: `Failed to re-register volatile agents for ${mission.name}: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const state = await this.ctx.taskStore.getState();
    const tasks = state.tasks.filter(t => t.group === mission.name);
    const failedTasks = tasks.filter(t => t.status === "failed");
    const pendingTasks = tasks.filter(t => t.status === "pending");

    let retried = 0;
    if (opts?.retryFailed) {
      for (const task of failedTasks) {
        try {
          await this.taskMgr.retryTask(task.id);
          retried++;
        } catch { /* no retries left — skip */
        }
      }
    }

    if (mission.status === "failed") {
      await this.updateMission(missionId, { status: "active" });
    }

    this.ctx.emitter.emit("mission:resumed", { missionId, name: mission.name, retried, pending: pendingTasks.length });
    return { retried, pending: pendingTasks.length };
  }

  async executeMission(missionId: string): Promise<{ tasks: Task[]; group: string }> {
    const mission = await this.missions.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    const executableStates = ["draft", "scheduled", "recurring", "failed", "cancelled"];
    if (!executableStates.includes(mission.status)) {
      throw new Error(`Cannot execute mission in "${mission.status}" state`);
    }
    // Remember whether this is a scheduled/recurring mission so we can restore status after completion
    const scheduledStatus = mission.status === "scheduled" || mission.status === "recurring" ? mission.status : undefined;

    // Increment execution count (tracks how many times this mission has run — useful for recurring)
    const runNumber = (mission.executionCount ?? 0) + 1;
    await this.missions.updateMission(missionId, { executionCount: runNumber });

    // Validate mission document through Zod schema — throws with clear error on invalid shape
    const raw = JSON.parse(mission.data);
    const doc = parseMissionDocument(raw);

    // For recurring/scheduled missions with multiple runs, disambiguate the group with a run number
    const group = runNumber > 1 ? `${mission.name} #${runNumber}` : mission.name;

    // Run before:mission:execute hook
    const hookResult = this.ctx.hooks.runBeforeSync("mission:execute", {
      missionId,
      mission,
      taskCount: doc.tasks.length,
    });
    if (hookResult.cancelled) {
      throw new Error(`Mission execution blocked by hook: ${hookResult.cancelReason ?? "no reason"}`);
    }

    // Register volatile agents from the mission's team section
    const enableVolatile = this.ctx.config.settings.enableVolatileTeams !== false;
    if (enableVolatile && doc.team && Array.isArray(doc.team)) {
      for (const a of doc.team) {
        if (!a.name) continue;
        const { name, ...rest } = a;
        await this.agentMgr.addVolatileAgent({ name, ...rest }, group);
      }
    }

    // Validate API keys for all agents referenced in the mission
    const allAgents = await this.agentMgr.getAgents();
    const referencedModels: string[] = [];
    for (const t of doc.tasks) {
      const agentName = t.assignTo || allAgents[0]?.name;
      const agent = allAgents.find(a => a.name === agentName);
      if (agent?.model) {
        referencedModels.push(...resolveConfiguredModelSelection(
          agent.model,
          this.ctx.config.settings,
          agent.allowedModelProfiles,
        ).policy.candidates);
      } else if (!agent) {
        throw new Error(
          `Mission references agent "${agentName}" (task "${t.title}") but no such agent exists. ` +
          `Available agents: ${allAgents.map(a => a.name).join(", ")}`
        );
      }
    }
    if (referencedModels.length > 0 && this.ctx.validateProviderKeys) {
      const missing = this.ctx.validateProviderKeys(referencedModels);
      if (missing.length > 0) {
        const details = missing
          .map(m => `${m.provider} (model: ${m.modelSpec})`)
          .join(", ");
        throw new Error(
          `Missing API keys for providers: ${details}. ` +
          `Set the corresponding environment variables or add them to polpo.json providers section.`
        );
      }
    }

    // Create tasks with dependency resolution
    const titleToId = new Map<string, string>();
    const tasks: Task[] = [];
    for (const t of doc.tasks) {
      const deps = (t.dependsOn || [])
        .map((title: string) => titleToId.get(title))
        .filter((id: string | undefined): id is string => !!id);

      // Validate expectations through Zod schemas
      let expectations: TaskExpectation[] = [];
      if (t.expectations && Array.isArray(t.expectations) && t.expectations.length > 0) {
        const { valid, warnings } = sanitizeExpectations(t.expectations);
        expectations = valid;
        for (const w of warnings) {
          this.ctx.emitter.emit("log", { level: "warn", message: `Mission task "${t.title}": ${w}` });
        }
      }

      const task = await this.taskMgr.createTask({
        title: t.title,
        description: t.description || t.title,
        assignTo: t.assignTo || (await this.agentMgr.getAgents())[0]?.name || "default",
        dependsOn: deps,
        expectations,
        expectedOutcomes: t.expectedOutcomes,
        group,
        missionId,
        maxDuration: t.maxDuration,
        retryPolicy: t.retryPolicy,
        notifications: t.notifications,
        sideEffects: t.sideEffects,
      });
      titleToId.set(t.title, task.id);
      tasks.push(task);
    }

    // Store quality gates (in-memory) and checkpoints (persisted to disk)
    if (doc.qualityGates && doc.qualityGates.length > 0) {
      this.gatesByGroup.set(group, doc.qualityGates as MissionQualityGate[]);
    }
    if (doc.checkpoints && doc.checkpoints.length > 0) {
      await this.gating.setCheckpointDefinitions(group, doc.checkpoints as MissionCheckpoint[]);
    }
    if (doc.delays && doc.delays.length > 0) {
      await this.gating.setDelayDefinitions(group, doc.delays as MissionDelay[]);
    }

    // Track scheduled origin so we know where to return after completion
    if (scheduledStatus) {
      this.scheduledOrigin.set(group, scheduledStatus);
    }

    // Persist mission-level notifications from document onto the Mission record
    if (doc.notifications) {
      await this.missions.updateMission(missionId, { status: "active", notifications: doc.notifications });
    } else {
      // Mark mission as active
      await this.missions.updateMission(missionId, { status: "active" });
    }
    this.ctx.emitter.emit("mission:executed", { missionId, group, taskCount: tasks.length });

    return { tasks, group };
  }

  /** Check if any mission groups have all tasks terminal, and clean up their volatile agents */
  async cleanupCompletedGroups(tasks: Task[]): Promise<void> {
    const groups = new Set<string>();
    for (const t of tasks) {
      if (t.group) groups.add(t.group);
    }
    for (const group of groups) {
      const groupTasks = tasks.filter(t => t.group === group);
      const allTerminal = groupTasks.every(t => t.status === "done" || t.status === "failed");

      // If tasks went back to non-terminal (e.g. individual retry via retryTask),
      // clear the cleaned flag so the group will be re-evaluated when done again.
      if (!allTerminal && this.cleanedGroups.has(group)) {
        this.cleanedGroups.delete(group);
        continue;
      }

      if (this.cleanedGroups.has(group)) continue;
      if (!allTerminal) continue;

      const cleanupPolicy = this.ctx.config.settings.volatileCleanup ?? "on_complete";
      if (cleanupPolicy === "on_complete") {
        await this.agentMgr.cleanupVolatileAgents(group);
      }
      this.cleanedGroups.add(group);

      // Auto-update mission status
      const mission = await resolveMissionForGroup(this.missions, groupTasks, group);
      if (mission && mission.status === "active") {
        let allDone = groupTasks.every(t => t.status === "done");

        // Check mission quality threshold (only if all tasks passed structurally)
        if (allDone && this.qualityCtrl) {
          const thresholdResult = this.qualityCtrl.checkMissionThreshold(
            mission,
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
        await this.missions.updateMission(mission.id, { status: finalStatus });
        const report = await this.buildMissionReport(mission.id, group, groupTasks, allDone);
        this.ctx.emitter.emit("mission:completed", { missionId: mission.id, group, allPassed: allDone, report });

        // Aggregate mission metrics
        this.qualityCtrl?.aggregateMissionMetrics(mission.id, groupTasks);

        // Clean up gate, checkpoint, delay, and scheduled-origin caches
        this.gatesByGroup.delete(group);
        this.scheduledOrigin.delete(group);
        // Clean up persisted checkpoint and delay entries for this group
        await this.gating.removeGroup(group);
      }
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
