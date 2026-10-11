import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolInvocationContext } from "../tool-invocation.js";
import { createRemoteCustomTools, CustomToolRunnerRequestSchema, MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES,
  MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES } from "../custom-tool-runner.js";

const lease = () => ({ version: 1 as const, url: "https://host.test/internal/tools", token: "fixture_private_bearer",
  sandboxId: "sandbox", agentName: "support", agentIdentity: { name: "support", incarnation: "original" },
  runId: "run", expiresAt: new Date(Date.now() + 60_000).toISOString() });
const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "task",
  agent: { name: "support", incarnation: "original" }, user: "customer" });
const inventory = [{ name: "read_mail", label: "Read mail", description: "Read", parameters: { type: "object", properties: {} } }];
afterEach(() => vi.useRealTimers());

describe("remote custom-tool host port", () => {
  it("transmits only inventory/call intent, preserving private run authority outside model schemas", async () => {
    const requests: unknown[] = [];
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
      const request = JSON.parse(String(options?.body)); requests.push(request);
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture_private_bearer");
      expect(options?.redirect).toBe("error");
      return Response.json({ ok: true, data: request.operation === "inventory" ? inventory : { content: [{ type: "text", text: "mail" }], details: null } });
    });
    const tools = await createRemoteCustomTools(lease(), { fetch: fetcher as typeof fetch })({ agentName: "support", allowedTools: ["read_mail"], invocation });
    expect(JSON.stringify(tools)).not.toContain("fixture_private_bearer");
    expect(await tools[0].execute("call", { user: "forged" })).toMatchObject({ content: [{ text: "mail" }] });
    expect(requests).toEqual([{ operation: "inventory" }, { operation: "call", toolName: "read_mail", toolCallId: "call", arguments: { user: "forged" } }]);
  });

  it("retains exact custom-tool allowlists without expanding built-in wildcards", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, data: inventory }));
    const resolve = createRemoteCustomTools(lease(), { fetch: fetcher });
    expect(await resolve({ agentName: "support", allowedTools: ["read_*"], invocation })).toEqual([]);
  });

  it.each(["run", "agent", "incarnation", "expired"])("denies mismatched %s before sending a request", async mismatch => {
    const value = lease();
    if (mismatch === "run") value.runId = "different";
    if (mismatch === "agent") { value.agentName = "different"; value.agentIdentity.name = "different"; }
    if (mismatch === "incarnation") value.agentIdentity.incarnation = "replacement";
    if (mismatch === "expired") value.expiresAt = "2000-01-01T00:00:00.000Z";
    const fetcher = vi.fn();
    await expect(createRemoteCustomTools(value, { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not reflect transport exceptions, remote error messages or retry a failed call", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: inventory }))
      .mockRejectedValueOnce(new Error("fixture_private_bearer in SDK request"));
    const [tool] = await createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation });
    await expect(tool.execute("call", {})).rejects.toThrow(/^Custom tool broker request failed$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("honors invocation cancellation before a later call", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async () => Response.json({ ok: true, data: inventory }));
    const [tool] = await createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation, signal: controller.signal });
    controller.abort();
    await expect(tool.execute("call", {})).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["http://remote.test", "https://secret@host.test", "https://host.test?secret=value", "https://host.test#secret", "not-a-url"])("rejects unsafe broker URL %s", url => {
    expect(() => createRemoteCustomTools({ ...lease(), url })).toThrow(/^Custom tool broker request failed$/);
  });

  it.each(["duplicate", "private-metadata", "remote-error", "oversized", "bad-json"])("rejects %s responses without reflecting their content", async scenario => {
    const fetcher = vi.fn(async () => {
      if (scenario === "remote-error") return Response.json({ ok: false, error: { message: "private_secret" } }, { status: 403 });
      if (scenario === "bad-json") return new Response("private_secret");
      if (scenario === "oversized") return new Response("private_secret", { headers: { "content-length": String(MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES + 1) } });
      return Response.json({ ok: true, data: scenario === "duplicate" ? [...inventory, ...inventory] : [{ ...inventory[0], token: "private_secret" }] });
    });
    await expect(createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation }))
      .rejects.toThrow(/^Custom tool broker request failed$/);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("denies oversized arguments before delivery and malformed tool results after delivery", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: inventory }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { token: "private_secret" } }));
    const [tool] = await createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation });
    await expect(tool.execute("call", { value: "x".repeat(MAX_CUSTOM_TOOL_RUNNER_REQUEST_BYTES) })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(tool.execute("call-2", {})).rejects.toThrow(/^Custom tool broker request failed$/);
  });

  it("enforces the byte limit even when content-length is absent", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(MAX_CUSTOM_TOOL_RUNNER_RESPONSE_BYTES + 1));
      controller.close();
    } })));
    await expect(createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", invocation }))
      .rejects.toThrow(/^Custom tool broker request failed$/);
  });

  it("bounds a stuck inventory fetch even if the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Promise<Response>(() => {}));
    const work = createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", invocation });
    const check = expect(work).rejects.toThrow(/^Custom tool capability is no longer available$/);
    await vi.advanceTimersByTimeAsync(30_001);
    await check;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("allows a long-running custom tool past MCP's timeout, then aborts at lease expiry", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, data: inventory }))
      .mockImplementationOnce(async (_url, options) => { signal = options.signal; return new Promise(() => {}); });
    const [tool] = await createRemoteCustomTools(lease(), { fetch: fetcher })({ agentName: "support", allowedTools: ["*"], invocation });
    const check = expect(tool.execute("call", {})).rejects.toThrow(/^Custom tool capability is no longer available$/);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await check;
    expect(signal?.aborted).toBe(true);
  });

  it.each(["provider", "slot", "mode", "connectionId", "invocation", "sandboxId"])("rejects a runner-supplied %s authority override", key => {
    expect(CustomToolRunnerRequestSchema.safeParse({ operation: "call", toolName: "read_mail", toolCallId: "call", arguments: {}, [key]: "forged" }).success).toBe(false);
  });
});
