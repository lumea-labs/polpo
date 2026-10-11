import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolInvocationContext } from "@polpo-ai/core";
import type { ConnectionRecord, ConnectStore } from "@polpo-ai/connect";
import { createConnectionMcpCapabilityResolver, type ConnectionMcpCapabilityResolverOptions } from "../mcp-capability-resolver.js";

function setup(overrides: Partial<ConnectionMcpCapabilityResolverOptions> = {}) {
  let granted = true;
  const connection: ConnectionRecord = { id: "account-a", providerId: "mcp-provider", projectId: "project-a",
    authType: "mcp", audience: "shared", status: "active", grantedScopes: ["tools:call"],
    createdAt: "now", updatedAt: "now", metadata: { url: "https://mcp.example/tools" } };
  const records = [connection];
  const methods: string[] = [];
  const headers = vi.fn(async () => ({ Authorization: "Bearer hidden-token" }));
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body)); methods.push(request.method);
    if (request.id === undefined) return new Response(null, { status: 202 });
    const result = request.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1" } } : { content: [{ type: "text", text: "done" }] };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  const resolver = createConnectionMcpCapabilityResolver({
    store: { listConnections: async () => records, getConnection: async id => records.find(record => record.id === id) ?? null } as ConnectStore,
    resolveSelector: () => ({ projectId: "project-a", audience: "shared" }),
    resolveSpec: () => ({ provider: "mcp-provider", scopes: ["tools:call"] }),
    policy: { canUseConnection: () => granted },
    resolveEndpoint: record => ({ url: String(record.metadata?.url) }), resolveHeaders: headers, fetch, ...overrides,
  });
  const input = { serverName: "docs", toolName: "read", toolCallId: "call-a",
    invocation: createToolInvocationContext({ requestId: "request-a", runId: "run-a", surface: "chat" }) };
  return { resolver, input, connection, records, headers, fetch, methods, revoke: () => { granted = false; } };
}

describe("Connection-backed native MCP capability", () => {
  afterEach(() => vi.useRealTimers());
  it.each(["grant", "link", "endpoint", "generation"])("rechecks %s after waiting for the dispatch quota", async change => {
    let linked = true;
    const beforeDispatch = vi.fn(async () => {
      if (change === "grant") f.revoke();
      if (change === "link") linked = false;
      if (change === "endpoint") f.connection.metadata = { url: "https://other.example/mcp" };
      if (change === "generation") f.connection.credentialVersion = "replaced";
    });
    const f = setup({ beforeDispatch, isConnectionVisible: () => linked });
    const capability = await f.resolver.resolve(f.input);
    await expect(capability.call({})).rejects.toThrow();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it.each(["spec", "policy", "endpoint"])("aborts suspended %s acquisition without waiting for the host adapter", async stage => {
    vi.useFakeTimers();
    let release!: (value: any) => void;
    const pending = new Promise<any>(resolve => { release = resolve; });
    const reached = vi.fn(() => pending);
    const f = setup(stage === "spec" ? { resolveSpec: reached } : stage === "policy"
      ? { policy: { canUseConnection: reached } } : { resolveEndpoint: reached });
    const controller = new AbortController();
    let outcome: unknown;
    void f.resolver.resolve({ ...f.input, signal: controller.signal }).catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(reached).toHaveBeenCalled();
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcome).toMatchObject({ code: "connection_scope_denied" });
    release(stage === "spec" ? { provider: "mcp-provider" } : stage === "policy" ? true : { url: "https://mcp.example/tools" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("includes host acquisition and preflight in the same deadline", async () => {
    vi.useFakeTimers();
    const endpoint = vi.fn(async () => ({ url: "https://mcp.example/tools" }));
    const f = setup({ timeoutMs: 50, resolveEndpoint: endpoint });
    const capability = await f.resolver.resolve(f.input);
    endpoint.mockImplementationOnce(() => new Promise(() => {}));
    let outcome: unknown;
    void capability.call({}).catch(error => { outcome = error; });
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome).toMatchObject({ code: "connection_scope_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
    await capability.dispose();
  });
  it("keeps operation, endpoint and credentials out of the model's selection", async () => {
    const f = setup(); const capability = await f.resolver.resolve(f.input);
    await capability.call({ name: "delete", url: "https://attacker.example", connectionId: "account-b" });
    const [, init] = f.fetch.mock.calls.find(([, init]) => init?.body && JSON.parse(String(init.body)).method === "tools/call")!;
    expect(JSON.parse(String(init?.body)).params.name).toBe("read");
    expect(f.fetch.mock.calls.every(([url]) => String(url) === "https://mcp.example/tools")).toBe(true);
    expect(JSON.stringify(capability)).not.toContain("account-a");
    expect(JSON.stringify(capability)).not.toContain("hidden-token");
    await capability.dispose();
    await expect(capability.call({})).rejects.toMatchObject({ code: "connection_scope_denied" });
  });
  it("rechecks grant after credential refresh and never sends a request after revocation", async () => {
    const f = setup(); const capability = await f.resolver.resolve(f.input);
    f.headers.mockImplementationOnce(async () => { f.revoke(); return { Authorization: "Bearer hidden-token" }; });
    await expect(capability.call({})).rejects.toMatchObject({ code: "connection_scope_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
    await capability.dispose();
  });
  it("denies the old execution when the agent is recreated during MCP credential refresh", async () => {
    let incarnation = "original";
    const f = setup({ getAgentSnapshot: async () => ({ agent: { name: "support" }, teamName: "default", revision: { incarnation, version: 0 } }) });
    f.input.invocation = createToolInvocationContext({ ...f.input.invocation, agent: { name: "support", incarnation: "original" } });
    const capability = await f.resolver.resolve(f.input);
    f.headers.mockImplementationOnce(async () => { incarnation = "replacement"; return { Authorization: "Bearer must-not-leave-host" }; });
    await expect(capability.call({})).rejects.toMatchObject({ code: "connection_scope_denied" });
    expect(f.fetch).not.toHaveBeenCalled();
    await capability.dispose();
  });
  it.each(["revoked", "endpoint", "replacement", "generation"])("denies a changed %s account without fallback", async change => {
    const f = setup(); const capability = await f.resolver.resolve(f.input);
    if (change === "revoked") f.connection.status = "revoked";
    if (change === "endpoint") f.connection.metadata = { url: "https://attacker.example/tools" };
    if (change === "replacement") f.records.splice(0, 1, { ...f.connection, id: "account-b" });
    if (change === "generation") f.connection.credentialVersion = "new-generation";
    await expect(capability.call({})).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.headers).not.toHaveBeenCalled();
    await capability.dispose();
  });
  it("isolates two end-user accounts and rechecks project links without choosing another granted account", async () => {
    let linked = true;
    const chosen: string[] = [];
    const f = setup({
      resolveSelector: input => ({ projectId: "project-a", audience: "end_user", principal: { type: "external_user", namespace: "app", id: input.invocation.user! } }),
      isConnectionVisible: () => linked,
      policy: { canUseConnection: ({ connection, subject }) => connection.binding?.principal?.id === subject?.id },
      resolveHeaders: async connection => { chosen.push(connection.id); return {}; },
    });
    f.connection.audience = "end_user";
    f.connection.owner = { type: "external_user", namespace: "app", id: "user-a" };
    f.connection.binding = { principal: { type: "external_user", id: "user-a" } };
    f.records.push({ ...f.connection, id: "account-b", owner: { type: "external_user", namespace: "app", id: "user-b" },
      binding: { principal: { type: "external_user", id: "user-b" } } });
    const a = await f.resolver.resolve({ ...f.input, invocation: createToolInvocationContext({ ...f.input.invocation, user: "user-a" }) });
    const b = await f.resolver.resolve({ ...f.input, invocation: createToolInvocationContext({ ...f.input.invocation, user: "user-b" }) });
    await b.call({ user: "user-a" });
    expect(new Set(chosen)).toEqual(new Set(["account-b"]));
    const sent = f.fetch.mock.calls.length;
    linked = false;
    await expect(a.call({ user: "user-b" })).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledTimes(sent);
    expect(chosen).not.toContain("account-a");
  });

  it("does not materialize an MCP credential for the same user ID in another app", async () => {
    const f = setup({ resolveSelector: () => ({ projectId: "project-a", audience: "end_user",
      principal: { type: "external_user", namespace: "helpdesk", id: "alice" } }) });
    f.connection.audience = "end_user";
    f.connection.owner = { type: "external_user", namespace: "crm", id: "alice" };
    f.connection.binding = { principal: { type: "external_user", id: "alice" } };
    await expect(f.resolver.resolve(f.input)).rejects.toMatchObject({ code: "connection_not_found_for_scope" });
    expect(f.headers).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
