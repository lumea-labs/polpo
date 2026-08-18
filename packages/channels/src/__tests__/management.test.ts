import { describe, expect, it, vi } from "vitest";
import {
  ChannelManagementError,
  ChannelManagementService,
  InMemoryChannelManagementStore,
  channelProviderCatalog,
  type ChannelConnectionResolver,
  type ChannelManagementScope,
  type ChannelProviderAutomation,
  type ChannelSecureSetupCoordinator,
} from "../management/index.js";

const scope: ChannelManagementScope = {
  actorId: "user-1",
  actorType: "user",
  orgId: "org-1",
  projectId: "project-1",
};

function harness(options: {
  automation?: ChannelProviderAutomation;
  connectionResolver?: ChannelConnectionResolver;
  onEvent?: ConstructorParameters<typeof ChannelManagementService>[0]["onEvent"];
  onEventError?: ConstructorParameters<typeof ChannelManagementService>[0]["onEventError"];
  secureSetup?: ChannelSecureSetupCoordinator;
} = {}) {
  let sequence = 0;
  const store = new InMemoryChannelManagementStore();
  const connectionResolver = options.connectionResolver ?? {
    inspect: vi.fn(async (_scope, connectionId) => ({
      id: connectionId,
      name: "WhatsApp production",
      providerId: "whatsapp",
      status: "active" as const,
    })),
    validateForProvider: vi.fn(async () => {}),
  };
  const automation = options.automation ?? {
    prepare: vi.fn(async (input) => ({
      status: "ready" as const,
      externalChannelId: input.externalChannelId ?? "phone-1",
    })),
    activate: vi.fn(async () => ({ status: "ready" as const })),
    test: vi.fn(async () => ({ success: true })),
  };
  const service = new ChannelManagementService({
    store,
    connectionResolver,
    providerAutomation: automation,
    secureSetup: options.secureSetup,
    agentExists: async (_scope, agentName) => agentName !== "missing",
    createId: (kind) => `${kind}-${++sequence}`,
    now: () => new Date("2026-08-17T10:00:00.000Z"),
    onEvent: options.onEvent,
    onEventError: options.onEventError,
  });
  return { automation, connectionResolver, service, store };
}

describe("ChannelManagementService", () => {
  it("configures one active channel and route from an existing connection", async () => {
    const state = harness();

    const result = await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "setup-1",
      name: "Customer WhatsApp",
      provider: "whatsapp",
    });

    expect(result).toMatchObject({
      status: "ready",
      channel: {
        connectionId: "connection-1",
        externalChannelId: "phone-1",
        provider: "whatsapp",
        status: "active",
      },
      route: { agentName: "assistant", enabled: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|credentialRevision/i);
  });

  it("merges settings updates and can remove a trusted identity resolver", async () => {
    const state = harness();
    const result = await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "settings-update",
      provider: "whatsapp",
      settings: {
        identityResolver: {
          connectionId: "resolver-connection",
          endpoint: "https://resolver.example.com/channel-context",
          type: "http",
          version: 1,
        },
        typingEnabled: true,
      },
    });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    const renamed = await state.service.update(scope, result.channel.id, {
      settings: { responseModality: "text" },
    });
    expect(renamed.settings).toMatchObject({
      identityResolver: { connectionId: "resolver-connection" },
      responseModality: "text",
      typingEnabled: true,
    });

    const removed = await state.service.update(scope, result.channel.id, {
      settings: { identityResolver: null },
    });
    expect(removed.settings.identityResolver).toBeUndefined();
    expect(removed.settings).toMatchObject({ responseModality: "text", typingEnabled: true });
  });

  it("converges repeated and concurrent idempotent requests", async () => {
    const state = harness();
    const input = {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "same-operation",
      provider: "whatsapp" as const,
    };

    const [first, second] = await Promise.all([
      state.service.configure(scope, input),
      state.service.configure(scope, input),
    ]);

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(first.status === "ready" && second.status === "ready"
      ? first.channel.id === second.channel.id
      : false).toBe(true);
    expect(await state.store.listChannels(scope)).toHaveLength(1);
    expect(await state.store.listRoutes(scope, "channel-1")).toHaveLength(1);
  });

  it("returns a secure setup action without mutating storage when authorization is missing", async () => {
    const secureSetup: ChannelSecureSetupCoordinator = {
      begin: vi.fn(async () => ({
        expiresAt: "2026-08-17T10:10:00.000Z",
        setupId: "setup-1",
        url: "https://dashboard.example/setup/setup-1",
        accessToken: "must-not-escape",
      })),
      get: vi.fn(),
    };
    const state = harness({ secureSetup });

    const result = await state.service.configure(scope, {
      agentName: "assistant",
      externalChannelId: "phone-1",
      idempotencyKey: "setup-needed",
      provider: "whatsapp",
      settings: { typingEnabled: true },
    });

    expect(result).toEqual({
      status: "setup_required",
      setup: {
        expiresAt: "2026-08-17T10:10:00.000Z",
        setupId: "setup-1",
        url: "https://dashboard.example/setup/setup-1",
      },
    });
    expect(await state.store.listChannels(scope)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(secureSetup.begin).toHaveBeenCalledWith(expect.objectContaining({
      requestedConfig: {
        externalChannelId: "phone-1",
        settings: { typingEnabled: true },
      },
    }));
  });

  it("fails closed when a secure setup host is unavailable", async () => {
    const state = harness();

    await expect(state.service.configure(scope, {
      agentName: "assistant",
      idempotencyKey: "missing-setup-host",
      provider: "whatsapp",
    })).rejects.toMatchObject({ code: "SECURE_SETUP_UNAVAILABLE", status: 501 });
  });

  it("rejects malformed or credential-bearing setup URLs", async () => {
    for (const url of [
      "not-a-url",
      "http://example.com/setup/1",
      "https://example.com/setup/1#secret",
      "https://example.com/setup/1?access_token=leaked",
    ]) {
      const state = harness({
        secureSetup: {
          begin: async () => ({
            expiresAt: "2026-08-17T10:10:00.000Z",
            setupId: "setup-1",
            url,
          }),
          get: vi.fn(),
        },
      });
      await expect(state.service.configure(scope, {
        agentName: "assistant",
        idempotencyKey: `invalid-${url}`,
        provider: "whatsapp",
      })).rejects.toMatchObject({ code: "INVALID_SETUP_URL", status: 500 });
      expect(await state.store.listChannels(scope)).toEqual([]);
    }
  });

  it("rejects disabled providers, missing agents, and provider-mismatched connections", async () => {
    const state = harness({
      connectionResolver: {
        inspect: vi.fn(async () => ({
          id: "connection-1",
          providerId: "slack",
          status: "active" as const,
        })),
        validateForProvider: vi.fn(async () => {}),
      },
    });

    await expect(state.service.configure(scope, {
      agentName: "missing",
      connectionId: "connection-1",
      idempotencyKey: "missing-agent",
      provider: "whatsapp",
    })).rejects.toMatchObject({ code: "AGENT_NOT_FOUND", status: 404 });

    await expect(state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      idempotencyKey: "wrong-provider",
      provider: "whatsapp",
    })).rejects.toMatchObject({ code: "CONNECTION_PROVIDER_MISMATCH", status: 409 });

    const unavailable = new ChannelManagementService({
      ...state.service.options,
      providerCatalog: channelProviderCatalog({ whatsapp: false }),
    });
    await expect(unavailable.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      idempotencyKey: "disabled",
      provider: "whatsapp",
    })).rejects.toMatchObject({ code: "PROVIDER_DISABLED", status: 403 });
  });

  it("keeps pending external setup explicit and records activation failure", async () => {
    const pending = harness({
      connectionResolver: {
        inspect: vi.fn(async () => ({
          id: "connection-1",
          providerId: "discord",
          status: "active" as const,
        })),
        validateForProvider: vi.fn(async () => {}),
      },
      automation: {
        prepare: vi.fn(async () => ({
          status: "pending_external" as const,
          externalChannelId: "application-1",
          requirements: [{
            code: "INSTALL_BOT",
            label: "Install the bot",
            accessToken: "must-not-escape",
          }],
        })),
        activate: vi.fn(),
        test: vi.fn(),
      },
    });

    const result = await pending.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      idempotencyKey: "pending",
      provider: "discord",
    });
    expect(result).toMatchObject({
      status: "pending_external",
      requirements: [{ code: "INSTALL_BOT" }],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-escape");
    expect(await pending.store.listChannels(scope)).toEqual([]);

    const failing = harness({
      automation: {
        prepare: vi.fn(async () => ({
          status: "ready" as const,
          externalChannelId: "phone-1",
        })),
        activate: vi.fn(async () => {
          throw new ChannelManagementError("PROVIDER_RATE_LIMITED", "Retry later", 429, true);
        }),
        test: vi.fn(),
      },
    });
    const failed = await failing.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      idempotencyKey: "provider-failure",
      provider: "whatsapp",
    });
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "PROVIDER_RATE_LIMITED", retryable: true },
    });
    expect(await failing.store.getChannel(scope, "channel-1")).toMatchObject({ status: "error" });
  });

  it("projects Connection data before passing it to provider automation", async () => {
    const prepare = vi.fn(async () => ({
      status: "ready" as const,
      externalChannelId: "phone-1",
    }));
    const state = harness({
      connectionResolver: {
        inspect: vi.fn(async () => ({
          id: "connection-1",
          providerId: "whatsapp",
          status: "active" as const,
          accessToken: "must-not-reach-automation",
        })),
        validateForProvider: vi.fn(async () => {}),
      },
      automation: {
        prepare,
        activate: vi.fn(async () => ({ status: "ready" as const })),
        test: vi.fn(async () => ({ success: true })),
      },
    });

    await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      idempotencyKey: "redacted-connection",
      provider: "whatsapp",
    });

    expect(prepare.mock.calls[0]?.[0].connection).toEqual({
      id: "connection-1",
      providerId: "whatsapp",
      status: "active",
    });
  });

  it("isolates resources by organization and project", async () => {
    const state = harness();
    await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "scope",
      provider: "whatsapp",
    });

    expect(await state.store.listChannels({ ...scope, projectId: "other" })).toEqual([]);
    await expect(state.service.get({ ...scope, orgId: "other-org" }, "channel-1"))
      .rejects.toMatchObject({ code: "CHANNEL_NOT_FOUND" });
  });

  it("does not remove a route through a different channel", async () => {
    const state = harness();
    const first = await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "first",
      provider: "whatsapp",
    });
    const second = await state.service.configure(scope, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-2",
      idempotencyKey: "second",
      provider: "whatsapp",
    });
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;

    await expect(state.service.removeRoute(
      scope,
      first.route.id,
      second.channel.id,
    )).rejects.toMatchObject({ code: "ROUTE_NOT_FOUND", status: 404 });
    expect(await state.service.listRoutes(scope, first.channel.id)).toHaveLength(1);
  });

  it("emits redacted lifecycle events and ignores observer failures", async () => {
    const events: unknown[] = [];
    const onEventError = vi.fn();
    const state = harness({
      onEvent: vi.fn(async (event) => {
        events.push(event);
        if (event.outcome === "started") throw new Error("audit unavailable");
      }),
      onEventError: (...args) => {
        onEventError(...args);
        throw new Error("secondary audit failure");
      },
    });

    const result = await state.service.configure({ ...scope, surface: "mcp" }, {
      agentName: "assistant",
      connectionId: "connection-1",
      externalChannelId: "phone-1",
      idempotencyKey: "audited",
      provider: "whatsapp",
      settings: { typingEnabled: true },
    });

    expect(result.status).toBe("ready");
    expect(events).toEqual([
      expect.objectContaining({ outcome: "started", surface: "mcp" }),
      expect.objectContaining({ outcome: "ready", channelId: "channel-1", routeId: "route-2" }),
    ]);
    expect(JSON.stringify(events)).not.toMatch(/typingEnabled|phone-1|idempotencyKey|secret|token/i);
    expect(onEventError).toHaveBeenCalledOnce();
  });
});
