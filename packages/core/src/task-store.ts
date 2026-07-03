import type { Task, TaskStatus, PolpoState, Mission } from "./types.js";

/**
 * Abstract interface for task persistence.
 * Implementations can be JSON file, SQLite, PostgreSQL, or in-memory (for tests).
 *
 * All methods return Promise to support async backends (PostgreSQL, cloud DBs).
 * Synchronous implementations (SQLite, file) can simply use `async` keyword.
 */
export interface TaskStore {
  // State access
  getState(): Promise<PolpoState>;
  setState(partial: Partial<PolpoState>): Promise<void>;

  // Task CRUD
  addTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus }): Promise<Task>;
  getTask(taskId: string): Promise<Task | undefined>;
  getAllTasks(): Promise<Task[]>;
  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task>;
  removeTask(taskId: string): Promise<boolean>;
  removeTasks(filter: (task: Task) => boolean): Promise<number>;

  // State machine
  transition(taskId: string, newStatus: TaskStatus): Promise<Task>;

  /** Bypass state machine — sets status directly with mandatory reason logging.
   *  Use ONLY for recovery, race-condition fallbacks, and fix/Q&A re-runs. */
  unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Promise<Task>;

  // Lifecycle
  close?(): Promise<void> | void;

  // Mission persistence (legacy layout). The canonical contract is the
  // MissionStore interface (mission-store.ts) — consumers should go through
  // resolveMissionStore(ctx) rather than calling these optionals directly.
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  saveMission?(mission: Omit<Mission, "id" | "createdAt" | "updatedAt">): Promise<Mission>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  getMission?(missionId: string): Promise<Mission | undefined>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  getMissionByName?(name: string): Promise<Mission | undefined>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  getAllMissions?(): Promise<Mission[]>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  updateMission?(missionId: string, updates: Partial<Omit<Mission, "id">>): Promise<Mission>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  deleteMission?(missionId: string): Promise<boolean>;
  /** @deprecated Implement/consume MissionStore (mission-store.ts) instead. */
  nextMissionName?(): Promise<string>;
}
