import { describe, expect, it, vi } from "vitest";
import { createToolInvocationContext, type McpCapabilityResolveInput, type McpRuntimeCapabilities } from "@polpo-ai/core";
import { createMcpRunnerBroker, McpRunnerBrokerError } from "../mcp-runner-broker.js";
import { ConnectError } from "@polpo-ai/connect";

function fixture() {
  const invocation = createToolInvocationContext({ requestId: "host-request", runId: "host-run", user: "host-user", surface: "task", agent: { name: "support", incarnation: "original" } });
  const dispose = vi.fn();
  const call = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const resolve = vi.fn(async (_input: McpCapabilityResolveInput) => ({ call, dispose }));
  const providers: McpRuntimeCapabilities = { docs: { tools: [{ name: "read", inputSchema: {} }], resolver: { resolve } } };
  const assertActive = vi.fn(async () => {});
  const seen = new Set<string>();
  const claimCall = vi.fn(async (id: string) => {
    if (seen.has(id)) throw new McpRunnerBrokerError(409);
    seen.add(id);
  });
  const resolveCapabilities = vi.fn(async () => providers);
  const authorize = vi.fn(async () => ({ agentName: "support", invocation,
    inventory: [{ serverName: "docs", tools: providers.docs.tools }], resolveCapabilities, assertActive, claimCall }));
  const onError = vi.fn();
  const handler = createMcpRunnerBroker({ authorize, onError });
  const request = (body: unknown, signal?: AbortSignal) => handler(new Request("https://polpo.example/mcp", {
    method: "POST", headers: { authorization: "Bearer fixture-token", "x-polpo-sandbox-id": "sandbox", "content-type": "application/json" },
    body: JSON.stringify(body), signal,
  }));
  const operation = { operation: "call", capability: "mcp__docs__read", toolCallId: "call", arguments: {} };
  return { request, handler, operation, call, dispose, resolve, authorize, resolveCapabilities, invocation, assertActive, claimCall, providers, onError };
}

describe("MCP runner broker", () => {
  it("preserves a typed rate limit without exposing provider or quota details", async () => {
    const f = fixture();
    f.call.mockRejectedValueOnce(new ConnectError("rate_limited", "private details", { details: { retryAfterSeconds: 7, private: "secret" } }));
    const response = await f.request(f.operation);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toEqual({ ok: false, error: { code: "rate_limited", message: "Connection request limit exceeded", retryAfterSeconds: 7 } });
    expect(f.call).toHaveBeenCalledOnce();
  });
  it("denies a host lease without creation identity before inventory or dispatch", async () => {
    const f = fixture();
    const lease = await f.authorize();
    f.authorize.mockResolvedValue({ ...lease, invocation: { ...lease.invocation, agent: undefined } });
    expect((await f.request({ operation: "inventory" })).status).toBe(403);
    expect((await f.request(f.operation)).status).toBe(403);
    expect(f.claimCall).not.toHaveBeenCalled();
    expect(f.call).not.toHaveBeenCalled();
  });

  it("uses only host identity and a fixed tool from the minted inventory", async () => {
    const f = fixture();
    expect((await f.request({ operation: "inventory" })).status).toBe(200);
    expect(f.resolveCapabilities).not.toHaveBeenCalled();
    const response = await f.request({ ...f.operation, arguments: { user: "tool argument" } });
    expect(response.status).toBe(200);
    expect(f.authorize).toHaveBeenCalledWith("fixture-token", "sandbox");
    expect(f.resolveCapabilities).toHaveBeenCalledWith(expect.objectContaining({ agentName: "support", invocation: f.invocation }));
    expect(f.resolve).toHaveBeenCalledWith(expect.objectContaining({ serverName: "docs", toolName: "read", toolCallId: "call", invocation: f.invocation }));
    expect(f.call).toHaveBeenCalledWith({ user: "tool argument" });
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("denies missing auth, forged context, oversized bodies, and tools outside the lease", async () => {
    const f = fixture();
    expect((await f.handler(new Request("https://polpo.example/mcp", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await f.request({ ...f.operation, invocation: f.invocation })).status).toBe(400);
    expect((await f.request({ ...f.operation, arguments: { text: "x".repeat(256 * 1024) } })).status).toBe(413);
    expect((await f.request({ ...f.operation, capability: "mcp__docs__write" })).status).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it("does not retry or repeat a tool call after an ambiguous provider failure", async () => {
    const f = fixture();
    f.call.mockRejectedValueOnce(new Error("provider-secret"));
    const first = await f.request(f.operation);
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("provider-secret");
    expect((await f.request(f.operation)).status).toBe(409);
    expect(f.call).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("denies changed inventory and grants revoked before invocation", async () => {
    const f = fixture();
    (f.providers.docs.tools[0].inputSchema as Record<string, unknown>).changed = true;
    // Snapshot needs to be independent from subsequent provider schema changes.
    f.authorize.mockResolvedValueOnce({ ...(await f.authorize()), inventory: [{ serverName: "docs", tools: [{ name: "read", inputSchema: {} }] }] });
    expect((await f.request(f.operation)).status).toBe(403);
    expect(f.resolve).not.toHaveBeenCalled();
    const g = fixture();
    g.assertActive.mockResolvedValueOnce().mockRejectedValueOnce(new McpRunnerBrokerError(403));
    expect((await g.request(g.operation)).status).toBe(403);
    expect(g.call).not.toHaveBeenCalled();
  });

  it("propagates cancellation and disposes even with an adapter that ignores abort", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.call.mockImplementationOnce(async () => { controller.abort(); return new Promise(() => {}); });
    const response = await f.request(f.operation, controller.signal);
    expect(response.status).toBe(408);
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.resolve.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }));
  });

  it("preserves completed side effects if diagnostic cleanup fails", async () => {
    const f = fixture();
    f.dispose.mockRejectedValueOnce(new Error("cleanup-secret"));
    const response = await f.request(f.operation);
    expect(response.status).toBe(200);
    expect(f.call).toHaveBeenCalledOnce();
    expect((await f.request(f.operation)).status).toBe(409);
  });

  it("disposes an acquisition cancelled between its resolution and outer continuation", async () => {
    const f = fixture();
    const controller = new AbortController();
    let deliver!: (capability: { call: typeof f.call; dispose: typeof f.dispose }) => void;
    f.resolve.mockImplementationOnce(() => new Promise(resolve => { deliver = resolve; }));
    const response = f.request(f.operation, controller.signal);
    await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
    deliver({ call: f.call, dispose: f.dispose });
    queueMicrotask(() => controller.abort());
    expect((await response).status).toBe(408);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it("compares schemas structurally, independently of object key order", async () => {
    const f = fixture();
    (f.providers.docs as { tools: unknown }).tools = [{ inputSchema: { properties: { b: {}, a: {} }, type: "object" }, name: "read" }];
    f.authorize.mockResolvedValueOnce({ ...(await f.authorize()), inventory: [{ serverName: "docs", tools: [{ name: "read", inputSchema: { type: "object", properties: { a: {}, b: {} } } }] }] });
    expect((await f.request(f.operation)).status).toBe(200);
    expect(f.call).toHaveBeenCalledOnce();
  });

  it("bounds inventory responses as well as call results", async () => {
    const f = fixture();
    (f.providers.docs.tools[0].inputSchema as Record<string, unknown>).description = "x".repeat(2 * 1024 * 1024);
    const response = await f.request({ operation: "inventory" });
    expect(response.status).toBe(413);
    expect((await response.text()).length).toBeLessThan(512);
  });
});
