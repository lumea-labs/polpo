import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../packages/file-stores/src/file-session-store.js";
import { PolpoClient } from "../packages/client-sdk/src/client/polpo-client.js";
import { chatRoutes, clientToolResolutionRoutes } from "../packages/server/src/routes/chat.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "polpo-settlement-http-")); dirs.push(dir);
  let store = new FileSessionStore(dir);
  const sessionId = await store.create({ agent: "leo", user: "external-user", scope: { key: "trusted-project-production" } });
  const assistant = await store.addMessage(sessionId, "assistant", "Ready to edit");
  const toolCallId = "call_never_accepted_fixture_c";
  await store.updateMessage(sessionId, assistant.id, assistant.content, [{
    id: toolCallId, name: "edit_site", state: "interrupted",
    continuationClientTools: [{ type: "function", function: { name: "edit_site" } }],
  }]);
  const deps = () => ({ sessionStore: store, authorizeClientToolSettlement: () => true,
    resolveClientToolResolutionScope: () => ({ key: "trusted-project-production" }) });
  const app = new Hono();
  app.route("/v1/chat", clientToolResolutionRoutes(deps, ["project-key"]));
  app.route("/api/v1/chat", chatRoutes(deps));
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => app.fetch(new Request(url, init)));
  const client = new PolpoClient({ baseUrl: "https://runtime.example.test", apiKey: "project-key", user: "external-user", fetch: transport });
  const identity = { sessionId, toolCallId, agent: "leo" };
  const settle = { ...identity, sessionVersion: 1, idempotencyKey: "repair-ncc", outcome: "cancelled" as const, reason: "No continuation was accepted" };
  return { client, transport, app, identity, settle, getStore: () => store,
    reopen: () => { store = new FileSessionStore(dir); } };
}

describe("settlement public API + SDK + durable store", () => {
  it("survives a lost response, reload and repeated requests without any execution endpoint", async () => {
    const { client, transport, identity, settle, reopen } = await fixture();
    expect(await client.getClientToolResolution(identity)).toMatchObject({ status: "pending", continuationAccepted: false });
    const committed = await client.settleClientTool(settle); // Pretend the caller lost this ACK.
    reopen();
    const resolved = await client.getClientToolResolution(identity);
    expect(resolved).toMatchObject({ status: "settled", continuationAccepted: false, receipt: committed.receipt });
    const retries = await Promise.all(Array.from({ length: 20 }, () => client.settleClientTool(settle)));
    expect(retries.every(retry => retry.status === "replay" && retry.receipt.id === committed.receipt.id)).toBe(true);
    const history = await client.getSessionMessages(identity.sessionId);
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]!.toolCalls![0]).toMatchObject({ state: "error", settlementOutcome: "cancelled" });
    expect(history.messages[0]!.toolCalls![0]).not.toHaveProperty("continuationClientTools");
    expect(history.session.version).toBe(2);
    expect(committed.receipt).not.toHaveProperty("runId");
    expect(transport.mock.calls.every(([url]) => !/completions|\/runs|\/loops|\/tools\//.test(String(url)))).toBe(true);
  });

  it("returns accepted identity even after its Run is gone and prevents settlement", async () => {
    const { client, identity, settle, getStore } = await fixture();
    await getStore().prepareContinuation({ ...identity, user: "external-user", scope: { key: "trusted-project-production" },
      expectedSessionVersion: 1, idempotencyKey: "accepted", fingerprint: "same-payload",
      runId: "already-accepted-run", result: "done" });
    expect(await client.getClientToolResolution(identity)).toMatchObject({ status: "continuation", continuationAccepted: true,
      receipt: { toolCallId: identity.toolCallId, runId: "already-accepted-run" }, runStatus: "unknown" });
    await expect(client.settleClientTool(settle)).rejects.toMatchObject({ status: 409, code: "continuation_already_accepted",
      details: { status: "continuation", receipt: { runId: "already-accepted-run" } } });
    expect(await getStore().getMessages(identity.sessionId)).toHaveLength(2);
  });

  it("enforces key authentication, exact user and stale-version checks before any mutation", async () => {
    const { app, client, identity, settle, getStore } = await fixture();
    const response = await app.request(`/v1/chat/sessions/${identity.sessionId}/tool-calls/${identity.toolCallId}?agent=leo&user=external-user`);
    expect(response.status).toBe(401);
    await expect(client.getClientToolResolution({ ...identity, user: "different-user" })).rejects.toMatchObject({ status: 403 });
    await expect(client.settleClientTool({ ...settle, sessionVersion: 0 })).rejects.toMatchObject({ code: "session_version_conflict" });
    expect(await getStore().getMessages(identity.sessionId)).toHaveLength(1);
  });
});
