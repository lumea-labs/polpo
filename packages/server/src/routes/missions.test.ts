import { describe, expect, it, vi } from "vitest";
import { MissionExecutionError } from "@polpo-ai/core/mission-store";
import { missionRoutes } from "./missions.js";

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
function fixture(executeMission = vi.fn(async () => ({ tasks: [], group: "Example", executionId: "execution" }))) {
  const app = missionRoutes(() => ({ executeMission }) as any);
  return { app, executeMission };
}

describe("Mission execution API contract", () => {
  it("forwards an idempotency key and returns the durable execution identity", async () => {
    const { app, executeMission } = fixture();
    const response = await app.request("/mission/execute", json({ idempotencyKey: "schedule:occurrence" }));
    expect(response.status).toBe(200);
    expect(executeMission).toHaveBeenCalledWith("mission", { idempotencyKey: "schedule:occurrence" });
    expect((await response.json()).data.executionId).toBe("execution");
  });
  it("preserves callers that send no body", async () => {
    const { app, executeMission } = fixture();
    expect((await app.request("/mission/execute", { method: "POST" })).status).toBe(200);
    expect(executeMission).toHaveBeenCalledWith("mission", {});
  });
  it.each([null, [], { idempotencyKey: "" }, { idempotencyKey: " padded" }, { idempotencyKey: "x".repeat(201) }, { user: "impostor" }])("rejects invalid execution options before dispatch: %j", async body => {
    const { app, executeMission } = fixture();
    expect((await app.request("/mission/execute", json(body))).status).toBe(400);
    expect(executeMission).not.toHaveBeenCalled();
  });
  it.each([["mission_execution_invalid", 400], ["mission_execution_conflict", 409], ["mission_execution_unsupported", 501]] as const)("maps %s without converting it into a successful execution", async (code, status) => {
    const { app } = fixture(vi.fn(async () => { throw new MissionExecutionError(code, "Fixture admission error"); }));
    const response = await app.request("/mission/execute", json({ idempotencyKey: "delivery" }));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ ok: false, code });
  });
});


describe("Mission runtime collection routes", () => {
  it.each(["delays", "checkpoints"])("awaits a cold persisted /%s read", async kind => {
    const gate = { missionId: "mission", executionId: "execution", group: "Display" };
    const app = missionRoutes(() => ({ getActiveDelays: async () => [gate], getActiveCheckpoints: async () => [gate] }) as any);
    const response = await app.request(`/${kind}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([gate]);
  });
  it.each(["delays", "checkpoints"])("does not interpret /%s as a Mission ID", async kind => {
    const getMission = vi.fn(async () => undefined);
    const gate = { group: "Display", executionId: "run", missionId: "mission" };
    const app = missionRoutes(() => ({ getMission, getActiveDelays: () => [gate], getActiveCheckpoints: () => [gate] }) as any);
    const response = await app.request(`/${kind}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual([gate]);
    expect(getMission).not.toHaveBeenCalled();
  });
});
