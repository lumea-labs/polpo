import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionSelectionError } from "@polpo-ai/core";
import { ConnectError } from "@polpo-ai/connect";
import { callRemoteMcpTool } from "../mcp-execution.js";

function fixture(session = false, terminate?: () => Promise<Response>) {
  const methods: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return terminate ? terminate() : new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body));
    methods.push(request.method);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { content: [{ type: "text", text: "read completed" }] };
    return Response.json({ jsonrpc: "2.0", id: request.id, result }, { headers: session && request.method === "initialize" ? { "mcp-session-id": "private-session" } : {} });
  });
  return { methods, fetch };
}

describe("authorized remote MCP execution transport", () => {
  it("blocks transport before dispatch when the host budget is exhausted", async () => {
    const f = fixture();
    const authorize = vi.fn(async () => ({}));
    const beforeDispatch = vi.fn(async () => { throw new ConnectError("rate_limited", "Connection request limit exceeded"); });
    await expect(callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", authorize, beforeDispatch, fetch: f.fetch }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(authorize).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not turn a completed operation into a failure when cleanup is rate limited", async () => {
    const f = fixture(true);
    const beforeDispatch = vi.fn(async ({ method }: { method: string }) => {
      if (method === "DELETE") throw new ConnectError("rate_limited", "Connection request limit exceeded");
    });
    const result = await callRemoteMcpTool({ url: "https://mcp.example/tools", name: "write", authorize: async () => ({}), beforeDispatch, fetch: f.fetch });
    expect(result.content).toEqual([{ type: "text", text: "read completed" }]);
    expect(beforeDispatch).toHaveBeenCalledWith({ method: "DELETE" });
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  afterEach(() => vi.useRealTimers());
  it.each([204, 405, 503])("terminates stateful sessions and preserves completed results when DELETE returns %s", async status => {
    const f = fixture(true, async () => new Response(null, { status }));
    const result = await callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", authorize: async () => ({}), fetch: f.fetch });
    expect(result.content).toEqual([{ type: "text", text: "read completed" }]);
    const deletions = f.fetch.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletions).toHaveLength(1);
    expect(new Headers(deletions[0][1]?.headers).get("mcp-session-id")).toBe("private-session");
  });
  it("bounds remote session cleanup without turning a completed mutation into an error", async () => {
    vi.useFakeTimers();
    const f = fixture(true, () => new Promise(() => {}));
    const result = callRemoteMcpTool({ url: "https://mcp.example/tools", name: "write", authorize: async () => ({}), fetch: f.fetch });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).content).toEqual([{ type: "text", text: "read completed" }]);
    expect(f.fetch.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true);
  });
  it("rechecks authorization for cleanup and never sends DELETE after revocation", async () => {
    const f = fixture(true);
    let active = true;
    const result = await callRemoteMcpTool({ url: "https://mcp.example/tools", name: "write",
      authorize: async () => { if (!active) throw new ConnectionSelectionError("connection_scope_denied", "Grant revoked"); return {}; },
      fetch: async (url, init) => {
        const response = await f.fetch(url, init);
        if (init?.body && JSON.parse(String(init.body)).method === "tools/call") active = false;
        return response;
      } });
    expect(result.content).toEqual([{ type: "text", text: "read completed" }]);
    expect(f.fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("executes exactly one named MCP operation with freshly authorized headers for each request", async () => {
    const f = fixture();
    let generation = 0;
    const authorize = vi.fn(async () => ({ Authorization: `Bearer private-${++generation}` }));
    const result = await callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", arguments: { query: "hello" },
      authorize, fetch: f.fetch });
    expect(result.content).toEqual([{ type: "text", text: "read completed" }]);
    expect(f.methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    const call = f.fetch.mock.calls.find(([, init]) => init?.body && JSON.parse(String(init.body)).method === "tools/call")!;
    expect(JSON.parse(String(call[1]?.body)).params).toEqual({ name: "read", arguments: { query: "hello" } });
    const headers = f.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("authorization"));
    expect(new Set(headers).size).toBe(f.fetch.mock.calls.length);
    expect(authorize).toHaveBeenCalledTimes(f.fetch.mock.calls.length);
    expect(f.fetch.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
  it("blocks a revoked grant after handshake before sending the tool call", async () => {
    const f = fixture();
    let active = true;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await f.fetch(url, init);
      if (init?.body && JSON.parse(String(init.body)).method === "notifications/initialized") active = false;
      return response;
    };
    await expect(callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", fetch,
      authorize: async () => { if (!active) throw new ConnectionSelectionError("connection_scope_denied", "Grant revoked"); return { Authorization: "Bearer private" }; },
    })).rejects.toMatchObject({ code: "connection_scope_denied" });
    expect(f.methods).not.toContain("tools/call");
  });
  it("requires host authorization and rejects unsafe destinations before obtaining credentials", async () => {
    const f = fixture();
    const authorize = vi.fn(async () => ({ Authorization: "Bearer private" }));
    await expect(callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", fetch: f.fetch } as any)).rejects.toThrow();
    await expect(callRemoteMcpTool({ url: "https://127.0.0.1/mcp", name: "read", authorize, fetch: f.fetch })).rejects.toMatchObject({ code: "policy_denied" });
    expect(authorize).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("keeps provider failures redacted and never attempts interactive OAuth", async () => {
    const fetch = vi.fn(async () => new Response("private provider details", { status: 401,
      headers: { "www-authenticate": 'Bearer resource_metadata="https://other.example/oauth"' } }));
    const error = await callRemoteMcpTool({ url: "https://mcp.example/tools", name: "read", authorize: async () => ({}), fetch }).catch(error => error);
    expect(error).toMatchObject({ code: "http_error", details: { providerStatus: 401 } });
    expect(String(error)).not.toContain("private");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
