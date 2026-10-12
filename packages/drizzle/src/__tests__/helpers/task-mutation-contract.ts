import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@polpo-ai/core/task-store";
import type { TaskStatus } from "@polpo-ai/core/types";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Pause a real store operation after its read, before its write. Other
 * operations keep using the actual database. No timing/sleep race is needed. */
function pauseNextRead(store: TaskStore) {
  const read = store.getTask.bind(store);
  const ready = deferred(), release = deferred();
  const spy = vi.spyOn(store, "getTask").mockImplementationOnce(async id => {
    const task = await read(id);
    ready.resolve();
    await release.promise;
    return task;
  });
  return { ready: ready.promise, release: release.resolve, restore: () => spy.mockRestore() };
}

export function taskMutationContract(getStore: () => TaskStore) {
  describe("concurrent task mutations", () => {
    const create = async () => getStore().createTask({ title: "Original", description: "Task", assignTo: "agent",
      dependsOn: [], expectations: [], metrics: [], maxRetries: 3 });
    const advance = async (id: string, states: TaskStatus[]) => {
      for (const state of states) await getStore().transition(id, state);
    };

    it.each([
      { name: "completion over delayed failure", before: ["assigned", "in_progress", "review"], delayed: "failed", winner: ["done"], status: "done", retries: 0 },
      { name: "cancellation over delayed review", before: ["assigned", "in_progress"], delayed: "review", winner: ["failed"], status: "failed", retries: 0 },
      { name: "a new attempt with the same pending status", before: [], delayed: "assigned", winner: ["assigned", "in_progress", "failed", "pending"], status: "pending", retries: 1 },
      { name: "one retry increment for competing retries", before: ["assigned", "in_progress", "failed"], delayed: "pending", winner: ["pending"], status: "pending", retries: 1 },
    ] as const)("preserves $name", async ({ before, delayed, winner, status, retries }) => {
      const task = await create();
      await advance(task.id, [...before]);
      const gate = pauseNextRead(getStore());
      const outcome = getStore().transition(task.id, delayed).then(value => ({ value }), error => ({ error }));
      try {
        await gate.ready;
        await advance(task.id, [...winner]);
        gate.release();
        expect(await outcome).toHaveProperty("error");
        expect(await getStore().getTask(task.id)).toMatchObject({ status, retries });
      } finally { gate.release(); await outcome; gate.restore(); }
    });

    it.each(["failed", "done"] as const)("metadata updates cannot reopen a %s task or overwrite another patch", async status => {
      const task = await create();
      await advance(task.id, ["assigned", "in_progress"]);
      const gate = pauseNextRead(getStore());
      const outcome = getStore().updateTask(task.id, { sessionId: "late-session" });
      try {
        await gate.ready;
        await getStore().updateTask(task.id, { title: "Concurrent edit", metadata: { connectionNamespace: "app-b" } });
        await advance(task.id, status === "done" ? ["review", "done"] : ["failed"]);
        gate.release();
        expect(await outcome).toMatchObject({ status, sessionId: "late-session", title: "Concurrent edit", metadata: { connectionNamespace: "app-b" } });
        expect(await getStore().getTask(task.id)).toMatchObject({ status, sessionId: "late-session", title: "Concurrent edit", metadata: { connectionNamespace: "app-b" } });
      } finally { gate.release(); await outcome; gate.restore(); }
    });

    it("metadata updates preserve the new retry count and running status", async () => {
      const task = await create();
      await advance(task.id, ["assigned", "in_progress", "failed"]);
      const gate = pauseNextRead(getStore());
      const outcome = getStore().updateTask(task.id, { outcomes: [] });
      try {
        await gate.ready;
        await advance(task.id, ["pending", "assigned", "in_progress"]);
        gate.release();
        expect(await outcome).toMatchObject({ status: "in_progress", retries: 1 });
        expect(await getStore().getTask(task.id)).toMatchObject({ status: "in_progress", retries: 1 });
      } finally { gate.release(); await outcome; gate.restore(); }
    });

    it("returns the current row after a transition, including concurrent metadata", async () => {
      const task = await create();
      const gate = pauseNextRead(getStore());
      const outcome = getStore().transition(task.id, "assigned");
      try {
        await gate.ready;
        await getStore().updateTask(task.id, { title: "Concurrent edit" });
        gate.release();
        expect(await outcome).toMatchObject({ status: "assigned", title: "Concurrent edit" });
      } finally { gate.release(); await outcome; gate.restore(); }
    });

    it("does not allow an untyped metadata patch to bypass the state machine", async () => {
      const task = await create();
      await getStore().updateTask(task.id, { id: "forged", status: "done", title: "Edited" } as never);
      expect(await getStore().getTask(task.id)).toMatchObject({ id: task.id, status: "pending", title: "Edited" });
      expect(await getStore().getTask("forged")).toBeUndefined();
    });

    it("clears explicitly undefined optional fields while preserving omitted fields", async () => {
      const task = await create();
      await getStore().updateTask(task.id, { phase: "execution", sessionId: "keep-session", user: "keep-user",
        result: { exitCode: 0, stdout: "old", stderr: "", duration: 1 }, outcomes: [], metadata: { connectionNamespace: "old-app" } });
      const updated = await getStore().updateTask(task.id, { phase: undefined, result: undefined, outcomes: undefined, metadata: undefined });
      const expected = { phase: undefined, result: undefined, outcomes: undefined, metadata: undefined,
        sessionId: "keep-session", user: "keep-user", status: "pending", title: "Original" };
      expect(updated).toMatchObject(expected);
      expect(await getStore().getTask(task.id)).toMatchObject(expected);
    });
  });
}
