import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteMcpRuntimeCapabilities, McpRunnerRequestSchema } from "../mcp-runner.js";
import { createToolInvocationContext } from "../tool-invocation.js";

const invocation = createToolInvocationContext({ requestId: "request", runId: "run", user: "forged-user", surface: "task", agent: { name: "support", incarnation: "original" } });
const lease = () => ({ version: 2 as const, url: "https://polpo.example/mcp", token: "fixture-bearer",
  sandboxId: "sandbox", agentName: "support", agentIdentity: { name: "support", incarnation: "original" }, runId: "run", expiresAt: new Date(Date.now() + 60_000).toISOString() });
const inventory = [{ serverName: "docs", tools: [{ name: "read", inputSchema: { type: "object" } }] }, { serverName: "revoked", tools: [] }];
const json = (data: unknown) => Response.json({ ok: true, data });
const request = { serverName: "docs", toolName: "read", toolCallId: "call", invocation };
const load = (factory: ReturnType<typeof createRemoteMcpRuntimeCapabilities>) => factory({ agentName: "support", invocation });

afterEach(() => vi.useRealTimers());

describe("MCP subprocess protocol", () => {
  it("exposes only a validated rate limit to the agent and never retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(inventory)).mockResolvedValueOnce(Response.json({
      ok: false, error: { code: "rate_limited", message: "private upstream text", retryAfterSeconds: 7, secret: "private" },
    }, { status: 429 }));
    const providers = await load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }));
    const capability = await providers.docs.resolver.resolve(request);
    const error = await capability.call({}).catch(error => error);
    expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 7, message: "Connection request limit exceeded; retry after 7 seconds" });
    expect(JSON.stringify(error)).not.toContain("private");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([0, -1, 1.5, 86401, "7", null])("redacts malformed rate-limit retry %j", async retryAfterSeconds => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      ok: false, error: { code: "rate_limited", message: "private", retryAfterSeconds },
    }, { status: 429 }));
    await expect(load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }))).rejects.toThrow(/^MCP broker request failed$/);
  });
  it.each(["missing", "malformed", "extra-field", "wrong-name", "old-protocol"])("rejects %s lease identity before any request", scenario => {
    const input: any = lease();
    if (scenario === "missing") delete input.agentIdentity;
    if (scenario === "malformed") input.agentIdentity.incarnation = "invalid identity";
    if (scenario === "extra-field") input.agentIdentity.version = 2;
    if (scenario === "wrong-name") input.agentIdentity.name = "other";
    if (scenario === "old-protocol") input.version = 1;
    const fetcher = vi.fn<typeof fetch>();
    expect(() => createRemoteMcpRuntimeCapabilities(input, { fetch: fetcher })).toThrow(/^MCP broker request failed$/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([undefined, { name: "support", incarnation: "replacement" }])("denies missing/substituted identity before inventory (%j)", async agent => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(inventory));
    const factory = createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher });
    await expect(factory({ agentName: "support", invocation: { ...invocation, agent } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("denies a replaced identity at tool acquisition after valid inventory", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(inventory));
    const providers = await load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }));
    await expect(providers.docs.resolver.resolve({ ...request, invocation: { ...invocation, agent: { name: "support", incarnation: "replacement" } } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects caller-controlled identity, destinations and authorization fields", () => {
    for (const field of ["user", "invocation", "agentName", "url", "connectionId", "headers", "allowedTools"]) {
      expect(McpRunnerRequestSchema.safeParse({ operation: "inventory", [field]: "forged" }).success).toBe(false);
      expect(McpRunnerRequestSchema.safeParse({ operation: "call", capability: "mcp__docs__read", toolCallId: "call", arguments: {}, [field]: "forged" }).success).toBe(false);
    }
    expect(McpRunnerRequestSchema.safeParse({ operation: "call", capability: "mcp__docs__read", toolCallId: "call", arguments: [] }).success).toBe(false);
  });

  it("only sends an opaque lease and logical operation; each capability is single use", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(inventory)).mockResolvedValueOnce(json({ content: [{ type: "text", text: "result" }] }));
    const input = lease();
    const factory = createRemoteMcpRuntimeCapabilities(input, { fetch: fetcher });
    input.token = "mutated";
    input.agentIdentity.incarnation = "mutated-after-construction";
    const providers = await load(factory);
    expect(providers.revoked.tools).toEqual([]);
    const capability = await providers.docs.resolver.resolve(request);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await capability.call({ user: "tool-data" })).toEqual({ content: [{ type: "text", text: "result" }] });
    await expect(capability.call({})).rejects.toThrow("no longer available");
    const init = fetcher.mock.calls[1][1]!;
    expect(JSON.parse(init.body as string)).toEqual({ operation: "call", capability: "mcp__docs__read", toolCallId: "call", arguments: { user: "tool-data" } });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-bearer");
    expect(new Headers(init.headers).get("x-polpo-sandbox-id")).toBe("sandbox");
    expect(init.redirect).toBe("error");
    await capability.dispose();
  });

  it("rejects mismatched agent/run, unknown tool, expired lease and unsafe endpoint before network", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(inventory));
    const factory = createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher });
    await expect(factory({ agentName: "other", invocation })).rejects.toThrow();
    await expect(factory({ agentName: "support", invocation: { ...invocation, runId: "other" } })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const providers = await load(factory);
    await expect(providers.docs.resolver.resolve({ ...request, toolName: "write" })).rejects.toThrow();
    await expect(providers.docs.resolver.resolve({ ...request, serverName: "other" })).rejects.toThrow();
    for (const url of ["http://polpo.example/mcp", "https://u:p@polpo.example/mcp", "https://polpo.example/mcp?secret=x", "https://polpo.example/mcp#x", "file:///tmp/mcp"]) {
      expect(() => createRemoteMcpRuntimeCapabilities({ ...lease(), url })).toThrow();
    }
    const expired = createRemoteMcpRuntimeCapabilities({ ...lease(), expiresAt: "2000-01-01T00:00:00.000Z" }, { fetch: fetcher });
    await expect(load(expired)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("redacts remote errors and never retries a possibly completed mutation", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(inventory))
      .mockRejectedValueOnce(new Error("provider secret fixture-bearer https://secret.example"));
    const providers = await load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }));
    const capability = await providers.docs.resolver.resolve(request);
    await expect(capability.call({})).rejects.toThrow(/^MCP broker request failed$/);
    await expect(capability.call({})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("disposal cancels an in-flight call even when the fetch adapter ignores abort", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json(inventory))
      .mockImplementationOnce(() => new Promise(() => {}));
    const providers = await load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }));
    const capability = await providers.docs.resolver.resolve(request);
    const pending = capability.call({});
    const check = expect(pending).rejects.toThrow();
    capability.dispose();
    await check;
    expect((fetcher.mock.calls[1]?.[1]?.signal as AbortSignal)?.aborted ?? true).toBe(true);
  });

  it("bounds inventory stalls and response body reads", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const pending = load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }));
    const check = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30_001);
    await check;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects oversized, malformed and ambiguous inventories without exposing response data", async () => {
    const responses = [
      json([...inventory, inventory[0]]),
      json([{ serverName: "docs", tools: [{ name: "read", inputSchema: {}, token: "secret" }] }]),
      json([{ serverName: "a__b", tools: [{ name: "c", inputSchema: {} }] }, { serverName: "a", tools: [{ name: "b__c", inputSchema: {} }] }]),
      new Response("provider secret", { status: 403 }),
      new Response("x".repeat(2 * 1024 * 1024 + 1)),
    ];
    for (const response of responses) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(load(createRemoteMcpRuntimeCapabilities(lease(), { fetch: fetcher }))).rejects.toThrow(/^MCP /);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
});
