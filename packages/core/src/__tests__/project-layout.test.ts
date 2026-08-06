import { describe, expect, it } from "vitest";
import {
  materializeAgentDefinition,
  materializeTeamDefinition,
  serializeAgentDefinition,
  serializeTeamDefinition,
} from "../project-layout.js";
import type { AgentConfig } from "../types.js";

describe("project layout v2 agent definitions", () => {
  it("materializes the directory id and instructions into runtime fields", () => {
    expect(materializeAgentDefinition(
      "support",
      {
        role: "Support engineer",
        team: "customer-success",
        model: { profile: "paid" },
        allowedTools: ["slack_*"],
        mcpServers: {
          docs: { type: "http", url: "https://example.com/mcp" },
        },
      },
      "Answer concisely.\n",
    )).toEqual({
      agent: {
        name: "support",
        role: "Support engineer",
        model: { profile: "paid" },
        allowedTools: ["slack_*"],
        mcpServers: {
          docs: { type: "http", url: "https://example.com/mcp" },
        },
        systemPrompt: "Answer concisely.\n",
      },
      teamName: "customer-success",
    });
  });

  it("round-trips every authored field without persisting runtime metadata", () => {
    const agent: AgentConfig = {
      name: "builder",
      createdAt: "2026-08-06T12:00:00.000Z",
      role: "Builder",
      model: { primary: { profile: "pro" }, fallbacks: ["openai/gpt-5"] },
      modelRouting: { mode: "off" },
      allowedTools: ["bash", "read"],
      allowedPaths: ["/workspace"],
      systemPrompt: "Build the requested product.",
      skills: ["frontend-design"],
      maxTurns: 42,
      sandbox: {
        isolation: "fresh",
        lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
      },
      mcpServers: {
        local: { command: "node", args: ["server.js"], env: { MODE: "test" } },
      },
    };

    const serialized = serializeAgentDefinition(agent, "product");
    expect(serialized.definition).not.toHaveProperty("name");
    expect(serialized.definition).not.toHaveProperty("systemPrompt");
    expect(serialized.definition).not.toHaveProperty("createdAt");
    expect(serialized.instructions).toBe(agent.systemPrompt);

    expect(materializeAgentDefinition(
      agent.name,
      serialized.definition,
      serialized.instructions,
    )).toEqual({
      agent: { ...agent, createdAt: undefined },
      teamName: "product",
    });
  });

  it.each(["", " support", "support ", ".", "..", "../ops", "ops\\admin", "bad\u0000id"])(
    "rejects unsafe agent id %j",
    (name) => {
      expect(() => materializeAgentDefinition(name, {}, "")).toThrow(/Invalid agent id/);
    },
  );

  it.each(["name", "systemPrompt", "createdAt"])(
    "rejects reserved field %s in agent.json",
    (field) => {
      expect(() => materializeAgentDefinition("support", { [field]: "value" }, ""))
        .toThrow(`must not define "${field}"`);
    },
  );

  it("rejects malformed definitions and team ids", () => {
    expect(() => materializeAgentDefinition("support", [], ""))
      .toThrow("agent.json must contain a JSON object");
    expect(() => materializeAgentDefinition("support", { team: "../ops" }, ""))
      .toThrow(/Invalid team id/);
    expect(() => materializeAgentDefinition("support", { team: 42 }, ""))
      .toThrow("team must be a string");
  });

  it("omits an empty instructions file from the runtime prompt", () => {
    expect(materializeAgentDefinition("support", {}, "").agent)
      .toEqual({ name: "support" });
  });

  it("materializes and serializes teams without duplicated identity or agents", () => {
    const team = materializeTeamDefinition("platform", {
      description: "Platform team",
    });
    expect(team).toEqual({
      name: "platform",
      description: "Platform team",
      agents: [],
    });
    expect(serializeTeamDefinition({
      ...team,
      agents: [{ name: "builder" }],
    })).toEqual({ description: "Platform team" });
  });

  it.each(["name", "agents"])("rejects reserved team field %s", (field) => {
    expect(() => materializeTeamDefinition("platform", { [field]: [] }))
      .toThrow(`must not define "${field}"`);
  });
});
