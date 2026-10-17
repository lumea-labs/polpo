import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteStores, type DrizzleStores } from "../index.js";
import { migrateSqliteSchema } from "../sqlite-migrator.js";

describe("DrizzleSessionStore client-tool settlement (SQLite)", () => {
  let sqlite: InstanceType<typeof Database>;
  let stores: DrizzleStores;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    stores = createSqliteStores(db);
  });

  afterEach(() => sqlite.close());

  it("migrates the settlement receipt table idempotently", async () => {
    const db = drizzle(sqlite);
    await migrateSqliteSchema(db);
    const table = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get("session_client_tool_settlements") as { name?: string } | undefined;
    expect(table?.name).toBe("session_client_tool_settlements");
    const indexes = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?",
    ).all("session_client_tool_settlements") as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "uq_session_client_tool_settlements_key",
      "uq_session_client_tool_settlements_call",
      "uq_session_client_tool_settlements_result",
      "idx_session_client_tool_settlements_source",
    ]));
  });

  async function pendingCall(options: {
    readonly withLaterMessages?: boolean;
    readonly agent?: string;
    readonly user?: string;
  } = {}) {
    const sessionId = await stores.sessionStore.create({
      agent: options.agent ?? "leo",
      user: options.user ?? "user-1",
      scope: { key: "site-1", version: "4" },
    });
    await stores.sessionStore.addMessage(sessionId, "user", "Publish the site", {
      turnId: "turn-publish",
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const assistant = await stores.sessionStore.addMessage(sessionId, "assistant", "", {
      turnId: "turn-publish",
    });
    await stores.sessionStore.updateMessage(sessionId, assistant.id, "", [{
      id: "call-publish",
      name: "publish_site",
      arguments: { siteId: "site-1" },
      state: "interrupted",
      continuationClientTools: [{
        type: "function",
        function: {
          name: "publish_site",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }],
    }]);
    if (options.withLaterMessages) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      await stores.sessionStore.addMessage(sessionId, "user", "Meanwhile change the title", {
        turnId: "turn-later",
      });
      await new Promise((resolve) => setTimeout(resolve, 2));
      await stores.sessionStore.addMessage(sessionId, "assistant", "Title changed", {
        turnId: "turn-later",
      });
    }
    const session = await stores.sessionStore.getSession(sessionId);
    return { sessionId, assistant, version: session!.version! };
  }

  function successInput(sessionId: string, expectedSessionVersion: number) {
    return {
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
      expectedSessionVersion,
      idempotencyKey: "settle-publish-1",
      outcome: "success" as const,
      result: '{"published":true}',
    };
  }

  it("settles once, persists an immutable receipt, and replays before the version check", async () => {
    const { sessionId, assistant, version } = await pendingCall();

    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
    })).resolves.toMatchObject({
      status: "pending",
      continuationAccepted: false,
      sessionVersion: version,
    });

    const settled = await stores.sessionStore.settleClientTool!(
      successInput(sessionId, version),
    );
    expect(settled).toMatchObject({
      status: "settled",
      receipt: {
        sessionId,
        toolCallId: "call-publish",
        sourceAssistantMessageId: assistant.id,
        outcome: "success",
        sessionVersion: version + 1,
      },
    });
    expect(settled.receipt).not.toHaveProperty("idempotencyKey");
    expect(settled.receipt).not.toHaveProperty("fingerprint");

    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, 0),
      idempotencyKey: "another-delivery-key",
    })).resolves.toMatchObject({
      status: "replay",
      receipt: { id: settled.receipt.id, sessionVersion: version + 1 },
    });

    const messages = await stores.sessionStore.getMessages(sessionId);
    expect(messages).toHaveLength(3);
    const settledAssistant = messages.find((message) => message.id === assistant.id);
    expect(settledAssistant).toMatchObject({
      id: assistant.id,
      toolCalls: [{
        id: "call-publish",
        state: "completed",
        settlementOutcome: "success",
      }],
    });
    expect(settledAssistant?.toolCalls?.[0]).not.toHaveProperty("continuationClientTools");
    expect(messages.find((message) => message.id === settled.receipt.resultMessageId)).toMatchObject({
      id: settled.receipt.resultMessageId,
      role: "tool",
      toolCallId: "call-publish",
      turnId: "turn-publish",
    });

    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
    })).resolves.toMatchObject({
      status: "settled",
      continuationAccepted: false,
      receipt: { id: settled.receipt.id },
    });
  });

  it("canonicalizes a late result before slicing recent history", async () => {
    const { sessionId, assistant, version } = await pendingCall({ withLaterMessages: true });
    const settled = await stores.sessionStore.settleClientTool!(
      successInput(sessionId, version),
    );

    const all = await stores.sessionStore.getMessages(sessionId);
    const assistantIndex = all.findIndex((message) => message.id === assistant.id);
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(all[assistantIndex + 1]?.id).toBe(settled.receipt.resultMessageId);
    const recent = await stores.sessionStore.getRecentMessages(sessionId, 4);
    const recentAssistant = recent.findIndex((message) => message.id === assistant.id);
    expect(recentAssistant).toBeGreaterThanOrEqual(0);
    expect(recent[recentAssistant + 1]?.id).toBe(settled.receipt.resultMessageId);
  });

  it.each(["failed", "cancelled"] as const)(
    "materializes %s as an error while preserving the exact settlement outcome",
    async (outcome) => {
      const { sessionId, version } = await pendingCall();
      const settled = await stores.sessionStore.settleClientTool!({
        sessionId,
        agent: "leo",
        user: "user-1",
        scope: { key: "site-1", version: "4" },
        toolCallId: "call-publish",
        expectedSessionVersion: version,
        idempotencyKey: `settle-${outcome}`,
        outcome,
        reason: `${outcome} by application`,
      });
      const messages = await stores.sessionStore.getMessages(sessionId);
      expect(settled.receipt.outcome).toBe(outcome);
      const source = messages.find((message) =>
        message.role === "assistant"
        && message.toolCalls?.some((call) => call.id === "call-publish")
      );
      expect(source?.toolCalls?.[0]).toMatchObject({
        state: "error",
        settlementOutcome: outcome,
      });
      const result = messages.find((message) => message.id === settled.receipt.resultMessageId);
      expect(() => JSON.parse(result!.content as string)).not.toThrow();
    },
  );

  it("normalizes idempotency, semantic, scope, and stale-version conflicts without partial writes", async () => {
    const { sessionId, version } = await pendingCall();
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, version),
      user: "other-user",
    })).rejects.toMatchObject({ code: "client_tool_settlement_scope_mismatch" });
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, version - 1),
    })).rejects.toMatchObject({ code: "session_version_conflict" });

    const settled = await stores.sessionStore.settleClientTool!(
      successInput(sessionId, version),
    );
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, version + 1),
      outcome: "failed",
      result: undefined,
      reason: "different",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, version + 1),
      idempotencyKey: "different-key",
      outcome: "failed",
      result: undefined,
      reason: "different",
    })).rejects.toMatchObject({ code: "client_tool_settlement_conflict" });

    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version + 1);
    expect((await stores.sessionStore.getMessages(sessionId))).toHaveLength(3);
    expect(settled.receipt.sessionVersion).toBe(version + 1);
  });

  it("makes settlement and continuation mutually exclusive", async () => {
    const settledPending = await pendingCall();
    await stores.sessionStore.settleClientTool!(
      successInput(settledPending.sessionId, settledPending.version),
    );
    await expect(stores.sessionStore.prepareContinuation!({
      sessionId: settledPending.sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
      result: "continued",
      expectedSessionVersion: settledPending.version + 1,
      idempotencyKey: "continue-after-settlement",
      fingerprint: "sha256:continue",
      runId: "run-after-settlement",
    })).rejects.toMatchObject({ code: "client_tool_call_not_pending" });

    const continuedPending = await pendingCall();
    await stores.sessionStore.prepareContinuation!({
      sessionId: continuedPending.sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
      result: "continued",
      expectedSessionVersion: continuedPending.version,
      idempotencyKey: "continue-first",
      fingerprint: "sha256:continue-first",
      runId: "run-continued",
    });
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(continuedPending.sessionId, continuedPending.version + 1),
      idempotencyKey: "settle-after-continuation",
    })).rejects.toMatchObject({
      code: "continuation_already_accepted",
      continuation: { runId: "run-continued", toolCallId: "call-publish" },
    });
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(continuedPending.sessionId, 0),
      idempotencyKey: "continue-first",
    })).rejects.toMatchObject({
      code: "continuation_already_accepted",
      continuation: { runId: "run-continued", toolCallId: "call-publish" },
    });
  });

  it("fails closed when a call has both settlement and continuation receipts", async () => {
    const { sessionId, version } = await pendingCall();
    await stores.sessionStore.settleClientTool!(successInput(sessionId, version));
    sqlite.prepare(`
      INSERT INTO session_continuations (
        id, session_id, idempotency_key, fingerprint, tool_call_id,
        run_id, session_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "corrupt-continuation",
      sessionId,
      "corrupt-continuation-key",
      "sha256:corrupt",
      "call-publish",
      "run-corrupt",
      version + 1,
      new Date().toISOString(),
    );

    await expect(stores.sessionStore.settleClientTool!(
      successInput(sessionId, 0),
    )).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
  });

  it("keeps a settled assistant terminal when a stale update arrives", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    await stores.sessionStore.settleClientTool!(successInput(sessionId, version));

    await stores.sessionStore.updateMessage(sessionId, assistant.id, "late update", [{
      id: "call-publish",
      name: "publish_site",
      state: "interrupted",
      continuationClientTools: [{
        type: "function",
        function: { name: "publish_site" },
      }],
    }]);

    const call = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === assistant.id)?.toolCalls?.[0];
    expect(call).toMatchObject({
      id: "call-publish",
      state: "completed",
      settlementOutcome: "success",
    });
    expect(call).not.toHaveProperty("continuationClientTools");
  });

  it("preserves source declaration order and ordinary siblings across stale updates", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    const ordinary = {
      id: "call-ordinary",
      name: "read_site",
      state: "completed" as const,
      result: "read",
    };
    const pending = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === assistant.id)!.toolCalls![0]!;
    await stores.sessionStore.updateMessage(
      sessionId,
      assistant.id,
      "",
      [ordinary, pending],
    );
    await stores.sessionStore.settleClientTool!(successInput(sessionId, version));

    await stores.sessionStore.updateMessage(
      sessionId,
      assistant.id,
      "late reversed update",
      [{ ...pending, state: "interrupted" }, { ...ordinary, result: "refreshed" }],
    );
    let calls = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === assistant.id)!.toolCalls!;
    expect(calls.map((candidate) => candidate.id)).toEqual([
      "call-ordinary",
      "call-publish",
    ]);
    expect(calls[0]).toMatchObject({ state: "completed", result: "refreshed" });
    expect(calls[1]).toMatchObject({ state: "completed", settlementOutcome: "success" });

    await stores.sessionStore.updateMessage(
      sessionId,
      assistant.id,
      "late omitted sibling",
      [{ ...pending, state: "interrupted" }],
    );
    calls = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === assistant.id)!.toolCalls!;
    expect(calls.map((candidate) => candidate.id)).toEqual([
      "call-ordinary",
      "call-publish",
    ]);
    expect(calls[0]).toMatchObject({ state: "completed", result: "refreshed" });
  });

  it("keeps a settled assistant terminal when a stale canonical-turn commit arrives", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    const messages = await stores.sessionStore.getMessages(sessionId);
    const user = messages.find((message) => message.role === "user")!;
    await stores.sessionStore.settleClientTool!(successInput(sessionId, version));

    await stores.sessionStore.commitCanonicalTurn!({
      turn: {
        turnId: "turn-publish",
        requestId: "request-publish",
        sessionId,
        agentName: "leo",
        surface: "chat",
        terminalStatus: "succeeded",
        userMessage: { id: user.id, role: "user" },
        assistantMessage: { id: assistant.id, role: "assistant" },
        trustedInvocation: { externalUserId: "user-1" },
        occurredAt: new Date().toISOString(),
      },
      assistant: {
        messageId: assistant.id,
        content: "late canonical write",
      },
    });

    const call = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === assistant.id)?.toolCalls?.[0];
    expect(call).toMatchObject({
      state: "completed",
      settlementOutcome: "success",
    });
    expect(call).not.toHaveProperty("continuationClientTools");
  });

  it("keeps the immutable settlement result when updateMessage targets it", async () => {
    const { sessionId, version } = await pendingCall();
    const settled = await stores.sessionStore.settleClientTool!(successInput(sessionId, version));
    const before = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === settled.receipt.resultMessageId)!;

    await expect(stores.sessionStore.updateMessage(
      sessionId,
      settled.receipt.resultMessageId,
      "forged result",
    )).rejects.toMatchObject({ code: "client_tool_settlement_conflict" });
    const after = (await stores.sessionStore.getMessages(sessionId))
      .find((message) => message.id === settled.receipt.resultMessageId)!;
    expect(after).toEqual(before);
  });

  it("rolls back every settlement write when receipt insertion fails", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    sqlite.exec(`
      CREATE TRIGGER fail_client_tool_settlement
      BEFORE INSERT ON session_client_tool_settlements
      BEGIN
        SELECT RAISE(ABORT, 'receipt insertion failed');
      END
    `);

    await expect(stores.sessionStore.settleClientTool!(
      successInput(sessionId, version),
    )).rejects.toThrow("receipt insertion failed");
    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version);
    const messages = await stores.sessionStore.getMessages(sessionId);
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.id === assistant.id)?.toolCalls?.[0]).toMatchObject({
      state: "interrupted",
    });
    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
    })).resolves.toMatchObject({ status: "pending" });
  });

  it("has exactly one winner when settlement races continuation", async () => {
    const { sessionId, version } = await pendingCall();
    const outcomes = await Promise.allSettled([
      stores.sessionStore.settleClientTool!(successInput(sessionId, version)),
      stores.sessionStore.prepareContinuation!({
        sessionId,
        agent: "leo",
        user: "user-1",
        scope: { key: "site-1", version: "4" },
        toolCallId: "call-publish",
        result: "continued",
        expectedSessionVersion: version,
        idempotencyKey: "continue-race",
        fingerprint: "sha256:continue-race",
        runId: "run-race",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const resolution = await stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
    });
    expect(["settled", "continuation"]).toContain(resolution.status);
    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version + 1);
    expect((await stores.sessionStore.getMessages(sessionId))).toHaveLength(3);
  });

  it("fails closed instead of acknowledging a receipt whose result message is missing", async () => {
    const { sessionId, version } = await pendingCall();
    const settled = await stores.sessionStore.settleClientTool!(successInput(sessionId, version));
    sqlite.prepare("DELETE FROM messages WHERE id = ?").run(settled.receipt.resultMessageId);

    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-publish",
    })).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
    await expect(stores.sessionStore.settleClientTool!({
      ...successInput(sessionId, 0),
    })).rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
    sqlite.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    await expect(stores.sessionStore.getMessages(sessionId))
      .rejects.toMatchObject({ code: "client_tool_settlement_corrupt" });
  });

  it("shares one idempotency-key namespace with continuation acceptance", async () => {
    const sessionId = await stores.sessionStore.create({
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
    });
    const assistant = await stores.sessionStore.addMessage(sessionId, "assistant", "");
    const catalog = (name: string) => [{
      type: "function" as const,
      function: { name },
    }];
    await stores.sessionStore.updateMessage(sessionId, assistant.id, "", [{
      id: "call-settle",
      name: "settle_me",
      state: "interrupted",
      continuationClientTools: catalog("settle_me"),
    }, {
      id: "call-continue",
      name: "continue_me",
      state: "interrupted",
      continuationClientTools: catalog("continue_me"),
    }]);
    await stores.sessionStore.prepareContinuation!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-continue",
      result: "continued",
      expectedSessionVersion: 1,
      idempotencyKey: "shared-key",
      fingerprint: "sha256:continue",
      runId: "run-shared",
    });

    await expect(stores.sessionStore.settleClientTool!({
      sessionId,
      agent: "leo",
      user: "user-1",
      scope: { key: "site-1", version: "4" },
      toolCallId: "call-settle",
      expectedSessionVersion: 2,
      idempotencyKey: "shared-key",
      outcome: "success",
      result: "settled",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
