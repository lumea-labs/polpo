import { describe, expect, it, vi } from "vitest";
import { TaskExecutionError } from "@polpo-ai/core/task-execution";
import { taskRoutes } from "./tasks.js";
import { Hono } from "hono";
import { FileTaskStore, FileRunStore } from "@polpo-ai/file-stores";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { taskExecutionReference } from "@polpo-ai/core/task-execution";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe.each(["kill", "force-fail"])("Task %s execution errors", endpoint => {
  it("preserves the host error handler for other failures", async () => {
    const cancel = vi.fn(async () => { throw new Error("fixture host error"); });
    const host = new Hono();
    host.onError((_error, c) => c.json({ code: "HOST_ERROR" }, 503));
    host.route("/tasks", taskRoutes(() => ({ taskStore: { getTask: async () => ({ id: "task" }) }, killTask: cancel, forceFailTask: cancel } as never)));
    const response = await host.request(`/tasks/task/${endpoint}`, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "HOST_ERROR" });
  });
  it.each([["task_execution_conflict", 409], ["task_execution_invalid", 400], ["task_execution_unsupported", 501]] as const)("maps %s without retrying a newer attempt", async (code, status) => {
    const cancel = vi.fn(async () => { throw new TaskExecutionError(code, "Fixture execution changed"); });
    const app = taskRoutes(() => ({ taskStore: { getTask: async () => ({ id: "task" }) }, killTask: cancel, forceFailTask: cancel } as never));
    const response = await app.request(`/task/${endpoint}`, { method: "POST" });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

it("force-fail retains the attempt captured by its HTTP existence check", async () => {
  const root = mkdtempSync(join(tmpdir(), "polpo-http-cancel-"));
  const taskStore = new FileTaskStore(root), runStore = new FileRunStore(root);
  const cancelRun = vi.fn();
  const manager = new TaskManager({ taskStore, runStore, spawner: { cancelRun } } as never);
  try {
    const task = await taskStore.createTask({ title: "First", description: "First", assignTo: "support",
      dependsOn: [], expectations: [], metrics: [], maxRetries: 2 });
    const first = await taskStore.claimTaskExecution(taskExecutionReference(task), "first");
    const read = taskStore.getTask.bind(taskStore);
    vi.spyOn(taskStore, "getTask").mockImplementationOnce(async () => {
      await taskStore.mutateTaskExecution(taskExecutionReference(first.task), { type: "cancel" });
      const pending = await taskStore.transition(task.id, "pending");
      await taskStore.claimTaskExecution(taskExecutionReference(pending), "second");
      return first.task;
    });
    const app = taskRoutes(() => ({ taskStore, forceFailTask: manager.forceFailTask.bind(manager) } as never));
    const response = await app.request(`/${task.id}/force-fail`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "task_execution_conflict" });
    expect(await read(task.id)).toMatchObject({ activeRunId: "second", status: "in_progress" });
    expect(await runStore.getRun("second")).toMatchObject({ status: "running" });
    expect(cancelRun).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
