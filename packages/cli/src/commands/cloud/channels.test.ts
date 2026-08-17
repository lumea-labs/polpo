import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { conversationChannelPath, registerChannelsCommand } from "./channels.js";

describe("Channels CLI", () => {
  it("encodes every resource path segment", () => {
    expect(conversationChannelPath("channel/a", "routes", "route b"))
      .toBe("/v1/channels/channel%2Fa/routes/route%20b");
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
  });
});
