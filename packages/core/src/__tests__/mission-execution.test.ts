import { describe, expect, it } from "vitest";
import { admitMissionExecution, normalizeMissionExecutionCommit, validateMissionExecutionKey, type MissionExecutionCommit } from "../mission-execution.js";

function plan(): MissionExecutionCommit {
  const now = "2026-10-11T06:00:00.000Z";
  return {
    expected: { id: "mission", name: "Example", data: "{}", status: "draft", user: "customer-a", createdAt: now, updatedAt: now },
    receipt: { executionId: "execution", missionId: "mission", idempotencyKey: "occurrence", group: "Example", sequence: 1,
      user: "customer-a", createdAt: now, tasks: [{ id: "task", title: "Work", description: "Do work", assignTo: "support",
        missionId: "mission", group: "Example", user: "customer-a", status: "pending", dependsOn: [], expectations: [], metrics: [],
        retries: 0, maxRetries: 2, createdAt: now, updatedAt: now }] },
  };
}

describe("Mission execution admission contract", () => {
  it.each([undefined, null, [], {}, { expected: {} }, { receipt: {} }])("rejects a malformed plan: %j", input => {
    expect(() => normalizeMissionExecutionCommit(input)).toThrowError(expect.objectContaining({ code: "mission_execution_invalid" }));
  });

  it.each(["", " ", " padded", "padded ", "line\nbreak", "x".repeat(201)])("rejects an invalid occurrence key: %j", key => {
    expect(() => validateMissionExecutionKey("mission", key)).toThrowError(expect.objectContaining({ code: "mission_execution_invalid" }));
  });

  it.each(["principal", "forward dependency", "sparse dependencies", "duplicate id", "duplicate title", "status", "counter", "oversize"])("rejects %s without admission", kind => {
    const input = plan();
    if (kind === "principal") input.receipt.tasks[0].user = "other-customer";
    if (kind === "forward dependency") input.receipt.tasks[0].dependsOn = ["not-yet-created"];
    if (kind === "sparse dependencies") input.receipt.tasks[0].dependsOn = new Array(1);
    if (kind === "duplicate id") input.receipt.tasks.push({ ...input.receipt.tasks[0], title: "Other" });
    if (kind === "duplicate title") input.receipt.tasks.push({ ...input.receipt.tasks[0], id: "other" });
    if (kind === "status") input.receipt.tasks[0].status = "in_progress";
    if (kind === "counter") input.receipt.sequence = 2;
    if (kind === "oversize") input.expected.data = "x".repeat(4 * 1024 * 1024);
    expect(() => normalizeMissionExecutionCommit(input)).toThrowError(expect.objectContaining({ code: "mission_execution_invalid" }));
  });

  it("takes an independent JSON snapshot and compares optional defaults consistently", () => {
    const input = plan(), captured = normalizeMissionExecutionCommit(input);
    input.expected.user = "other-customer";
    input.receipt.tasks[0].dependsOn.push("injected");
    expect(captured.expected.user).toBe("customer-a");
    expect(captured.receipt.tasks[0].dependsOn).toEqual([]);
    expect(admitMissionExecution(captured, { ...captured.expected, executionCount: 0 }, [])).toMatchObject({ status: "active", executionCount: 1 });
    expect(() => admitMissionExecution(captured, input.expected, [])).toThrowError(expect.objectContaining({ code: "mission_execution_conflict" }));
  });

  it.each([null, {}, { volatileAgents: [null] }, { volatileAgents: [{ name: "helper" }, { name: "helper" }] },
    { volatileAgents: [], taskTitles: [] }, { volatileAgents: [], taskTitles: [{ authored: "Work", accepted: "Unknown" }] },
  ])("rejects runtime recovery metadata that cannot describe the accepted task plan: %j", runtime => {
    const input = plan();
    expect(() => normalizeMissionExecutionCommit({ ...input, runtime })).toThrowError(expect.objectContaining({ code: "mission_execution_invalid" }));
  });
});
