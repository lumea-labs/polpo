/**
 * MissionGating — runtime checkpoint/delay gating for mission task flow.
 *
 * Owns the persisted checkpoint/delay state (definitions, active entries,
 * resumed/expired keys) and the "checkpoint:*" / "delay:*" event emission.
 * MissionExecutor instantiates one and delegates to it — the public surface
 * stays on MissionExecutor.
 */

import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Mission, Task, MissionCheckpoint, MissionDelay } from "./types.js";
import type { CheckpointStore, CheckpointState } from "./checkpoint-store.js";
import type { DelayStore, DelayState } from "./delay-store.js";
import { resolveMissionStore, resolveMissionForGroup, type MissionStore } from "./mission-store.js";

export class MissionGating {
  private missions: MissionStore;
  /** In-memory mirror of persisted checkpoint state (synced on every mutation) */
  private cpState!: CheckpointState;
  /** In-memory mirror of persisted delay state (synced on every mutation) */
  private delayState!: DelayState;

  /** Resolves when the persisted checkpoint/delay state has been loaded. */
  readonly ready: Promise<void>;

  constructor(
    private ctx: OrchestratorContext,
    private cpStore: CheckpointStore,
    private delayStore: DelayStore,
  ) {
    this.missions = resolveMissionStore(ctx);
    this.ready = this.loadState();
  }

  /** Async init: load persisted checkpoint/delay state. */
  private async loadState(): Promise<void> {
    this.cpState = await this.cpStore.load();
    this.delayState = await this.delayStore.load();
  }

  // ─── Definitions lifecycle ──────────────────────────

  /** Get checkpoints for a mission group. Returns empty array if none defined. */
  getCheckpoints(group: string): MissionCheckpoint[] {
    return this.cpState?.definitions?.[group] ?? [];
  }

  /** Get delays for a mission group. Returns empty array if none defined. */
  getDelays(group: string): MissionDelay[] {
    return this.delayState?.definitions?.[group] ?? [];
  }

  /** Register (persist) checkpoint definitions for a mission group. */
  async setCheckpointDefinitions(group: string, checkpoints: MissionCheckpoint[]): Promise<void> {
    this.cpState.definitions[group] = checkpoints;
    await this.cpStore.save(this.cpState);
  }

  /** Register (persist) delay definitions for a mission group. */
  async setDelayDefinitions(group: string, delays: MissionDelay[]): Promise<void> {
    this.delayState.definitions[group] = delays;
    await this.delayStore.save(this.delayState);
  }

  /** Remove persisted checkpoint and delay entries for a mission group. */
  async removeGroup(group: string): Promise<void> {
    this.cpState = await this.cpStore.removeGroup(this.cpState, group);
    this.delayState = await this.delayStore.removeGroup(this.delayState, group);
  }

  /**
   * Remove persisted checkpoint and delay entries for a mission group AND all
   * its numbered run groups (recurring missions, e.g. "mission-1 #2", "mission-1 #3").
   */
  async removeGroupAndRuns(missionGroup: string): Promise<void> {
    this.cpState = await this.cpStore.removeGroup(this.cpState, missionGroup);
    for (const key of Object.keys(this.cpState.definitions)) {
      if (key.startsWith(missionGroup + " #")) {
        this.cpState = await this.cpStore.removeGroup(this.cpState, key);
      }
    }
    this.delayState = await this.delayStore.removeGroup(this.delayState, missionGroup);
    for (const key of Object.keys(this.delayState.definitions)) {
      if (key.startsWith(missionGroup + " #")) {
        this.delayState = await this.delayStore.removeGroup(this.delayState, key);
      }
    }
  }

  // ─── Checkpoint runtime ─────────────────────────────

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
    const checkpoints = this.cpState?.definitions?.[group];
    if (!checkpoints) return undefined;

    for (const cp of checkpoints) {
      // Task must be in blocksTasks
      if (!cp.blocksTasks.includes(taskTitle) && !cp.blocksTasks.includes(taskId)) {
        continue;
      }

      const cpKey = `${group}:${cp.name}`;

      // Already resumed — don't block
      if (this.cpState.resumed.includes(cpKey)) continue;

      // Check if all afterTasks are done
      const afterTasks = tasks.filter(
        t => cp.afterTasks.includes(t.title) || cp.afterTasks.includes(t.id),
      );
      const allDone = afterTasks.length >= cp.afterTasks.length &&
        afterTasks.every(t => t.status === "done" || t.status === "failed");

      if (!allDone) {
        // afterTasks not finished yet — checkpoint not reached, don't block (deps will block naturally)
        continue;
      }

      // Checkpoint reached — activate it if not already active
      if (!this.cpState.active[cpKey]) {
        const reachedAt = new Date().toISOString();
        this.cpState.active[cpKey] = { checkpoint: cp, reachedAt };
        await this.cpStore.save(this.cpState);

        // Pause the mission — use task.missionId when available
        const taskMissionId = tasks.find(t => t.group === group && t.missionId)?.missionId;
        const mission = taskMissionId
          ? await this.missions.getMission(taskMissionId)
          : await this.missions.getMissionByName(group);
        if (mission && mission.status === "active") {
          await this.missions.updateMission(mission.id, { status: "paused" });
        }

        // Register notification rules for this checkpoint's channels
        this.ensureCheckpointNotificationRules(cpKey, cp);

        // Emit event (picked up by notification router if rules are configured)
        this.ctx.emitter.emit("checkpoint:reached", {
          missionId: mission?.id,
          group,
          checkpointName: cp.name,
          message: cp.message,
          afterTasks: cp.afterTasks,
          blocksTasks: cp.blocksTasks,
          reachedAt,
        });
      }

      // Return the blocking checkpoint
      return this.cpState.active[cpKey];
    }

    return undefined;
  }

  /**
   * Resume a checkpoint, unblocking its blocksTasks.
   * Returns true if the checkpoint was active and is now resumed, false if not found.
   */
  async resumeCheckpoint(group: string, checkpointName: string): Promise<boolean> {
    const cpKey = `${group}:${checkpointName}`;
    const active = this.cpState.active[cpKey];
    if (!active) return false;

    this.cpState.resumed.push(cpKey);
    delete this.cpState.active[cpKey];
    await this.cpStore.save(this.cpState);

    // Un-pause the mission (back to active) — resolve via missionId from tasks
    const groupTasks = (await this.ctx.taskStore.listTasks()).filter(t => t.group === group);
    const mission = await resolveMissionForGroup(this.missions, groupTasks, group);
    if (mission && mission.status === "paused") {
      await this.missions.updateMission(mission.id, { status: "active" });
    }

    this.ctx.emitter.emit("checkpoint:resumed", {
      missionId: mission?.id,
      group,
      checkpointName,
    });

    return true;
  }

  /** Get all active (unresumed) checkpoints across all mission groups. */
  getActiveCheckpoints(): Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }> {
    const result: Array<{ group: string; checkpointName: string; checkpoint: MissionCheckpoint; reachedAt: string }> = [];
    for (const [cpKey, data] of Object.entries(this.cpState.active)) {
      const [group, ...nameParts] = cpKey.split(":");
      const checkpointName = nameParts.join(":");
      result.push({ group, checkpointName, checkpoint: data.checkpoint, reachedAt: data.reachedAt });
    }
    return result;
  }

  /** Notification rules for checkpoints removed — no-op. */
  private ensureCheckpointNotificationRules(_cpKey: string, _cp: MissionCheckpoint): void {
    // No-op: notification routing removed.
  }

  // ─── Delay runtime ──────────────────────────────────

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
    const delays = this.delayState?.definitions?.[group];
    if (!delays) return undefined;

    for (const dl of delays) {
      // Task must be in blocksTasks
      if (!dl.blocksTasks.includes(taskTitle) && !dl.blocksTasks.includes(taskId)) {
        continue;
      }

      const dlKey = `${group}:${dl.name}`;

      // Already expired — don't block
      if (this.delayState.expired.includes(dlKey)) continue;

      // Check if all afterTasks are done
      const afterTasks = tasks.filter(
        t => dl.afterTasks.includes(t.title) || dl.afterTasks.includes(t.id),
      );
      const allDone = afterTasks.length >= dl.afterTasks.length &&
        afterTasks.every(t => t.status === "done" || t.status === "failed");

      if (!allDone) {
        // afterTasks not finished yet — delay not triggered, don't block (deps will block naturally)
        continue;
      }

      // Delay triggered — activate timer if not already active
      if (!this.delayState.active[dlKey]) {
        const startedAt = new Date().toISOString();
        const durationMs = parseISO8601Duration(dl.duration);
        const expiresAt = new Date(Date.now() + durationMs).toISOString();
        this.delayState.active[dlKey] = { delay: dl, startedAt, expiresAt };
        await this.delayStore.save(this.delayState);

        // Register notification rules for this delay's channels
        this.ensureDelayNotificationRules(dlKey, dl);

        // Emit event
        const mission = await this.resolveMissionForGroupByName(group);
        this.ctx.emitter.emit("delay:started", {
          missionId: mission?.id,
          group,
          delayName: dl.name,
          duration: dl.duration,
          message: dl.message,
          afterTasks: dl.afterTasks,
          blocksTasks: dl.blocksTasks,
          startedAt,
          expiresAt,
        });
      }

      // Check if the timer has expired
      const active = this.delayState.active[dlKey];
      if (new Date(active.expiresAt).getTime() <= Date.now()) {
        // Timer expired — mark as expired and unblock
        this.delayState.expired.push(dlKey);
        delete this.delayState.active[dlKey];
        await this.delayStore.save(this.delayState);

        const mission = await this.resolveMissionForGroupByName(group);
        this.ctx.emitter.emit("delay:expired", {
          missionId: mission?.id,
          group,
          delayName: dl.name,
        });

        continue; // Unblocked — check next delay
      }

      // Still waiting — return the blocking delay
      return active;
    }

    return undefined;
  }

  /** Get all active (unexpired) delays across all mission groups. */
  getActiveDelays(): Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }> {
    const result: Array<{ group: string; delayName: string; delay: MissionDelay; startedAt: string; expiresAt: string }> = [];
    for (const [dlKey, data] of Object.entries(this.delayState.active)) {
      const [group, ...nameParts] = dlKey.split(":");
      const delayName = nameParts.join(":");
      result.push({ group, delayName, delay: data.delay, startedAt: data.startedAt, expiresAt: data.expiresAt });
    }
    return result;
  }

  /** Notification rules for delays removed — no-op. */
  private ensureDelayNotificationRules(_dlKey: string, _dl: MissionDelay): void {
    // No-op: notification routing removed.
  }

  /** Resolve a mission by group name (helper for delay/checkpoint events). */
  private async resolveMissionForGroupByName(group: string): Promise<Mission | undefined> {
    const groupTasks = (await this.ctx.taskStore.listTasks()).filter(t => t.group === group);
    return resolveMissionForGroup(this.missions, groupTasks, group);
  }
}

// ── ISO 8601 Duration Parser ──────────────────────────────────────────
// Supports: P[nY][nM][nW][nD][T[nH][nM][nS]]
// Examples: PT2H (2 hours), PT30M (30 min), P1D (1 day), P1DT6H (1 day 6 hours)

const ISO_DURATION_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

export function parseISO8601Duration(duration: string): number {
  const m = ISO_DURATION_RE.exec(duration);
  if (!m) throw new Error(`Invalid ISO 8601 duration: "${duration}"`);
  const years   = parseInt(m[1] || "0", 10);
  const months  = parseInt(m[2] || "0", 10);
  const weeks   = parseInt(m[3] || "0", 10);
  const days    = parseInt(m[4] || "0", 10);
  const hours   = parseInt(m[5] || "0", 10);
  const minutes = parseInt(m[6] || "0", 10);
  const seconds = parseFloat(m[7] || "0");
  // Approximate: 1 year ≈ 365.25 days, 1 month ≈ 30.44 days
  const totalDays = years * 365.25 + months * 30.44 + weeks * 7 + days;
  return ((totalDays * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
}
