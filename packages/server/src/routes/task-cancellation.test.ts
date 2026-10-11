import { describe, expect, it, vi } from "vitest";
import { TaskExecutionError } from "@polpo-ai/core/task-execution";
import { taskRoutes } from "./tasks.js";
import { Hono } from "hono";

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
