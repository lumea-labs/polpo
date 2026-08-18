import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  channelSettingsFromOptions,
  channelTestBody,
  conversationChannelPath,
  registerChannelsCommand,
} from "./channels.js";

describe("Channels CLI", () => {
  it("encodes every resource path segment", () => {
    expect(conversationChannelPath("channel/a", "routes", "route b"))
      .toBe("/v1/channels/management/channel%2Fa/routes/route%20b");
  });

  it("builds trusted resolver settings without placing bearer credentials in config", () => {
    expect(channelSettingsFromOptions({
      identityResolverConnection: "connection-1",
      identityResolverEndpoint: "https://resolver.example.com/channel-context",
      identityResolverTimeout: "2500",
      settings: '{"typingEnabled":true}',
    })).toEqual({
      identityResolver: {
        connectionId: "connection-1",
        endpoint: "https://resolver.example.com/channel-context",
        timeoutMs: 2500,
        type: "http",
        version: 1,
      },
      typingEnabled: true,
    });
  });

  it("rejects partial or invalid trusted resolver options", () => {
    expect(() => channelSettingsFromOptions({
      identityResolverEndpoint: "https://resolver.example.com/channel-context",
    })).toThrow(/provided together/i);
    expect(() => channelSettingsFromOptions({
      identityResolverConnection: "connection-1",
      identityResolverEndpoint: "https://resolver.example.com/channel-context",
      identityResolverTimeout: "10001",
    })).toThrow(/between 250 and 10000/i);
    expect(() => channelSettingsFromOptions({
      disableIdentityResolver: true,
      identityResolverConnection: "connection-1",
      identityResolverEndpoint: "https://resolver.example.com/channel-context",
    })).toThrow(/cannot be combined/i);
  });

  it("can remove a trusted resolver without affecting other settings", () => {
    expect(channelSettingsFromOptions({
      disableIdentityResolver: true,
      settings: '{"typingEnabled":false}',
    })).toEqual({ identityResolver: null, typingEnabled: false });
  });

  it("sends an explicit recipient only when one is supplied", () => {
    expect(channelTestBody(" +15551234567 ")).toEqual({ to: "+15551234567" });
    expect(channelTestBody("   ")).toBeUndefined();
  });

  it("exposes lifecycle and route commands without credential flags", () => {
    const program = new Command();
    program.exitOverride();
    registerChannelsCommand(program);
    const help = program.commands.find((command) => command.name() === "channels")!.helpInformation();

    expect(help).toContain("providers");
    expect(help).toContain("add");
    expect(help).toContain("routes");
    expect(help).toContain("setup-status");
    expect(help).not.toMatch(/--(?:token|secret|password|api-key|verify-token)/i);

    const channels = program.commands.find((command) => command.name() === "channels")!;
    const add = channels.commands.find((command) => command.name() === "add")!;
    expect(add.registeredArguments[0]?.required).toBe(true);
    expect(add.options.map((option) => option.long)).not.toEqual(expect.arrayContaining([
      "--token",
      "--secret",
      "--password",
      "--api-key",
      "--verify-token",
    ]));
    expect(add.options.map((option) => option.long)).toEqual(expect.arrayContaining([
      "--identity-resolver-endpoint",
      "--identity-resolver-connection",
    ]));
    const test = channels.commands.find((command) => command.name() === "test")!;
    expect(test.options.map((option) => option.long)).toContain("--to");
    const update = channels.commands.find((command) => command.name() === "update")!;
    expect(update.options.map((option) => option.long)).toContain("--disable-identity-resolver");
  });
});
