import { describe, expect, it } from "vitest";
import { PolpoStore } from "./polpo-store.js";
import type { ChatSession, SessionTitleSnapshot } from "../client/types.js";

const row: ChatSession = { id: "s", title: "ciao", createdAt: "2026-10-25T12:00:00Z", updatedAt: "2026-10-25T12:00:00Z", messageCount: 1, titleRevision: 0 };
const generated: SessionTitleSnapshot = { id: "s", title: "Saluto iniziale", titleSource: "generated", titleRevision: 1, titleUpdatedAt: "2026-10-25T12:00:02Z", titleGenerationStatus: "completed" };

describe("Session title ordering", () => {
  it("merges stale list and transcript updates without regressing a generated title", () => {
    const store = new PolpoStore(); store.setSessions([row]); store.patchSessionTitle(generated);
    store.setSessions([{ ...row, messageCount: 2 }]);
    expect(store.getSnapshot().sessions.get("s")).toMatchObject({ title: generated.title, titleRevision: 1, messageCount: 2, updatedAt: row.updatedAt });
    store.patchSession("s", { messageCount: 3, title: "old" });
    expect(store.getSnapshot().sessions.get("s")).toMatchObject({ title: generated.title, messageCount: 3 });
  });
  it("buffers an early event without inventing Session membership", () => {
    const store = new PolpoStore(); store.patchSessionTitle(generated);
    expect(store.getSnapshot().sessions.size).toBe(0);
    store.setSessions([row]); expect(store.getSnapshot().sessions.get("s")?.title).toBe(generated.title);
    store.removeSession("s"); store.patchSessionTitle(generated);
    expect(store.getSnapshot().sessions.size).toBe(0);
  });
  it("manual revisions beat delayed automatic results and replay", () => {
    const store = new PolpoStore(); store.setSessions([row]);
    store.patchSessionTitle({ ...generated, title: "Mine", titleSource: "manual", titleRevision: 2 });
    store.patchSessionTitle(generated); store.upsertSession({ ...row, titleRevision: 1 });
    expect(store.getSnapshot().sessions.get("s")).toMatchObject({ title: "Mine", titleRevision: 2 });
  });
});
