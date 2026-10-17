import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { createPgStores, type DrizzleStores } from "../index.js";
import { ensurePgSchema } from "../migrate.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? "postgresql://postgres:postgres@localhost:5432/polpo_test";

let canConnect = false;
try {
  const probe = postgres(DATABASE_URL, { max: 1, connect_timeout: 3 });
  await probe`SELECT 1`;
  await probe.end();
  canConnect = true;
} catch {
  canConnect = false;
}

describe.skipIf(!canConnect)("DrizzleSessionStore client-tool settlement (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let stores: DrizzleStores;
  const sessions = new Set<string>();
  const namespace = `settlement_${process.pid}_${Date.now()}`;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`);
    client = postgres(DATABASE_URL, {
      max: 20,
      connection: { search_path: namespace, application_name: namespace },
      onnotice: () => undefined,
    });
    const db = drizzle(client);
    await ensurePgSchema(db);
    await ensurePgSchema(db);
    stores = createPgStores(db);
  });

  afterEach(async () => {
    await Promise.all([...sessions].map((sessionId) => stores.sessionStore.deleteSession(sessionId)));
    sessions.clear();
  });

  afterAll(async () => {
    await client.end();
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.end();
  });

  async function pendingCall() {
    const sessionId = await stores.sessionStore.create({
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
    });
    sessions.add(sessionId);
    const assistant = await stores.sessionStore.addMessage(sessionId, "assistant", "");
    await stores.sessionStore.updateMessage(sessionId, assistant.id, "", [{
      id: "call-pg",
      name: "publish_site",
      state: "interrupted",
      continuationClientTools: [{
        type: "function",
        function: { name: "publish_site" },
      }],
    }]);
    const session = await stores.sessionStore.getSession(sessionId);
    return { sessionId, assistant, version: session!.version! };
  }

  function settlement(
    sessionId: string,
    expectedSessionVersion: number,
    suffix = "same",
  ) {
    return {
      sessionId,
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
      toolCallId: "call-pg",
      expectedSessionVersion,
      idempotencyKey: `settlement-${suffix}`,
      outcome: "success" as const,
      result: '{"published":true}',
    };
  }

  it("provisions the receipt schema and persists a settlement", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    const settled = await stores.sessionStore.settleClientTool!(
      settlement(sessionId, version),
    );

    expect(settled).toMatchObject({
      status: "settled",
      receipt: {
        sessionId,
        sourceAssistantMessageId: assistant.id,
        outcome: "success",
        sessionVersion: version + 1,
      },
    });
    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
      toolCallId: "call-pg",
    })).resolves.toMatchObject({ status: "settled" });
  });

  it("linearizes forty exact concurrent deliveries into one commit and replays", async () => {
    const { sessionId, version } = await pendingCall();
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () =>
        stores.sessionStore.settleClientTool!(settlement(sessionId, version))),
    );

    expect(outcomes.filter((outcome) => outcome.status === "settled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "replay")).toHaveLength(39);
    expect(new Set(outcomes.map((outcome) => outcome.receipt.id)).size).toBe(1);
    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version + 1);
    expect((await stores.sessionStore.getMessages(sessionId))).toHaveLength(2);
  });

  it("allows only one semantic outcome under concurrent conflicting settlements", async () => {
    const { sessionId, version } = await pendingCall();
    const requests = Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? stores.sessionStore.settleClientTool!(settlement(sessionId, version, `success-${index}`))
      : stores.sessionStore.settleClientTool!({
          sessionId,
          agent: "leo",
          user: "pg-user",
          scope: { key: "pg-site", version: "1" },
          toolCallId: "call-pg",
          expectedSessionVersion: version,
          idempotencyKey: `settlement-failed-${index}`,
          outcome: "failed" as const,
          reason: "provider rejected",
        }));
    const outcomes = await Promise.allSettled(requests);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(10);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<(typeof requests)[number]>> =>
        outcome.status === "fulfilled",
    );
    expect(new Set(fulfilled.map((outcome) => outcome.value.receipt.outcome)).size).toBe(1);
    expect(fulfilled.filter((outcome) => outcome.value.status === "settled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(10);
    expect((await stores.sessionStore.getMessages(sessionId))).toHaveLength(2);
  });

  it("has exactly one winner when continuation races settlement across transactions", async () => {
    const { sessionId, version } = await pendingCall();
    const outcomes = await Promise.allSettled([
      stores.sessionStore.settleClientTool!(settlement(sessionId, version)),
      stores.sessionStore.prepareContinuation!({
        sessionId,
        agent: "leo",
        user: "pg-user",
        scope: { key: "pg-site", version: "1" },
        toolCallId: "call-pg",
        expectedSessionVersion: version,
        idempotencyKey: "continuation-race",
        fingerprint: "sha256:continuation-race",
        result: "continued",
        runId: "run-pg-race",
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const resolution = await stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
      toolCallId: "call-pg",
    });
    expect(["settled", "continuation"]).toContain(resolution.status);
    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version + 1);
  });

  it("returns the accepted continuation receipt when PUT reuses its original key", async () => {
    const { sessionId, version } = await pendingCall();
    await stores.sessionStore.prepareContinuation!({
      sessionId,
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
      toolCallId: "call-pg",
      expectedSessionVersion: version,
      idempotencyKey: "accepted-continuation",
      fingerprint: "sha256:accepted-continuation",
      result: "continued",
      runId: "run-pg-accepted",
    });

    await expect(stores.sessionStore.settleClientTool!({
      ...settlement(sessionId, 0),
      idempotencyKey: "accepted-continuation",
    })).rejects.toMatchObject({
      code: "continuation_already_accepted",
      continuation: { runId: "run-pg-accepted", toolCallId: "call-pg" },
    });
  });

  it("preserves source declaration order and ordinary siblings after settlement", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    const pending = (await stores.sessionStore.getMessages(sessionId))[0]!.toolCalls![0]!;
    const ordinary = {
      id: "call-pg-ordinary",
      name: "read_site",
      state: "completed" as const,
      result: "read",
    };
    await stores.sessionStore.updateMessage(sessionId, assistant.id, "", [ordinary, pending]);
    await stores.sessionStore.settleClientTool!(settlement(sessionId, version));
    await stores.sessionStore.updateMessage(
      sessionId,
      assistant.id,
      "late",
      [{ ...pending, state: "interrupted" }],
    );

    const calls = (await stores.sessionStore.getMessages(sessionId))[0]!.toolCalls!;
    expect(calls.map((candidate) => candidate.id)).toEqual([
      "call-pg-ordinary",
      "call-pg",
    ]);
    expect(calls[1]).toMatchObject({ state: "completed", settlementOutcome: "success" });
  });

  it("rolls back source, result, and version when the receipt insert fails", async () => {
    const { sessionId, assistant, version } = await pendingCall();
    await client.unsafe(`
      CREATE OR REPLACE FUNCTION fail_client_tool_settlement_insert()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'receipt insertion failed';
      END
      $$
    `);
    await client.unsafe(`
      CREATE TRIGGER fail_client_tool_settlement
      BEFORE INSERT ON session_client_tool_settlements
      FOR EACH ROW EXECUTE FUNCTION fail_client_tool_settlement_insert()
    `);
    try {
      await expect(stores.sessionStore.settleClientTool!(
        settlement(sessionId, version),
      )).rejects.toThrow("Failed query: insert into \"session_client_tool_settlements\"");
    } finally {
      await client.unsafe(
        "DROP TRIGGER IF EXISTS fail_client_tool_settlement ON session_client_tool_settlements",
      );
      await client.unsafe("DROP FUNCTION IF EXISTS fail_client_tool_settlement_insert() CASCADE");
    }

    expect((await stores.sessionStore.getSession(sessionId))?.version).toBe(version);
    const messages = await stores.sessionStore.getMessages(sessionId);
    expect(messages).toHaveLength(1);
    expect(messages.find((message) => message.id === assistant.id)?.toolCalls?.[0]).toMatchObject({
      state: "interrupted",
    });
    await expect(stores.sessionStore.getClientToolResolution!({
      sessionId,
      agent: "leo",
      user: "pg-user",
      scope: { key: "pg-site", version: "1" },
      toolCallId: "call-pg",
    })).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps settlement and addMessage coherent under concurrent session writes", async () => {
    for (let index = 0; index < 20; index++) {
      const { sessionId, version } = await pendingCall();
      const [settlementResult, messageResult] = await Promise.allSettled([
        stores.sessionStore.settleClientTool!(settlement(sessionId, version, `add-race-${index}`)),
        stores.sessionStore.addMessage(sessionId, "user", `concurrent-${index}`),
      ]);
      expect(messageResult.status).toBe("fulfilled");
      if (settlementResult.status === "rejected") {
        expect(settlementResult.reason).toMatchObject({ code: "session_version_conflict" });
      }
      const didSettle = settlementResult.status === "fulfilled";
      expect((await stores.sessionStore.getSession(sessionId))?.version)
        .toBe(version + 1 + (didSettle ? 1 : 0));
      expect((await stores.sessionStore.getMessages(sessionId))).toHaveLength(didSettle ? 3 : 2);
      const resolution = await stores.sessionStore.getClientToolResolution!({
        sessionId,
        agent: "leo",
        user: "pg-user",
        scope: { key: "pg-site", version: "1" },
        toolCallId: "call-pg",
      });
      expect(resolution.status).toBe(didSettle ? "settled" : "pending");
    }
  });
});
