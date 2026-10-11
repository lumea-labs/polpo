import { describe, expect, it, vi } from "vitest";
import { ConnectionSelectionError, createToolInvocationContext, type McpCapabilityResolveInput } from "@polpo-ai/core";
import { resolveConnectionMcpTools, resolveRuntimeMcpTools } from "../mcp-client.js";

const legacyClient = vi.hoisted(() => vi.fn());
vi.mock("@ai-sdk/mcp", () => ({ createMCPClient: legacyClient }));

const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "chat", user: "customer-a" });
function fixture() {
  const call = vi.fn(async () => ({ content: [{ type: "text", text: "read complete" }] }));
  const dispose = vi.fn();
  const resolve = vi.fn(async (_input: McpCapabilityResolveInput) => ({ call, dispose }));
  const runtime = { docs: { tools: [{ name: "read", description: "Read a document", inputSchema: { type: "object", properties: { query: { type: "string" } } } }], resolver: { resolve } } };
  return { call, dispose, resolve, runtime };
}

describe("agent tools backed by acquired MCP capabilities", () => {
  it.each(["local", "remote"])("preserves a sanitized %s quota error through the actual agent tool", async source => {
    const f = fixture(); const palette = resolveConnectionMcpTools(f.runtime, invocation);
    f.call.mockRejectedValueOnce(Object.assign(new Error("private token and account"), { code: "rate_limited",
      ...(source === "remote" ? { retryAfterSeconds: 7 } : { details: { retryAfterSeconds: 7, private: "secret" } }),
    }));
    const error = await palette.tools[0].execute("call-limit", {}).catch(error => error);
    expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 7, message: "Connection request limit exceeded; retry after 7 seconds" });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(f.call).toHaveBeenCalledOnce();
    await palette.dispose();
  });
  it.each([0, 1.5, 86401, "7", null])("redacts untrusted quota retry %j at the agent tool", async retryAfterSeconds => {
    const f = fixture(); const palette = resolveConnectionMcpTools(f.runtime, invocation);
    f.call.mockRejectedValueOnce(Object.assign(new Error("private"), { code: "rate_limited", retryAfterSeconds }));
    await expect(palette.tools[0].execute("call-limit", {})).rejects.toThrow(/^MCP request failed$/);
    await palette.dispose();
  });
  it("does not start legacy transports when the host only supports Connection capabilities", async () => {
    const palette = await resolveRuntimeMcpTools({ agentName: "assistant", invocation, allowLegacy: false,
      mcpServers: { local: { command: "must-not-run" }, public: { type: "http", url: "https://mcp.example" } } });
    expect(palette.tools).toEqual([]);
    expect(legacyClient).not.toHaveBeenCalled();
    await palette.dispose();
  });
  it("claims a managed namespace without opening the authored URL and intersects tool policies", async () => {
    const f = fixture();
    f.runtime.docs.tools.push({ ...f.runtime.docs.tools[0], name: "write" });
    const palette = await resolveRuntimeMcpTools({ agentName: "assistant", invocation,
      mcpServers: { docs: { type: "http", url: "https://untrusted.example", connectionId: "account-a" } },
      resolveCapabilities: async () => f.runtime, policy: { global: ["mcp__docs__*"], step: ["*read"] } });
    expect(palette.tools.map(tool => tool.name)).toEqual(["mcp__docs__read"]);
    expect(legacyClient).not.toHaveBeenCalled();
    await palette.dispose();
  });
  it.each([undefined, async () => ({})])("denies Connection references without a matching host capability", async resolveCapabilities => {
    await expect(resolveRuntimeMcpTools({ agentName: "assistant", invocation, resolveCapabilities,
      mcpServers: { docs: { type: "http", url: "https://untrusted.example", connectionId: "account-a" } } })).rejects.toThrow(/capability/i);
    expect(legacyClient).not.toHaveBeenCalled();
  });
  it("does not downgrade a claimed but empty inventory to the legacy URL", async () => {
    const f = fixture();
    const palette = await resolveRuntimeMcpTools({ agentName: "assistant", invocation,
      mcpServers: { docs: { type: "http", url: "https://untrusted.example" } },
      resolveCapabilities: async () => ({ docs: { ...f.runtime.docs, tools: [] } }) });
    expect(palette.tools).toEqual([]);
    expect(legacyClient).not.toHaveBeenCalled();
    await palette.dispose();
  });
  it("cancels suspended inventory resolution without opening a transport", async () => {
    const controller = new AbortController();
    const result = resolveRuntimeMcpTools({ agentName: "assistant", invocation, signal: controller.signal,
      resolveCapabilities: () => new Promise(() => {}) });
    controller.abort();
    await expect(result).rejects.toThrow(/cancelled/i);
    expect(legacyClient).not.toHaveBeenCalled();
  });
  it("exposes only verified inventory and resolves the actual run identity at execution", async () => {
    const f = fixture(); const palette = resolveConnectionMcpTools(f.runtime, invocation);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(palette.tools.map(tool => tool.name)).toEqual(["mcp__docs__read"]);
    const result = await palette.tools[0].execute("tool-call", { user: "other", serverName: "other", query: "test" });
    expect(result.content).toEqual([{ type: "text", text: "read complete" }]);
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ serverName: "docs", toolName: "read", toolCallId: "tool-call", invocation }));
    expect(f.dispose).toHaveBeenCalledOnce();
    await palette.dispose();
  });
  it("never executes after an authorization denial or after the palette is disposed", async () => {
    const f = fixture(); const palette = resolveConnectionMcpTools(f.runtime, invocation);
    f.resolve.mockRejectedValueOnce(new ConnectionSelectionError("connection_scope_denied", "No permission"));
    await expect(palette.tools[0].execute("call-a", {})).rejects.toThrow("not authorized");
    expect(f.call).not.toHaveBeenCalled();
    await palette.dispose();
    await expect(palette.tools[0].execute("call-b", {})).rejects.toThrow();
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });
  it("cleans up a failed call and aborts active work on runtime cleanup", async () => {
    const f = fixture(); const palette = resolveConnectionMcpTools(f.runtime, invocation);
    f.call.mockImplementationOnce(async () => { await palette.dispose(); throw new Error("cancelled"); });
    await expect(palette.tools[0].execute("tool-call", {})).rejects.toThrow("MCP request failed");
    expect(f.resolve.mock.calls[0][0].signal?.aborted).toBe(true);
    expect(f.dispose).toHaveBeenCalled();
  });
  it("rejects ambiguous tool names before exposing a palette", () => {
    const f = fixture(); f.runtime.docs.tools.push(f.runtime.docs.tools[0]);
    expect(() => resolveConnectionMcpTools(f.runtime, invocation)).toThrow(/duplicate/i);
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("redacts host error details from the model while reporting them to the host observer", async () => {
    const f = fixture();
    const onError = vi.fn();
    const palette = resolveConnectionMcpTools({ docs: { ...f.runtime.docs, onError } }, invocation);
    const privateError = Object.assign(new Error("Connection account-secret secretRef vault/private-token missing"), { code: "connection_not_found" });
    f.resolve.mockRejectedValueOnce(privateError);
    const error = await palette.tools[0].execute("call-a", {}).catch(error => error);
    expect(String(error)).not.toMatch(/account-secret|secretRef|private-token/);
    expect(error.message).toBe("MCP request failed");
    expect(onError).toHaveBeenCalledWith(privateError, expect.objectContaining({ serverName: "docs", toolName: "read", invocation }));
    await palette.dispose();
  });
});
