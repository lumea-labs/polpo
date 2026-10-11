import { describe, expect, it, vi } from "vitest";
import { createToolInvocationContext } from "@polpo-ai/core";
import {
  createConnectionAccessResolver,
  matchesConnectionBindingAttributes,
  validateConnectionAssignments,
  type ConnectionAssignment,
  type ConnectionRecord,
  type ConnectStore,
} from "../index.js";

function account(id: string, overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return { id, providerId: "gmail", projectId: "p", authType: "oauth2", status: "active",
    grantedScopes: ["mail:read"], createdAt: "2026-10-10", updatedAt: "2026-10-10", ...overrides };
}
function endUser(id: string, user: string): ConnectionAssignment {
  return { connection: account(id, { audience: "end_user", owner: { type: "external_user", namespace: "app", id: user }, binding: {
    principal: { type: "external_user", id: user },
  } }) };
}

describe("Connection assignment preflight", () => {
  it("allows distinct end users, personal owners, resources and scope epochs", () => {
    expect(validateConnectionAssignments([endUser("a", "gioia"), endUser("b", "emiliano")])).toEqual({ ok: true });
    expect(validateConnectionAssignments(["gioia", "emiliano"].map(id => ({ connection: account(id, {
      audience: "personal", owner: { type: "user", id },
    }) })))).toEqual({ ok: true });
    for (const binding of [
      [{ resource: { namespace: "drive", type: "folder", id: "a" } }, { resource: { namespace: "drive", type: "folder", id: "b" } }],
      [{ scopeEpoch: "1" }, { scopeEpoch: "2" }],
    ]) {
      expect(validateConnectionAssignments(binding.map((value, i) => ({ connection: account(String(i), { binding: value }) })))).toEqual({ ok: true });
    }
  });

  it("rejects two unbound shared accounts, the same end user, and a broad/narrow overlap", () => {
    for (const assignments of [
      [{ connection: account("a") }, { connection: account("b") }],
      [endUser("a", "gioia"), endUser("b", "gioia")],
      [{ connection: account("a") }, { connection: account("b", { binding: { scopeEpoch: "1" } }) }],
    ]) {
      expect(validateConnectionAssignments(assignments)).toEqual({ ok: false, reason: "overlapping_context", connectionIds: ["a", "b"] });
    }
  });

  it("uses grant bindings as additional constraints and never overwrites the Connection binding", () => {
    const assignments = ["a", "b"].map(id => ({ connection: account(id), binding: { principal: { type: "external_user", id } } }));
    expect(validateConnectionAssignments(assignments)).toEqual({ ok: true });
    expect(validateConnectionAssignments([{ ...endUser("a", "gioia"), binding: { principal: { type: "external_user", id: "emiliano" } } }]))
      .toMatchObject({ ok: false, reason: "invalid_context", connectionIds: ["a"] });
  });

  it("treats partial legacy fields as constraints, not a complete identity", () => {
    const partial = { resource: { namespace: "drive" } } as ConnectionRecord["binding"];
    const a = { connection: account("a", { binding: partial }) };
    expect(validateConnectionAssignments([a, { connection: account("b", { binding: {
      resource: { namespace: "drive", type: "folder", id: "one" },
    } }) }])).toMatchObject({ ok: false, reason: "overlapping_context" });
    expect(validateConnectionAssignments([a, { connection: account("b", { binding: {
      resource: { namespace: "other", type: "folder", id: "one" },
    } }) }])).toEqual({ ok: true });
  });

  it.each([
    { binding: {} },
    { binding: { resource: {} } },
    { binding: { resource: { namespace: "drive", extra: "ignored" } } },
    { binding: { scopeEpoch: 2 } },
    { binding: { scopeEpoch: " " } },
    { binding: [] },
    { binding: null },
    { audience: "unknown" },
    { audience: "end_user" },
    { audience: "end_user", binding: { principal: { type: "external_user" } } },
    { audience: "personal", owner: { type: "project", id: "p" } },
    { audience: "personal", owner: { type: "user", id: "gioia" }, binding: { principal: { type: "user", id: "emiliano" } } },
  ])("rejects invalid or unsatisfiable context %#", overrides => {
    expect(validateConnectionAssignments([{ connection: account("bad", overrides as Partial<ConnectionRecord>) }]))
      .toEqual({ ok: false, reason: "invalid_context", connectionIds: ["bad"] });
  });

  it("deduplicates the same account, keeps legacy audience shared, and distinguishes explicit audiences", () => {
    const shared = { connection: account("a") };
    expect(validateConnectionAssignments([shared, shared])).toEqual({ ok: true });
    expect(validateConnectionAssignments([shared, endUser("b", "gioia")])).toEqual({ ok: true });
    // The host must select an audience explicitly; no automatic personal/shared fallback.
    expect(validateConnectionAssignments([shared, { connection: account("b", { binding: { principal: { type: "user", id: "gioia" } } }) }]))
      .toMatchObject({ ok: false, reason: "overlapping_context" });
  });

  it("does not mistake a different provider for an account of the same capability", () => {
    expect(validateConnectionAssignments([{ connection: account("a") }, { connection: account("b", { providerId: "drive" }) }]))
      .toMatchObject({ ok: false, reason: "provider_mismatch" });
  });

  it.each(["constructor", "toString", "__proto__"])("rejects inherited binding key %s without throwing", key => {
    const binding = JSON.parse(JSON.stringify({ [key]: { id: "a" } }));
    for (const assignment of [{ connection: account("a", { binding }) }, { connection: account("a"), binding }]) {
      expect(validateConnectionAssignments([assignment])).toMatchObject({ ok: false, reason: "invalid_context" });
    }
  });

  it("distinguishes the same end-user ID in different application namespaces", () => {
    const assignments = ["crm", "helpdesk"].map(namespace => {
      const assignment = endUser(namespace, "alice");
      assignment.connection.owner = { type: "external_user", namespace, id: "alice" };
      return assignment;
    });
    expect(validateConnectionAssignments(assignments)).toEqual({ ok: true });
  });

  it("agrees with runtime selection for grant-narrowed accounts and denies an unknown caller", async () => {
    const assignments = ["gioia", "emiliano"].map(id => ({ connection: account(id), binding: { principal: { type: "external_user", id } } }));
    expect(validateConnectionAssignments(assignments)).toEqual({ ok: true });
    const store = { listConnections: vi.fn(async () => assignments.map(a => a.connection)),
      getConnection: vi.fn(async (id: string) => assignments.find(a => a.connection.id === id)?.connection ?? null) } as unknown as ConnectStore;
    for (const id of ["gioia", "emiliano", "stranger"]) {
      const selector = { projectId: "p", audience: "shared" as const, principal: { type: "external_user", id } };
      const resolver = createConnectionAccessResolver({ store, resolveSelector: () => selector,
        policy: { canUseConnection: ({ connection }) => assignments.some(a => a.connection.id === connection.id && matchesConnectionBindingAttributes(a.binding, selector)) } });
      const access = resolver.acquire({ slot: "gmail", spec: { provider: "gmail", scopes: ["mail:read"], mode: "gateway" },
        toolName: "list_mail", toolCallId: "call", invocation: createToolInvocationContext({ requestId: "req", runId: "run", surface: "channel" }) });
      if (id === "stranger") await expect(access).rejects.toMatchObject({ code: "connection_scope_denied" });
      else expect((await access).connection.id).toBe(id);
    }
  });
});
