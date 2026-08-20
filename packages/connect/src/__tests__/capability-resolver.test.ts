import { describe, expect, it, vi } from "vitest";

import {
  ConnectionSelectionError,
  createToolInvocationContext,
  type ConnectionCapabilityResolveInput,
} from "@polpo-ai/core";
import {
  createConnectionCapabilityResolver,
  type ConnectionRecord,
  type ConnectStore,
} from "../index.js";

function record(
  id: string,
  overrides: Partial<ConnectionRecord> = {},
): ConnectionRecord {
  return {
    id,
    providerId: "sitoinchat",
    projectId: "project-1",
    authType: "api_key",
    status: "active",
    grantedScopes: ["site:read", "site:write"],
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    binding: {
      principal: { type: "external_user", id: "user-1" },
      tenant: { namespace: "sitoinchat", id: "tenant-1" },
      resource: { namespace: "sitoinchat", type: "site", id: "site-1" },
      scopeEpoch: "9",
    },
    ...overrides,
  };
}

function store(records: ConnectionRecord[]): ConnectStore {
  return {
    listConnections: vi.fn(async () => records),
    getConnection: vi.fn(),
    upsertConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    saveOAuthState: vi.fn(),
    consumeOAuthState: vi.fn(),
  } as unknown as ConnectStore;
}

function input(): ConnectionCapabilityResolveInput {
  return {
    slot: "siteApi",
    spec: { provider: "sitoinchat", scopes: ["site:read"] },
    toolName: "site_context_get",
    toolCallId: "call-1",
    invocation: createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "channel",
      user: "user-1",
      metadata: { tenantId: "tenant-1", siteId: "site-1", scopeEpoch: 9 },
    }),
  };
}

const selector = {
  projectId: "project-1",
  principal: { type: "external_user", id: "user-1" },
  tenant: { namespace: "sitoinchat", id: "tenant-1" },
  resource: { namespace: "sitoinchat", type: "site", id: "site-1" },
  scopeEpoch: "9",
} as const;

describe("createConnectionCapabilityResolver", () => {
  it("selects one exact active binding and materializes a secret-safe capability", async () => {
    const materialize = vi.fn(async () => ({
      kind: "api_key" as const,
      value: "secret",
      scopes: ["site:read", "site:write"],
      connectionId: "connection-1",
      providerId: "sitoinchat",
      metadata: { headerName: "X-Api-Key" },
    }));
    const resolver = createConnectionCapabilityResolver({
      store: store([record("connection-1")]),
      resolveSelector: () => selector,
      materialize,
    });

    const capability = await resolver.resolve(input());
    expect(capability).not.toHaveProperty("connectionId");
    expect(capability.providerId).toBe("sitoinchat");
    expect(capability.getHeaders?.()).toEqual({ "X-Api-Key": "secret" });
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "connection-1" }),
      expect.objectContaining({ slot: "siteApi" }),
    );
  });

  it("fails deterministically on zero and multiple exact matches", async () => {
    for (const [records, code] of [
      [[], "connection_not_found_for_scope"],
      [[record("one"), record("two")], "connection_selection_ambiguous"],
    ] as const) {
      const resolver = createConnectionCapabilityResolver({
        store: store([...records]),
        resolveSelector: () => selector,
        materialize: vi.fn(),
      });
      await expect(resolver.resolve(input())).rejects.toMatchObject({ code });
    }
  });

  it("does not match a swapped user, tenant, site, or scope epoch", async () => {
    for (const changed of [
      { principal: { type: "external_user", id: "user-2" } },
      { tenant: { namespace: "sitoinchat", id: "tenant-2" } },
      { resource: { namespace: "sitoinchat", type: "site", id: "site-2" } },
      { scopeEpoch: "10" },
    ]) {
      const resolver = createConnectionCapabilityResolver({
        store: store([record("connection-1")]),
        resolveSelector: () => ({ ...selector, ...changed }),
        materialize: vi.fn(),
      });
      await expect(resolver.resolve(input())).rejects.toMatchObject({
        code: "connection_not_found_for_scope",
      });
    }
  });

  it("matches a deliberately shared binding against a more specific invocation", async () => {
    const shared = record("shared", {
      binding: {
        tenant: { namespace: "sitoinchat", id: "tenant-1" },
        resource: { namespace: "sitoinchat", type: "site", id: "site-1" },
      },
    });
    const materialize = vi.fn(async () => ({
      kind: "api_key" as const,
      value: "secret",
      scopes: ["site:read"],
      connectionId: shared.id,
      providerId: shared.providerId,
    }));
    const resolver = createConnectionCapabilityResolver({
      store: store([shared]),
      resolveSelector: () => selector,
      materialize,
    });

    await expect(resolver.resolve(input())).resolves.toMatchObject({
      providerId: "sitoinchat",
    });
    expect(materialize).toHaveBeenCalledWith(
      expect.objectContaining({ id: "shared" }),
      expect.anything(),
    );
  });

  it("does not match a constrained binding when the selector omits that dimension", async () => {
    const resolver = createConnectionCapabilityResolver({
      store: store([record("user-specific")]),
      resolveSelector: () => ({
        projectId: selector.projectId,
        tenant: selector.tenant,
        resource: selector.resource,
        scopeEpoch: selector.scopeEpoch,
      }),
      materialize: vi.fn(),
    });

    await expect(resolver.resolve(input())).rejects.toMatchObject({
      code: "connection_not_found_for_scope",
    });
  });

  it("fails as ambiguous when shared and specific bindings both authorize the invocation", async () => {
    const shared = record("shared", {
      binding: {
        tenant: selector.tenant,
        resource: selector.resource,
        scopeEpoch: selector.scopeEpoch,
      },
    });
    const resolver = createConnectionCapabilityResolver({
      store: store([shared, record("specific")]),
      resolveSelector: () => selector,
      materialize: vi.fn(),
    });

    await expect(resolver.resolve(input())).rejects.toMatchObject({
      code: "connection_selection_ambiguous",
    });
  });

  it("fails with scope denied for insufficient grants or a policy rejection", async () => {
    for (const options of [
      {
        records: [record("connection-1", { grantedScopes: [] })],
      },
      {
        records: [record("connection-1")],
        policy: { canUseConnection: () => false },
      },
    ]) {
      const resolver = createConnectionCapabilityResolver({
        store: store(options.records),
        resolveSelector: () => selector,
        materialize: vi.fn(),
        policy: options.policy,
      });
      await expect(resolver.resolve(input())).rejects.toMatchObject({
        code: "connection_scope_denied",
        status: 403,
      });
    }
  });

  it("wraps store, selector, and materialization failures without failing open", async () => {
    const failingStore = store([]);
    failingStore.listConnections = async () => { throw new Error("db down"); };
    const cases = [
      createConnectionCapabilityResolver({
        store: failingStore,
        resolveSelector: () => selector,
        materialize: vi.fn(),
      }),
      createConnectionCapabilityResolver({
        store: store([record("one")]),
        resolveSelector: () => { throw new Error("mapping down"); },
        materialize: vi.fn(),
      }),
      createConnectionCapabilityResolver({
        store: store([record("one")]),
        resolveSelector: () => selector,
        materialize: async () => { throw new Error("vault down"); },
      }),
    ];
    for (const resolver of cases) {
      await expect(resolver.resolve(input())).rejects.toBeInstanceOf(ConnectionSelectionError);
      await expect(resolver.resolve(input())).rejects.toMatchObject({
        code: "connection_resolver_unavailable",
      });
    }
  });

  it("rejects selectors with missing scope anchors or unsupported fields", async () => {
    for (const badSelector of [
      { ...selector, projectId: "" },
      { ...selector, connectionRef: "attacker-selected" },
      { ...selector, principal: { ...selector.principal, role: "admin" } },
    ]) {
      const resolver = createConnectionCapabilityResolver({
        store: store([record("one")]),
        resolveSelector: () => badSelector as any,
        materialize: vi.fn(),
      });
      await expect(resolver.resolve(input())).rejects.toMatchObject({
        code: "connection_slot_invalid",
      });
    }
  });
});
