import { describe, expect, it } from "vitest";
import { MemoryLoopRunStore } from "@polpo-ai/core";
import type { ApprovalRequest, ApprovalStatus } from "@polpo-ai/core";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import { loopRunRoutes } from "./loop-runs.js";

class MemoryApprovalStore implements ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRequest>();

  async upsert(request: ApprovalRequest): Promise<void> {
    this.approvals.set(request.id, structuredClone(request));
  }

  async get(id: string): Promise<ApprovalRequest | undefined> {
    const approval = this.approvals.get(id);
    return approval ? structuredClone(approval) : undefined;
  }

  async list(status?: ApprovalStatus): Promise<ApprovalRequest[]> {
    return Array.from(this.approvals.values())
      .filter((approval) => !status || approval.status === status)
      .map((approval) => structuredClone(approval));
  }

  async listByTask(taskId: string): Promise<ApprovalRequest[]> {
    return Array.from(this.approvals.values())
      .filter((approval) => approval.taskId === taskId)
      .map((approval) => structuredClone(approval));
  }

  async delete(id: string): Promise<boolean> {
    return this.approvals.delete(id);
  }
}

describe("loopRunRoutes", () => {
  it("resolves approval gates and updates the loop run audit record", async () => {
    const loopRunStore = new MemoryLoopRunStore();
    const approvalStore = new MemoryApprovalStore();
    const app = loopRunRoutes(() => ({ loopRunStore, approvalStore }));

    const run = await loopRunStore.createRun({
      id: "run-1",
      loop: { name: "deploy-flow" },
    });
    await approvalStore.upsert({
      id: "approval-1",
      gateId: "deploy-approval",
      gateName: "Deploy approval",
      status: "pending",
      payload: { loopRunId: run.id },
      requestedAt: new Date().toISOString(),
    });
    await loopRunStore.updateRun(run.id, {
      status: "awaiting_approval",
      approvalRequestId: "approval-1",
      approval: {
        type: "permission",
        policyId: "permission",
        permissionId: "deploy-approval",
        hook: "tool:before",
        payload: {},
        context: {},
        status: "pending",
      },
    });

    const response = await app.request("/run-1/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolvedBy: "security", note: "approved for release window" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe("approval_approved");
    expect(body.data.approval.status).toBe("approved");
    expect(body.data.metadata.approvalResolvedBy).toBe("security");
    expect((await approvalStore.get("approval-1"))?.status).toBe("approved");
    expect((await loopRunStore.getRun("run-1"))?.trace.at(-1)?.data?.decision).toBe("approved");
  });
});
