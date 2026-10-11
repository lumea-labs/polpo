import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import type { PolpoTool, SpawnContext } from "@polpo-ai/core";
import { createToolInvocationContext } from "@polpo-ai/tools";
import { buildAgentTools, type SpawnPrep } from "../adapters/spawn-helpers.js";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";

const local = vi.hoisted(() => ({ create: vi.fn(), loadAssigned: vi.fn() }));
vi.mock("../custom-tools/runtime.js", () => ({ createLocalCustomToolRuntime: local.create }));

const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "task",
  agent: { name: "worker", incarnation: "original" }, user: "customer" });
const prep = { polpoDir: "/tenant/.polpo", fs: new NodeFileSystem(), shell: new NodeShell(),
  hasExtendedTools: false, systemPrompt: "", browserProfileDir: "/tenant/browser", maxTurns: 1,
  model: undefined as never } satisfies SpawnPrep;
function tool(name: string): PolpoTool {
  return { name, label: name, description: name, parameters: Type.Object({}),
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "remote result" }], details: {} })) };
}
beforeEach(() => {
  vi.clearAllMocks();
  local.loadAssigned.mockResolvedValue([]);
  local.create.mockReturnValue({ loadAssigned: local.loadAssigned });
});

describe("host-owned custom tool execution", () => {
  it("uses host tools with captured identity and signal without constructing the local importer", async () => {
    const selected = tool("signed_request");
    const resolveCustomTools = vi.fn(async () => [selected]);
    const controller = new AbortController();
    const ctx = { polpoDir: prep.polpoDir, toolInvocation: invocation, resolveCustomTools } satisfies SpawnContext;
    const result = await buildAgentTools({ name: "worker", allowedTools: [selected.name] }, "/tenant", prep, ctx,
      { signal: controller.signal });
    expect(resolveCustomTools).toHaveBeenCalledWith({ agentName: "worker", allowedTools: [selected.name],
      invocation, signal: controller.signal });
    expect(local.create).not.toHaveBeenCalled();
    expect(result.tools.find(item => item.name === selected.name)).toBe(selected);
    await result.tools.find(item => item.name === selected.name)!.execute("call", {});
    expect(selected.execute).toHaveBeenCalledWith("call", {});
    await result.cleanup();
  });

  it("applies exact custom-tool assignment and narrower loop policy to the host palette", async () => {
    const resolveCustomTools = vi.fn(async () => [tool("approved"), tool("removed"), tool("image_custom")]);
    const result = await buildAgentTools({ name: "worker", allowedTools: ["approved", "removed", "image_*"] },
      "/tenant", prep, { polpoDir: prep.polpoDir, toolInvocation: invocation, resolveCustomTools },
      { policy: { loop: ["approved", "image_*"] } });
    expect(result.tools.map(item => item.name)).toContain("approved");
    expect(result.tools.map(item => item.name)).not.toContain("removed");
    expect(result.tools.map(item => item.name)).not.toContain("image_custom");
    expect(local.create).not.toHaveBeenCalled();
    await result.cleanup();
  });

  it.each(["empty", "failure"])("never falls back to importing tenant code when the host returns %s", async outcome => {
    const resolveCustomTools = vi.fn(async () => {
      if (outcome === "failure") throw new Error("Host executor unavailable");
      return [];
    });
    const pending = buildAgentTools({ name: "worker", allowedTools: ["approved"] }, "/tenant", prep,
      { polpoDir: prep.polpoDir, resolveCustomTools });
    if (outcome === "failure") await expect(pending).rejects.toThrow("Host executor unavailable");
    else await (await pending).cleanup();
    expect(local.create).not.toHaveBeenCalled();
  });

  it("preserves the local OSS loader when no host executor is configured", async () => {
    const result = await buildAgentTools({ name: "worker", allowedTools: ["approved"] }, "/tenant", prep,
      { polpoDir: prep.polpoDir, toolInvocation: invocation });
    expect(local.create).toHaveBeenCalledOnce();
    expect(local.loadAssigned).toHaveBeenCalledWith(["approved"], undefined, invocation);
    await result.cleanup();
  });
});
