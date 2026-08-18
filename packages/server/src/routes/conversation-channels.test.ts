import { describe, expect, it, vi } from "vitest";
import {
  ChannelManagementService,
  InMemoryChannelManagementStore,
  type ChannelManagementScope,
} from "@polpo-ai/channels";
import { conversationChannelRoutes } from "./conversation-channels.js";

const scope: ChannelManagementScope = {
  actorId: "user-1",
  actorType: "user",
  orgId: "org-1",
  projectId: "project-1",
};

function harness() {
  let sequence = 0;
  const service = new ChannelManagementService({
    store: new InMemoryChannelManagementStore(),
    agentExists: async (_scope, name) => name === "assistant",
    connectionResolver: {
      inspect: async (_scope, id) => ({
        id,
        providerId: "whatsapp",
        status: "active",
      }),
      validateForProvider: async () => {},
    },
    providerAutomation: {
      prepare: async (input) => ({
        status: "ready",
        externalChannelId: input.externalChannelId ?? "phone-1",
      }),
      activate: async () => ({ status: "ready" }),
      test: vi.fn(async () => ({ success: true })),
    },
    createId: (kind) => `${kind}-${++sequence}`,
    now: () => "2026-08-17T10:00:00.000Z",
  });
  const resolveChannelManagementScope = vi.fn(async () => scope);
  return {
    app: conversationChannelRoutes(() => ({
      channelManagementService: service,
      resolveChannelManagementScope,
    })),
    resolveChannelManagementScope,
  };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe("conversationChannelRoutes", () => {
  it("supports configure, CRUD, test, and Route management", async () => {
    const state = harness();
    const configured = await state.app.request("/configure", json("POST", {
      provider: "whatsapp",
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "operation-1",
      settings: {
        identityResolver: {
          connectionId: "resolver-connection-1",
          endpoint: "https://resolver.example.com/v1/channel-context",
          timeoutMs: 2_000,
          type: "http",
          version: 1,
        },
        typingEnabled: true,
      },
    }));
    expect(configured.status).toBe(200);
    expect(await configured.json()).toMatchObject({
      ok: true,
      data: {
        status: "ready",
        channel: {
          id: "channel-1",
          settings: {
            identityResolver: {
              connectionId: "resolver-connection-1",
              endpoint: "https://resolver.example.com/v1/channel-context",
              timeoutMs: 2_000,
              type: "http",
              version: 1,
            },
          },
        },
      },
    });

    expect((await (await state.app.request("/")).json()).data).toHaveLength(1);
    expect((await (await state.app.request("/channel-1")).json()).data.id).toBe("channel-1");

    const updated = await state.app.request("/channel-1", json("PATCH", { name: "Support" }));
    expect((await updated.json()).data.name).toBe("Support");
    expect((await (await state.app.request(
      "/channel-1/test",
      json("POST", { to: "+15551234567" }),
    )).json()).data.success).toBe(true);

    const addedRoute = await state.app.request("/channel-1/routes", json("POST", {
      agentName: "assistant",
      externalChannelId: "phone-2",
      priority: 10,
    }));
    expect(addedRoute.status).toBe(200);
    const routeId = (await addedRoute.json()).data.id;
    expect((await (await state.app.request("/channel-1/routes")).json()).data).toHaveLength(2);

    expect((await state.app.request(`/channel-1/routes/${routeId}`, { method: "DELETE" })).status).toBe(200);
    expect((await state.app.request("/channel-1", { method: "DELETE" })).status).toBe(200);
  });

  it("rejects malformed trusted identity resolver settings", async () => {
    const state = harness();
    const response = await state.app.request("/configure", json("POST", {
      provider: "whatsapp",
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "bad-resolver",
      settings: {
        identityResolver: {
          connectionId: "resolver-connection-1",
          endpoint: "not-a-url",
          type: "http",
          version: 1,
        },
      },
    }));

    expect(response.status).toBe(400);
  });

  it("fails before storage when request validation or authoritative scope fails", async () => {
    const state = harness();
    const invalid = await state.app.request("/configure", json("POST", {
      provider: "whatsapp",
      agentName: "assistant",
      connectionId: "connection-1",
    }));
    expect(invalid.status).toBe(400);

    const missingAgent = await state.app.request("/configure", json("POST", {
      provider: "whatsapp",
      agentName: "missing",
      connectionId: "connection-1",
      idempotencyKey: "operation-1",
    }));
    expect(missingAgent.status).toBe(404);
    expect(await missingAgent.json()).toMatchObject({ ok: false, code: "AGENT_NOT_FOUND" });
    expect(state.resolveChannelManagementScope).toHaveBeenCalled();
  });

  it("returns a deterministic unavailable response when the host omits management", async () => {
    const app = conversationChannelRoutes(() => ({
      resolveChannelManagementScope: async () => scope,
    }));
    const response = await app.request("/");
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Conversation Channel management is not configured",
      code: "CHANNEL_MANAGEMENT_UNAVAILABLE",
    });
  });
});
