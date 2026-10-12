import { describe, expect, it } from "vitest";
import type { Task, ApprovalRequest } from "@polpo-ai/core/types";
import { taskExecutionReference, type TaskApprovalDecision } from "@polpo-ai/core/task-execution";

export function approvalRequest(task: Task, id = "approval-a"): ApprovalRequest {
  return { id, taskId: task.id, gateId: "human", gateName: "Review", status: "pending",
    payload: { task }, requestedAt: "2026-10-11T12:00:00.000Z" };
}
export function approvalDecision(task: Task, expected: ApprovalRequest | null, next?: ApprovalRequest): TaskApprovalDecision {
  return { expected: taskExecutionReference(task), tasks: [{ taskId: task.id, snapshot: task }],
    approvals: [{ id: next?.id ?? expected!.id, expected, next }],
    operation: { type: "transition", status: "awaiting_approval" } };
}

/** Real adapters, including reads through independently constructed stores. */
export function taskApprovalContract(fixture: () => Promise<{ taskStore: any; runStore: any; approvalStore: any; other: any }>) {
  describe("joint Task/Run/Approval persistence", () => {
    async function setup() {
      const f = await fixture();
      const task = await f.taskStore.createTask({ title: "Read Drive", description: "Read the selected account", assignTo: "support",
        user: "person-a", metadata: { connectionNamespace: "app-a" }, dependsOn: [], expectations: [], metrics: [], maxRetries: 3 });
      const claimed = await f.taskStore.claimTaskExecution(taskExecutionReference(task), "approval-run");
      const request = approvalRequest(claimed.task);
      return { ...f, ...claimed, request };
    }

    it("commits a complete suspension with both approval requests and terminal Run", async () => {
      const f = await setup(), input = approvalDecision(f.task, null, f.request);
      input.approvals.push({ id: "approval-b", expected: null, next: approvalRequest(f.task, "approval-b") });
      const result = await f.taskStore.commitTaskApprovalDecision(input);
      expect(result.task).toMatchObject({ status: "awaiting_approval", executionRevision: 2, user: "person-a" });
      expect(result.task.activeRunId).toBeUndefined();
      expect(await f.other.taskStore.getTask(f.task.id)).toEqual(result.task);
      expect(await f.other.runStore.getRun(f.run.id)).toMatchObject({ status: "killed" });
      expect(await f.other.approvalStore.listByTask(f.task.id)).toHaveLength(2);
    });

    it.each([null, undefined, false, 0, "", "null", [], {}].map(payload => ({ payload })))
      ("preserves payload $payload through admission and resolution", async ({ payload }) => {
      const f = await setup(), request = { ...f.request, payload };
      const waiting = await f.taskStore.commitTaskApprovalDecision(approvalDecision(f.task, null, request));
      expect(await f.other.approvalStore.get(request.id)).toEqual(request);
      const resolved = { ...request, status: "approved" as const };
      const decision = approvalDecision(waiting.task, request, resolved);
      delete decision.operation;
      await f.other.taskStore.commitTaskApprovalDecision(decision);
      expect(await f.approvalStore.get(request.id)).toEqual(resolved);
      expect(await f.approvalStore.list("approved")).toEqual([resolved]);
      expect(await f.approvalStore.listByTask(f.task.id)).toEqual([resolved]);
      expect(await f.taskStore.getTask(f.task.id)).toEqual(waiting.task);
    });

    it.each(["retry", "input", "delete"])("does not publish a stale request after a Task %s", async change => {
      const f = await setup(), input = approvalDecision(f.task, null, f.request);
      if (change === "retry") await f.taskStore.mutateTaskExecution(taskExecutionReference(f.task), { type: "requeue", countRetry: false, reason: "New attempt" });
      if (change === "input") await f.taskStore.updateTask(f.task.id, { description: "Changed instructions" });
      if (change === "delete") await f.taskStore.deleteTask(f.task.id);
      const task = await f.taskStore.getTask(f.task.id), run = await f.runStore.getRun(f.run.id);
      await expect(f.taskStore.commitTaskApprovalDecision(input)).rejects.toMatchObject({ code: "task_execution_conflict" });
      expect(await f.other.taskStore.getTask(f.task.id)).toEqual(task);
      expect(await f.other.runStore.getRun(f.run.id)).toEqual(run);
      expect(await f.other.approvalStore.listByTask(f.task.id)).toEqual([]);
    });

    it("does not mutate the Task or another request when one approval snapshot conflicts", async () => {
      const f = await setup();
      await f.approvalStore.upsert(f.request);
      const input = approvalDecision(f.task, f.request, { ...f.request, status: "approved" });
      input.approvals.push({ id: "approval-b", expected: null, next: approvalRequest(f.task, "approval-b") });
      await f.other.approvalStore.upsert({ ...f.request, status: "rejected", note: "Another resolver" });
      await expect(f.taskStore.commitTaskApprovalDecision(input)).rejects.toMatchObject({ code: "task_approval_conflict" });
      expect(await f.taskStore.getTask(f.task.id)).toEqual(f.task);
      expect(await f.runStore.getRun(f.run.id)).toEqual(f.run);
      expect(await f.approvalStore.get("approval-b")).toBeUndefined();
      expect(await f.approvalStore.get(f.request.id)).toMatchObject({ status: "rejected" });
    });

    it("resolves one request while retaining the exact waiting Task and other pending gate", async () => {
      const f = await setup(), input = approvalDecision(f.task, null, f.request);
      const second = approvalRequest(f.task, "approval-b");
      input.approvals.push({ id: second.id, expected: null, next: second });
      const waiting = await f.taskStore.commitTaskApprovalDecision(input);
      const partial = approvalDecision(waiting.task, f.request, { ...f.request, status: "approved" });
      delete partial.operation;
      partial.approvals.push({ id: second.id, expected: second });
      expect(await f.taskStore.commitTaskApprovalDecision(partial)).toEqual({ task: waiting.task });
      expect(await f.other.taskStore.getTask(f.task.id)).toEqual(waiting.task);
      expect(await f.other.approvalStore.get(f.request.id)).toMatchObject({ status: "approved" });
      expect(await f.other.approvalStore.get(second.id)).toEqual(second);
    });

    it("publishes rejection feedback, count and requeue with its decision", async () => {
      const f = await setup();
      const waiting = await f.taskStore.commitTaskApprovalDecision(approvalDecision(f.task, null, f.request));
      const input = approvalDecision(waiting.task, f.request, { ...f.request, status: "rejected", note: "Use a smaller scope" });
      input.operation = { type: "requeue", countRetry: false, reason: "Rejected", updates: { description: "Revised input", revisionCount: 1, outcomes: [] } };
      const result = await f.taskStore.commitTaskApprovalDecision(input);
      expect(result.task).toMatchObject({ status: "pending", executionRevision: 3, revisionCount: 1, description: "Revised input", outcomes: [] });
      expect(await f.other.approvalStore.get(f.request.id)).toMatchObject({ status: "rejected", note: "Use a smaller scope" });
    });

    it("has one winner between concurrent approval and rejection", async () => {
      const f = await setup();
      const waiting = await f.taskStore.commitTaskApprovalDecision(approvalDecision(f.task, null, f.request));
      const decisions = ["approved", "rejected"].map(status => ({ ...approvalDecision(waiting.task, f.request, { ...f.request, status } as ApprovalRequest),
        operation: { type: "requeue", countRetry: false, reason: status } }));
      const results = await Promise.allSettled([f.taskStore, f.other.taskStore].map((store, i) => store.commitTaskApprovalDecision(decisions[i])));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await f.taskStore.getTask(f.task.id)).executionRevision).toBe(3);
      expect(["approved", "rejected"]).toContain((await f.approvalStore.get(f.request.id)).status);
    });

    it("checks approval read conditions in the same transaction as a new Run claim", async () => {
      const f = await setup();
      const pending = await f.taskStore.mutateTaskExecution(taskExecutionReference(f.task), { type: "requeue", countRetry: false, reason: "Awaiting dispatch" });
      const approved: ApprovalRequest = { ...f.request, status: "approved" };
      await f.approvalStore.upsert(approved);
      const input = approvalDecision(pending.task, approved);
      input.operation = { type: "claim", runId: "approved-run" };
      const result = await f.taskStore.commitTaskApprovalDecision(input);
      expect(result.task).toMatchObject({ status: "in_progress", activeRunId: "approved-run", executionRevision: 3 });
      expect(await f.other.runStore.getRun("approved-run")).toMatchObject({ status: "running", taskExecutionRevision: 3 });
      expect(await f.other.approvalStore.get(approved.id)).toEqual(approved);
      await expect(f.other.taskStore.commitTaskApprovalDecision(input)).rejects.toMatchObject({ code: "task_execution_conflict" });
    });

    it("rejects a changed approval even if it is still pending", async () => {
      const f = await setup();
      await f.approvalStore.upsert(f.request);
      const input = approvalDecision(f.task, f.request, { ...f.request, status: "approved" });
      await f.other.approvalStore.upsert({ ...f.request, payload: { changed: true } });
      await expect(f.taskStore.commitTaskApprovalDecision(input)).rejects.toMatchObject({ code: "task_approval_conflict" });
      expect(await f.taskStore.getTask(f.task.id)).toEqual(f.task);
      expect(await f.runStore.getRun(f.run.id)).toEqual(f.run);
    });

    it.each(["identity", "missing-task-snapshot", "foreign-task", "duplicate-approval", "terminal-rewrite"])("rejects invalid %s before writes", async kind => {
      const f = await setup();
      const input: any = approvalDecision(f.task, null, f.request);
      if (kind === "identity") input.approvals[0].next.id = "another-id";
      if (kind === "missing-task-snapshot") input.tasks = [];
      if (kind === "foreign-task") input.approvals[0].next.taskId = "other-task";
      if (kind === "duplicate-approval") input.approvals.push(structuredClone(input.approvals[0]));
      if (kind === "terminal-rewrite") {
        input.approvals[0].expected = { ...f.request, status: "approved" };
        input.approvals[0].next = { ...f.request, status: "rejected" };
      }
      await expect(f.taskStore.commitTaskApprovalDecision(input)).rejects.toThrow();
      expect(await f.taskStore.getTask(f.task.id)).toEqual(f.task);
      expect(await f.runStore.getRun(f.run.id)).toEqual(f.run);
      expect(await f.approvalStore.list()).toEqual([]);
    });
  });
}
