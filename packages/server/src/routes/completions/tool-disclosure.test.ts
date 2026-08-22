import { describe, expect, it, vi } from "vitest";

import {
  createModelControlledToolPool,
  resolveToolLoadingDecision,
} from "./tool-disclosure.js";

function runtimeTool(
  name: string,
  description: string,
  parameters: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
) {
  return {
    name,
    label: name.replaceAll("_", " "),
    description,
    parameters,
  };
}

function parseResult(value: string): Record<string, any> {
  return JSON.parse(value);
}

describe("tool-loading decision", () => {
  it("keeps historical host integrations direct when no policy is provided", () => {
    expect(resolveToolLoadingDecision(undefined, [runtimeTool("read", "Read a file")]))
      .toMatchObject({
        requestedMode: "direct",
        effectiveMode: "direct",
        reason: "policy_direct",
        toolCount: 1,
      });
  });

  it.each([
    ["direct", "direct", "policy_direct"],
    ["progressive", "progressive", "policy_progressive"],
    ["model-controlled", "progressive", "policy_progressive"],
  ] as const)("resolves %s to %s", (mode, effectiveMode, reason) => {
    expect(resolveToolLoadingDecision({ mode }, [runtimeTool("read", "Read a file")]))
      .toMatchObject({ requestedMode: mode, effectiveMode, reason });
  });

  it("does not expose discovery tools for an empty progressive catalog", () => {
    expect(resolveToolLoadingDecision({ mode: "progressive" }, []))
      .toMatchObject({
        requestedMode: "progressive",
        effectiveMode: "direct",
        reason: "empty_catalog",
        toolCount: 0,
      });
  });

  it("keeps the exact auto tool-count boundary direct", () => {
    const tools = Array.from({ length: 3 }, (_, index) =>
      runtimeTool(`tool_${index}`, `Tool ${index}`),
    );

    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 3, maxDirectSchemaBytes: 100_000 },
      tools,
    )).toMatchObject({
      effectiveMode: "direct",
      reason: "within_auto_budget",
      toolCount: 3,
    });

    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 2, maxDirectSchemaBytes: 100_000 },
      tools,
    )).toMatchObject({
      effectiveMode: "progressive",
      reason: "tool_count_exceeded",
      toolCount: 3,
    });
  });

  it("decides from the effective catalog supplied after policy filtering", () => {
    const rawCatalog = Array.from({ length: 20 }, (_, index) =>
      runtimeTool(`tool_${index}`, `Tool ${index}`),
    );
    const effectiveCatalog = rawCatalog.slice(0, 2);

    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 2, maxDirectSchemaBytes: 100_000 },
      effectiveCatalog,
    )).toMatchObject({ effectiveMode: "direct", toolCount: 2 });
  });

  it("keeps the exact schema-size boundary direct and progresses above it", () => {
    const tools = [runtimeTool("read", "Read a file")];
    const measured = resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 10, maxDirectSchemaBytes: 100_000 },
      tools,
    ).schemaBytes;

    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 10, maxDirectSchemaBytes: measured },
      tools,
    )).toMatchObject({ effectiveMode: "direct", reason: "within_auto_budget" });
    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 10, maxDirectSchemaBytes: measured - 1 },
      tools,
    )).toMatchObject({ effectiveMode: "progressive", reason: "schema_budget_exceeded" });
  });

  it("fails safely into progressive mode for an unserializable tool schema", () => {
    const parameters: Record<string, unknown> = { type: "object" };
    parameters.self = parameters;

    expect(() => resolveToolLoadingDecision(
      { mode: "auto" },
      [runtimeTool("broken", "Circular schema", parameters)],
    )).not.toThrow();
    expect(resolveToolLoadingDecision(
      { mode: "auto" },
      [runtimeTool("broken", "Circular schema", parameters)],
    )).toMatchObject({
      effectiveMode: "progressive",
      reason: "schema_unserializable",
    });
  });

  it("ignores unnamed catalog entries and uses safe defaults for invalid limits", () => {
    expect(resolveToolLoadingDecision(
      { mode: "auto", maxDirectTools: 0, maxDirectSchemaBytes: -1 },
      [{ description: "missing name" }, runtimeTool("read", "Read a file")],
    )).toMatchObject({ effectiveMode: "direct", toolCount: 1 });
  });
});

describe("model-controlled tool disclosure", () => {
  it("starts with discovery and explicitly pinned tools only", () => {
    const pool = createModelControlledToolPool({
      tools: [
        runtimeTool("skill_list", "List assigned skills"),
        runtimeTool("slack_send_message", "Send a message to Slack"),
      ],
      executor: vi.fn(async () => "ok"),
      initiallyLoaded: ["skill_list"],
    });

    expect(pool.activeToolNames()).toEqual([
      "skill_list",
      "polpo_tool_list",
      "polpo_tool_search",
      "polpo_tool_load",
    ]);
    expect(pool.tools.map((tool) => tool.name)).toEqual([
      "skill_list",
      "slack_send_message",
      "polpo_tool_list",
      "polpo_tool_search",
      "polpo_tool_load",
    ]);
  });

  it("keeps discovery read-only and returns compact metadata without schemas", async () => {
    const pool = createModelControlledToolPool({
      tools: [
        runtimeTool("slack_send_message", "Send a message to Slack", {
          type: "object",
          properties: { channelId: { type: "string" }, text: { type: "string" } },
          required: ["channelId", "text"],
        }),
        runtimeTool("discord_send_message", "Send a message to Discord"),
      ],
      executor: vi.fn(async () => "ok"),
    });

    const result = parseResult(await pool.executor("polpo_tool_search", { query: "Slack message" }));

    expect(result.tools).toEqual([
      expect.objectContaining({
        name: "slack_send_message",
        description: "Send a message to Slack",
      }),
    ]);
    expect(result.tools[0]).not.toHaveProperty("parameters");
    expect(result.tools[0]).not.toHaveProperty("inputSchema");
    expect(pool.activeToolNames()).toEqual(["polpo_tool_list", "polpo_tool_search", "polpo_tool_load"]);
  });

  it("loads exact authorized tools atomically and executes them directly", async () => {
    const execute = vi.fn(async (name, args, options) =>
      JSON.stringify({ name, args, callId: options?.callId }),
    );
    const pool = createModelControlledToolPool({
      tools: [
        runtimeTool("slack_list_channels", "List Slack channels"),
        runtimeTool("slack_send_message", "Send a message to Slack"),
      ],
      executor: execute,
    });

    const loaded = parseResult(await pool.executor("polpo_tool_load", {
      names: ["slack_list_channels", "slack_send_message", "slack_list_channels"],
    }));

    expect(loaded.loaded).toEqual(["slack_list_channels", "slack_send_message"]);
    expect(loaded).not.toHaveProperty("tools");
    expect(pool.activeToolNames()).toEqual([
      "slack_list_channels",
      "slack_send_message",
      "polpo_tool_list",
      "polpo_tool_search",
      "polpo_tool_load",
    ]);

    pool.startModelTurn();

    const result = await pool.executor(
      "slack_send_message",
      { channelId: "C123", text: "hello" },
      { callId: "call_1" },
    );

    expect(JSON.parse(result)).toEqual({
      name: "slack_send_message",
      args: { channelId: "C123", text: "hello" },
      callId: "call_1",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not execute a tool loaded later in the same model turn", async () => {
    const execute = vi.fn(async () => "executed");
    const pool = createModelControlledToolPool({
      tools: [runtimeTool("bash", "Run a shell command")],
      executor: execute,
    });

    pool.startModelTurn();
    await pool.executor("polpo_tool_load", { names: ["bash"] });

    await expect(pool.executor("bash", { command: "pwd" })).resolves.toContain("not active");
    expect(execute).not.toHaveBeenCalled();

    pool.startModelTurn();
    await expect(pool.executor("bash", { command: "pwd" })).resolves.toBe("executed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("denies execution before load and never forwards it", async () => {
    const execute = vi.fn(async () => "executed");
    const pool = createModelControlledToolPool({
      tools: [runtimeTool("bash", "Run a shell command")],
      executor: execute,
    });

    await expect(pool.executor("bash", { command: "pwd" })).resolves.toBe(
      'Error: Tool "bash" is not active in this model turn. Use polpo_tool_search and polpo_tool_load, then call it on the next turn.',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an unknown name without partially mutating the pool", async () => {
    const pool = createModelControlledToolPool({
      tools: [runtimeTool("read", "Read a file")],
      executor: vi.fn(async () => "ok"),
    });

    const result = await pool.executor("polpo_tool_load", {
      names: ["read", "admin_delete_everything"],
    });

    expect(result).toBe('Error: Tool "admin_delete_everything" is not available to this agent.');
    expect(pool.activeToolNames()).toEqual(["polpo_tool_list", "polpo_tool_search", "polpo_tool_load"]);
  });

  it("rejects wildcard loads and malformed batches", async () => {
    const pool = createModelControlledToolPool({
      tools: [runtimeTool("read", "Read a file")],
      executor: vi.fn(async () => "ok"),
    });

    await expect(pool.executor("polpo_tool_load", { names: ["*"] })).resolves.toBe(
      'Error: Tool "*" is not available to this agent.',
    );
    await expect(pool.executor("polpo_tool_load", { names: [] })).resolves.toBe(
      "Error: polpo_tool_load requires at least one exact tool name.",
    );
    await expect(pool.executor("polpo_tool_load", { names: "read" as any })).resolves.toBe(
      "Error: polpo_tool_load requires an array of exact tool names.",
    );
  });

  it("enforces load and pool limits atomically", async () => {
    const pool = createModelControlledToolPool({
      tools: [
        runtimeTool("one", "First tool"),
        runtimeTool("two", "Second tool"),
        runtimeTool("three", "Third tool"),
      ],
      executor: vi.fn(async () => "ok"),
      maxLoadedTools: 2,
      maxLoadBatch: 2,
    });

    await expect(pool.executor("polpo_tool_load", { names: ["one", "two", "three"] })).resolves.toBe(
      "Error: polpo_tool_load accepts at most 2 names per call.",
    );
    expect(pool.activeToolNames()).toEqual(["polpo_tool_list", "polpo_tool_search", "polpo_tool_load"]);

    await pool.executor("polpo_tool_load", { names: ["one", "two"] });
    await expect(pool.executor("polpo_tool_load", { names: ["three"] })).resolves.toBe(
      "Error: Tool pool limit reached (2 loaded tools).",
    );
    expect(pool.activeToolNames()).toEqual([
      "one",
      "two",
      "polpo_tool_list",
      "polpo_tool_search",
      "polpo_tool_load",
    ]);
  });

  it("rejects catalog collisions with reserved discovery names", () => {
    expect(() => createModelControlledToolPool({
      tools: [runtimeTool("polpo_tool_load", "Host-defined collision")],
      executor: vi.fn(async () => "ok"),
    })).toThrow('Tool catalog contains reserved disclosure name "polpo_tool_load".');
  });

  it("keeps state isolated between concurrent run pools", async () => {
    const tools = [runtimeTool("read", "Read a file")];
    const first = createModelControlledToolPool({ tools, executor: vi.fn(async () => "ok") });
    const second = createModelControlledToolPool({ tools, executor: vi.fn(async () => "ok") });

    await first.executor("polpo_tool_load", { names: ["read"] });

    expect(first.activeToolNames()).toContain("read");
    expect(second.activeToolNames()).not.toContain("read");
  });
});
