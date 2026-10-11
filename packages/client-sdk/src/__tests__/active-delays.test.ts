import { describe, expect, it } from "vitest";
import { PolpoStore } from "../index.js";

const timestamp = "2026-10-11T08:00:00.000Z";
function emit(store: PolpoStore, event: string, identity: Record<string, string | undefined>) {
  store.applyEvent({ id: crypto.randomUUID(), event, timestamp, data: {
    ...identity, duration: "PT1M", afterTasks: [], blocksTasks: [], startedAt: timestamp, expiresAt: "2026-10-11T08:01:00.000Z",
  } });
}

describe("active delay execution identity", () => {
  it("does not overwrite or expire another execution with the same label", () => {
    const store = new PolpoStore();
    const a = { group: "Same #2", missionId: "a", executionId: "run-a", delayName: "wait" };
    const b = { ...a, missionId: "b", executionId: "run-b" };
    emit(store, "delay:started", a); emit(store, "delay:started", b);
    expect([...store.getSnapshot().activeDelays.values()]).toEqual([expect.objectContaining(a), expect.objectContaining(b)]);
    emit(store, "delay:expired", { ...a, group: "Renamed" });
    expect([...store.getSnapshot().activeDelays.values()]).toEqual([expect.objectContaining(b)]);
  });

  it("keeps legacy labels and colon-containing names separate from execution identities", () => {
    const store = new PolpoStore();
    const identities = [
      { group: "a:b", delayName: "c" }, { group: "a", delayName: "b:c" },
      { group: "a:b", delayName: "c", executionId: "a:b" },
    ];
    identities.forEach(identity => emit(store, "delay:started", identity));
    expect(store.getSnapshot().activeDelays.size).toBe(3);
    emit(store, "delay:expired", identities[0]);
    expect([...store.getSnapshot().activeDelays.values()]).toEqual(identities.slice(1).map(identity => expect.objectContaining(identity)));
  });
});
