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
  it("persists reasoning separately from assistant content", async () => {
    const sessionStore = store();
    const sessionId = await sessionStore.create();
    const assistant = await sessionStore.addMessage(sessionId, "assistant", "draft");
    await sessionStore.updateMessage(
      sessionId,
      assistant.id,
      "final",
      undefined,
      undefined,
      { text: "Checked the files.", truncated: true },
    );

    expect((await sessionStore.getMessages(sessionId))[0]).toMatchObject({
      content: "final",
      reasoning: "Checked the files.",
      reasoningTruncated: true,
    });
  });

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

  it("preserves the logical turn through a delayed continuation", async () => {
    const sessionStore = store();
    const sessionId = await sessionStore.create({ agent: "leo", user: "user-1" });
    await sessionStore.addMessage(sessionId, "user", "Configure booking", {
      turnId: "turn-1",
    });
    const assistant = await sessionStore.addMessage(sessionId, "assistant", "", {
      turnId: "turn-1",
    });
    await sessionStore.updateMessage(sessionId, assistant.id, "", [{
      id: "call-turn-1",
      name: "configure_site_module",
      state: "interrupted",
    }]);

    const prepared = await sessionStore.prepareContinuation!({
      sessionId,
      agent: "leo",
      user: "user-1",
      toolCallId: "call-turn-1",
      result: "configured",
      expectedSessionVersion: 2,
      idempotencyKey: "idem-turn-1",
      fingerprint: "fingerprint-turn-1",
      runId: "looprun-turn-1",
    });

    expect(prepared.turnId).toBe("turn-1");
    expect(prepared.messages.every((message) => message.turnId === "turn-1")).toBe(true);
  });

  it("atomically finalizes a canonical turn and persists its durable outbox", async () => {
    const sessionStore = store();
    const sessionId = await sessionStore.create({ agent: "leo", user: "user-1" });
    const user = await sessionStore.addMessage(sessionId, "user", "I prefer concise replies", {
      turnId: "turn-canonical-1",
    });
    const assistant = await sessionStore.addMessage(sessionId, "assistant", "", {
      turnId: "turn-canonical-1",
    });
    const input = {
      turn: {
        turnId: "turn-canonical-1",
        sessionId,
        agentName: "leo",
        surface: "chat" as const,
        terminalStatus: "succeeded" as const,
        userMessage: { id: user.id, role: "user" as const },
        assistantMessage: { id: assistant.id, role: "assistant" as const },
        trustedInvocation: { externalUserId: "user-1" },
        occurredAt: "2026-08-30T10:00:00.000Z",
      },
      assistant: {
        messageId: assistant.id,
        content: "Understood.",
      },
    };

    await expect(sessionStore.commitCanonicalTurn!(input)).resolves.toMatchObject({
      created: true,
    });
    await expect(sessionStore.commitCanonicalTurn!(input)).resolves.toMatchObject({
      created: false,
    });
    expect((await sessionStore.getMessages(sessionId))[1]?.content).toBe("Understood.");
    await expect(sessionStore.listPendingCanonicalTurns!()).resolves.toEqual([
      expect.objectContaining({
        turn: expect.objectContaining({ turnId: "turn-canonical-1" }),
        attempts: 0,
      }),
    ]);

    await expect(sessionStore.recordCanonicalTurnDispatchFailure!("turn-canonical-1"))
      .resolves.toBe(true);
    expect((await sessionStore.listPendingCanonicalTurns!())[0]?.attempts).toBe(1);
    await expect(sessionStore.markCanonicalTurnDispatched!("turn-canonical-1"))
      .resolves.toBe(true);
    await expect(sessionStore.listPendingCanonicalTurns!()).resolves.toEqual([]);
  });

  it("rolls back a canonical commit whose message identity is inconsistent", async () => {
    const sessionStore = store();
    const sessionId = await sessionStore.create({ agent: "leo", user: "user-1" });
    const user = await sessionStore.addMessage(sessionId, "user", "Hello", {
      turnId: "turn-good",
    });
    const assistant = await sessionStore.addMessage(sessionId, "assistant", "draft", {
      turnId: "turn-other",
    });

    await expect(sessionStore.commitCanonicalTurn!({
      turn: {
        turnId: "turn-good",
        sessionId,
        agentName: "leo",
        surface: "chat",
        terminalStatus: "succeeded",
        userMessage: { id: user.id, role: "user" },
        assistantMessage: { id: assistant.id, role: "assistant" },
        trustedInvocation: { externalUserId: "user-1" },
        occurredAt: "2026-08-30T10:00:00.000Z",
      },
      assistant: { messageId: assistant.id, content: "final" },
    })).rejects.toThrow("messages do not match");
    expect((await sessionStore.getMessages(sessionId))[1]?.content).toBe("draft");
    await expect(sessionStore.listPendingCanonicalTurns!()).resolves.toEqual([]);
  });
});
