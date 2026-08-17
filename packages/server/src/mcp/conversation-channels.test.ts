import { describe, expect, it, vi } from "vitest";
import {
  ChannelManagementService,
  InMemoryChannelManagementStore,
  type ChannelManagementScope,
} from "@polpo-ai/channels";
import { createChannelManagementTools } from "./conversation-channels.js";

const scope: ChannelManagementScope = {
  actorId: "user-1",
  actorType: "user",
  orgId: "org-1",
  projectId: "project-1",
};

describe("createChannelManagementTools", () => {
  it("keeps scope and credentials out of model-visible schemas and supports URL elicitation", async () => {
    const requestUrlElicitation = vi.fn(async () => {});
    const service = new ChannelManagementService({
      store: new InMemoryChannelManagementStore(),
      agentExists: async () => true,
      connectionResolver: {
        inspect: async () => null,
        validateForProvider: async () => {},
      },
      providerAutomation: {
        prepare: vi.fn(),
        activate: vi.fn(),
        test: vi.fn(),
      },
      secureSetup: {
        begin: async () => ({
          setupId: "setup-1",
          url: "https://dashboard.example/channel-setup/setup-1",
          expiresAt: "2026-08-17T10:10:00.000Z",
        }),
        get: vi.fn(),
      },
    });
    const tools = createChannelManagementTools({
      service,
      resolveScope: async () => scope,
      requestUrlElicitation,
    });

    const serialized = JSON.stringify(tools.map(({ inputSchema, name }) => ({ inputSchema, name })));
    expect(serialized).not.toMatch(/orgId|projectId|actorId|accessToken|appSecret|verifyToken/i);

    const configure = tools.find((tool) => tool.name === "polpo_channels_configure")!;
    const result = await configure.execute({
      provider: "whatsapp",
      agentName: "assistant",
      idempotencyKey: "operation-1",
    }, { invocation: { user: "untrusted" } });
    expect(result).toMatchObject({ status: "setup_required" });
    expect(requestUrlElicitation).toHaveBeenCalledWith(
      expect.objectContaining({ setupId: "setup-1" }),
      expect.any(Object),
    );
  });

  it("marks destructive tools and exposes only the intended management suite", () => {
    const service = {} as ChannelManagementService;
    const tools = createChannelManagementTools({ service, resolveScope: () => scope });
    expect(tools.map((tool) => tool.name)).toEqual([
      "polpo_channels_providers",
      "polpo_channels_list",
      "polpo_channels_get",
      "polpo_channels_configure",
      "polpo_channels_update",
      "polpo_channels_test",
      "polpo_channels_remove",
      "polpo_channel_routes_list",
      "polpo_channel_routes_upsert",
      "polpo_channel_routes_remove",
      "polpo_channel_setup_status",
    ]);
    expect(tools.find((tool) => tool.name === "polpo_channels_remove")?.annotations)
      .toMatchObject({ destructiveHint: true });
    expect(tools.find((tool) => tool.name === "polpo_channel_routes_remove")?.annotations)
      .toMatchObject({ destructiveHint: true });
  });
});
