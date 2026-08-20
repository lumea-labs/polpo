import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore } from "../file-session-store.js";

const dirs: string[] = [];

function store(): FileSessionStore {
  const dir = mkdtempSync(join(tmpdir(), "polpo-session-"));
  dirs.push(dir);
  return new FileSessionStore(dir);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function pendingSession(sessionStore: FileSessionStore): Promise<string> {
  const sessionId = await sessionStore.create({
    agent: "leo",
    user: "user-1",
    scope: { key: "tenant:site", version: "3" },
  });
  const assistant = await sessionStore.addMessage(sessionId, "assistant", "");
  await sessionStore.updateMessage(sessionId, assistant.id, "", [{
    id: "call-1",
    name: "configure_site_module",
    arguments: { module: "booking" },
    state: "interrupted",
  }]);
  return sessionId;
}

describe("FileSessionStore continuation", () => {
  it("persists a resolved client tool result and monotonic version", async () => {
    const sessionStore = store();
    const sessionId = await pendingSession(sessionStore);

    const prepared = await sessionStore.prepareContinuation!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "tenant:site", version: "3" },
      toolCallId: "call-1",
      result: "configured",
      expectedSessionVersion: 1,
      idempotencyKey: "idem-1",
      fingerprint: "fingerprint-1",
      runId: "looprun-1",
    });

    expect(prepared).toMatchObject({
      status: "prepared",
      sessionVersion: 2,
      runId: "looprun-1",
    });
    expect(prepared.messages).toHaveLength(2);
    expect(prepared.messages[0]?.toolCalls?.[0]).toMatchObject({
      id: "call-1",
      state: "completed",
      result: "configured",
    });
    expect((await sessionStore.getSession(sessionId))?.version).toBe(2);
  });

  it("replays after reopening the store and rejects changed payloads", async () => {
    const sessionStore = store();
    const sessionId = await pendingSession(sessionStore);
    const input = {
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "tenant:site", version: "3" },
      toolCallId: "call-1",
      result: "configured",
      expectedSessionVersion: 1,
      idempotencyKey: "idem-1",
      fingerprint: "fingerprint-1",
      runId: "looprun-1",
    } as const;
    await sessionStore.prepareContinuation!(input);

    const reopened = new FileSessionStore((sessionStore as any).sessionsDir.replace(/\/sessions$/, ""));
    await expect(reopened.prepareContinuation!(input)).resolves.toMatchObject({
      status: "replay",
      runId: "looprun-1",
    });
    await expect(reopened.prepareContinuation!({
      ...input,
      user: "other-user",
    })).rejects.toMatchObject({ code: "continuation_scope_mismatch" });
    await expect(reopened.prepareContinuation!({
      ...input,
      fingerprint: "different",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("serializes concurrent attempts for the same pending call", async () => {
    const sessionStore = store();
    const sessionId = await pendingSession(sessionStore);
    const base = {
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "tenant:site", version: "3" },
      toolCallId: "call-1",
      result: "configured",
      expectedSessionVersion: 1,
      fingerprint: "fingerprint",
    } as const;

    const outcomes = await Promise.allSettled([
      sessionStore.prepareContinuation!({
        ...base,
        idempotencyKey: "idem-a",
        runId: "looprun-a",
      }),
      sessionStore.prepareContinuation!({
        ...base,
        idempotencyKey: "idem-b",
        runId: "looprun-b",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await sessionStore.getMessages(sessionId)).toHaveLength(2);
  });
});
