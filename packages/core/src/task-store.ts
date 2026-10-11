import type { Task, TaskStatus, PolpoState } from "./types.js";

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
  createTask(task: Omit<Task, "id" | "status" | "retries" | "createdAt" | "updatedAt"> & { status?: TaskStatus }): Promise<Task>;
  getTask(taskId: string): Promise<Task | undefined>;
  listTasks(): Promise<Task[]>;
  /** Patch only the supplied fields; explicit undefined clears optional fields.
   * Never rewrite status from an earlier read.
   * Return the row produced by the write, preserving concurrent unrelated edits. */
  updateTask(taskId: string, updates: Partial<Omit<Task, "id" | "status">>): Promise<Task>;
  deleteTask(taskId: string): Promise<boolean>;
  deleteTasks(filter: (task: Task) => boolean): Promise<number>;

  // State machine
  /** Validate and write against the same observed status/retry count atomically.
   * Reject a concurrent state change rather than overwriting it. */
  transition(taskId: string, newStatus: TaskStatus): Promise<Task>;

  /** Bypass state machine — sets status directly with mandatory reason logging.
   * Use only for explicit recovery/admin operations and fix/Q&A re-runs,
   * never to force a failed concurrent transition. */
  unsafeSetStatus(taskId: string, newStatus: TaskStatus, reason: string): Promise<Task>;

  // Lifecycle
  close?(): Promise<void> | void;

}
