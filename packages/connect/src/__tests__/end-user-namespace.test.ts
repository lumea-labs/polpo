import { describe, expect, it, vi } from "vitest";
import { createToolInvocationContext } from "@polpo-ai/core";
import {
  createConnectionAccessResolver, matchesConnectionBinding, matchesConnectionCapabilitySelection,
  snapshotConnectionCapabilitySelection, snapshotOAuthReconnect, matchesOAuthReconnect,
  validateConnectionAssignments, type ConnectionRecord, type ConnectStore,
} from "../index.js";

const account = (namespace: string): ConnectionRecord => ({
  id: namespace, providerId: "gmail", projectId: "project", authType: "oauth2", status: "active",
  audience: "end_user", owner: { type: "external_user", namespace, id: "alice" },
  // Persisted setups predating namespace in binding still have a namespaced owner.
  binding: { principal: { type: "external_user", id: "alice" } },
  grantedScopes: ["read"], createdAt: "2026-10-10", updatedAt: "2026-10-10",
});
const selector = (namespace?: string) => ({ projectId: "project", audience: "end_user" as const,
  principal: { type: "external_user", id: "alice", ...(namespace === undefined ? {} : { namespace }) } });

describe("external-user application namespace", () => {
  it("requires the exact owner namespace even when only one account is granted", () => {
    expect(matchesConnectionBinding(account("crm"), selector("crm"))).toBe(true);
    expect(matchesConnectionBinding(account("crm"), selector("helpdesk"))).toBe(false);
    expect(matchesConnectionBinding(account("crm"), selector())).toBe(false);
    expect(matchesConnectionBinding({ ...account("crm"), owner: undefined }, selector("crm"))).toBe(false);
  });

  it("allows disjoint app owners in assignment preflight and selects only the caller's account", async () => {
    const records = [account("crm"), account("helpdesk")];
    expect(validateConnectionAssignments(records.map(connection => ({ connection })))).toEqual({ ok: true });
    const store = { listConnections: vi.fn(async () => records),
      getConnection: vi.fn(async id => records.find(c => c.id === id) ?? null) } as unknown as ConnectStore;
    const resolver = createConnectionAccessResolver({ store, resolveSelector: () => selector("helpdesk") });
    const acquired = await resolver.acquire({ slot: "mail", spec: { provider: "gmail", scopes: ["read"], mode: "gateway" },
      toolName: "read_mail", toolCallId: "call", invocation: createToolInvocationContext({ requestId: "req", runId: "run", surface: "chat" }) });
    expect(acquired.connection.id).toBe("helpdesk");
    records[1].owner = { type: "external_user", namespace: "crm", id: "alice" };
    await expect(acquired.current()).rejects.toMatchObject({ code: "connection_not_found_for_scope" });
  });

  it("invalidates delegated selection and pending reconnect when namespace changes", () => {
    const record = account("crm");
    const selection = snapshotConnectionCapabilitySelection(record);
    record.owner = { type: "external_user", namespace: "helpdesk", id: "alice" };
    expect(matchesConnectionCapabilitySelection(record, selection)).toBe(false);
    const reconnect = snapshotOAuthReconnect(record);
    record.binding = { principal: { type: "external_user", id: "alice", namespace: "helpdesk" } };
    expect(matchesOAuthReconnect(record, reconnect)).toBe(false);
  });
});
