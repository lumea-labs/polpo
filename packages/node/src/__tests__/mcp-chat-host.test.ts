import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createToolInvocationContext, type McpCapabilityResolveInput } from "@polpo-ai/core";
import type { CompletionRouteDeps } from "@polpo-ai/server";
import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";

let getDeps: () => CompletionRouteDeps;
vi.mock("@polpo-ai/server", async original => ({
  ...await original<typeof import("@polpo-ai/server")>(),
  completionRoutes: (resolve: () => CompletionRouteDeps) => { getDeps = resolve; return new Hono(); },
}));
import { createApp } from "../server/app.js";

describe("Node completion MCP host wiring", () => {
  it("passes the actual call ID, trusted user and cancellation to the host capability", async () => {
    const dispose = vi.fn();
    const resolve = vi.fn(async (_input: McpCapabilityResolveInput) => ({
      call: async () => ({ content: [{ type: "text", text: "verified" }] }), dispose,
    }));
    const factory = vi.fn(async () => ({ docs: { tools: [{ name: "read", inputSchema: { type: "object" } }], resolver: { resolve } } }));
    const noop = () => undefined;
    createApp({ isInitialized: true, getConfig: noop, getAgentStore: () => ({}), getVaultStore: noop, getMemoryStore: noop,
      getMemoryItemStore: noop, getPolpoDir: () => "/tmp/polpo-mcp-no-project/.polpo",
      getAgentWorkDir: () => "/tmp", getFs: () => new NodeFileSystem(), getShell: () => new NodeShell(),
    } as never, {} as never, { resolveMcpCapabilities: factory });
    const controller = new AbortController();
    const invocation = createToolInvocationContext({ requestId: "request", runId: "run", user: "customer-a", surface: "chat", agent: { name: "support", incarnation: "original" } });
    const palette = await getDeps().resolveAgentTools({ name: "support", allowedTools: ["mcp__docs__read"] }, undefined, invocation, controller.signal);
    expect(await palette.executor("mcp__docs__read", { user: "forged" }, { callId: "real-call", signal: controller.signal })).toBe("verified");
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "real-call", invocation }));
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ agentName: "support", invocation, signal: expect.any(AbortSignal) }));
    expect(dispose).toHaveBeenCalledOnce();
    controller.abort();
    await palette.executor("mcp__docs__read", {}, { callId: "cancelled-call", signal: controller.signal });
    expect(resolve.mock.calls.at(-1)?.[0].signal?.aborted).toBe(true);
    await palette.cleanup?.();
  });
});
