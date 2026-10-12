import { describe, expect, it, vi } from "vitest";
import { discoverRemoteMcpTools } from "../mcp-discovery.js";

function fixture(pages: unknown[] = [{ tools: [] }]) {
  let page = 0;
  const methods: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    methods.push(message.method);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : pages[page++];
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  });
  return { fetch, methods };
}

describe("strict remote MCP discovery", () => {
  it("initializes and reads every tools page without executing tools", async () => {
    const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {} } });
    const f = fixture([{ tools: [tool("first")], nextCursor: "next" }, { tools: [tool("second")] }]);
    const result = await discoverRemoteMcpTools({ url: "https://mcp.example/tools", headers: { Authorization: "Bearer private-key" }, fetch: f.fetch });
    expect(result.map(t => t.name)).toEqual(["first", "second"]);
    expect(f.methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    expect(f.fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer private-key")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-key");
  });

  it("accepts an authenticated empty inventory but rejects a failed handshake", async () => {
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch: fixture().fetch })).resolves.toEqual([]);
    for (const status of [401, 403, 500]) {
      const fetch = vi.fn(async () => new Response("upstream-private-key", { status }));
      const error = await discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch }).catch(e => e);
      expect(error).toMatchObject({ code: "http_error", details: { providerStatus: status } });
      expect(String(error)).not.toContain("upstream-private-key");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("handles Streamable HTTP SSE responses that the SDK cancels after receiving a result", async () => {
    const f = fixture();
    let cancellations = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      const response = await f.fetch(url, init);
      if (response.status !== 200) {
        // Network latency lets the SDK cancel initialization while the wrapped
        // body has a pending pull, before the next request completes.
        await new Promise(resolve => setTimeout(resolve, 10));
        return response.status === 202 ? new Response(new ReadableStream<Uint8Array>({
          cancel() { cancellations++; },
        }), { status: 202 }) : response;
      }
      const data = await response.text();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`)); },
        cancel() { cancellations++; },
      }), { headers: { "content-type": "text/event-stream" } });
    };
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch })).resolves.toEqual([]);
    expect(cancellations).toBe(3);
  });

  it("bounds pagination and malformed or excessive responses", async () => {
    const repeated = fixture([{ tools: [], nextCursor: "repeat" }, { tools: [], nextCursor: "repeat" }]);
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch: repeated.fetch })).rejects.toMatchObject({ code: "http_error" });
    const oversized = vi.fn(async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch: oversized })).rejects.toMatchObject({ code: "http_error", details: { category: "response_too_large" } });
  });

  it("cancels a stalled handshake and never reports zero tools as success", async () => {
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => { signal = init?.signal; return new Promise(() => {}); });
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/tools", fetch, timeoutMs: 25 })).rejects.toMatchObject({ code: "http_error", details: { category: "aborted" } });
    expect(signal?.aborted).toBe(true);
  });

  it("rejects an unsafe initial destination before sending credentials", async () => {
    const fetch = fixture().fetch;
    for (const url of ["https://127.0.0.1/mcp", "http://mcp.example/mcp", "https://user:secret@mcp.example/mcp"]) {
      await expect(discoverRemoteMcpTools({ url, fetch })).rejects.toMatchObject({ code: "policy_denied" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never sends SSE credentials to a server-selected different origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("event: endpoint\ndata: https://attacker.example/messages\n\n", { headers: { "content-type": "text/event-stream" } }));
    // The MCP SDK itself rejects this endpoint before our fetch is reached.
    await expect(discoverRemoteMcpTools({ url: "https://mcp.example/sse", transport: "sse", headers: { Authorization: "Bearer private-key" }, fetch, timeoutMs: 100 })).rejects.toMatchObject({ code: "http_error" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("discovers over SSE with authenticated GET and POST, then closes the stream", async () => {
    const encoder = new TextEncoder();
    let events: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const methods: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      if (init?.method === "GET" || !init?.method) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { events = controller; controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n")); },
          cancel() { closed = true; },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      const message = JSON.parse(String(init?.body));
      methods.push(message.method);
      if (message.id !== undefined) {
        const result = message.method === "initialize"
          ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
          : { tools: [{ name: "read", inputSchema: { type: "object" } }] };
        events.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`));
      }
      return new Response(null, { status: 202 });
    });
    expect(await discoverRemoteMcpTools({ url: "https://mcp.example/sse", transport: "sse", headers: { Authorization: "Bearer private-key" }, fetch })).toHaveLength(1);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") === "Bearer private-key")).toBe(true);
    expect(closed).toBe(true);
  });
});
