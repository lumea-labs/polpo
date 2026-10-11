import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { createRemoteCustomTools, createToolInvocationContext, type PolpoTool } from "@polpo-ai/core";
import { createCustomToolRunnerBroker, CustomToolRunnerBrokerError } from "../custom-tool-runner-broker.js";

const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "task", user: "owner",
  agent: { name: "support", incarnation: "original" } });
const result = { content: [{ type: "text" as const, text: "mail" }], details: null };
const metadata = () => ({ name: "read_mail", label: "Mail", description: "Read mail", parameters: Type.Object({}) });
afterEach(() => vi.useRealTimers());
function fixture() {
  const execute = vi.fn(async () => result);
  const tools: PolpoTool[] = [{ ...metadata(), execute }];
  const used = new Set<string>();
  const assertActive = vi.fn(async () => {});
  const resolveTools = vi.fn(async () => tools);
  const claimCall = vi.fn(async (id: string) => {
    if (used.has(id)) throw new CustomToolRunnerBrokerError(409);
    used.add(id);
  });
  const authorize = vi.fn(async (token: string, sandboxId: string) => {
    if (token !== "private_token" || sandboxId !== "sandbox") throw new CustomToolRunnerBrokerError(401);
    return { agentName: "support", invocation, inventory: [metadata()], expiresAt: Date.now() + 60_000, assertActive, claimCall, resolveTools };
  });
  const broker = createCustomToolRunnerBroker({ authorize });
  const request = (body: unknown, signal?: AbortSignal) => broker(new Request("https://host.test/custom-tools", {
    method: "POST", headers: { authorization: "Bearer private_token", "x-polpo-sandbox-id": "sandbox" },
    body: JSON.stringify(body), signal,
  }));
  const call = (extra = {}) => ({ operation: "call", toolName: "read_mail", toolCallId: "call", arguments: {}, ...extra });
  return { execute, tools, used, assertActive, resolveTools, claimCall, authorize, broker, request, call };
}

describe("custom tool runner broker", () => {
  it("round trips the OSS remote port without passing caller authority or importing code in the broker", async () => {
    const f = fixture();
    const resolve = createRemoteCustomTools({ version: 1, url: "https://host.test/custom-tools", token: "private_token",
      sandboxId: "sandbox", agentName: "support", agentIdentity: invocation.agent!, runId: "run",
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, {
      fetch: async (url, options) => f.broker(new Request(url, options)),
    });
    const [tool] = await resolve({ agentName: "support", invocation, allowedTools: ["*"] });
    expect(await tool.execute("call", { user: "forged" })).toEqual(result);
    expect(f.resolveTools).toHaveBeenCalledWith(expect.objectContaining({ agentName: "support", invocation,
      allowedTools: ["read_mail"], signal: expect.any(AbortSignal) }));
    expect(f.execute).toHaveBeenCalledWith("call", { user: "forged" }, expect.any(AbortSignal));
    expect(f.assertActive).toHaveBeenCalledTimes(4);
  });

  it("lists frozen metadata without invoking the tool host", async () => {
    const f = fixture();
    expect((await f.request({ operation: "inventory" })).status).toBe(200);
    expect(f.resolveTools).not.toHaveBeenCalled();
  });

  it.each(["tool", "provider", "identity", "expired", "schema", "description", "duplicate"])("denies %s before code execution", async scenario => {
    const f = fixture();
    let body = f.call();
    if (scenario === "tool") body = f.call({ toolName: "not_granted" });
    if (scenario === "provider") body = f.call({ provider: "other" });
    if (scenario === "identity") body = f.call({ invocation: { user: "attacker" } });
    if (scenario === "expired") f.assertActive.mockRejectedValue(new CustomToolRunnerBrokerError(403));
    if (scenario === "schema") f.tools[0].parameters = Type.Object({ changed: Type.String() });
    if (scenario === "description") f.tools[0].description = "Changed";
    if (scenario === "duplicate") f.tools.push({ ...f.tools[0] });
    expect((await f.request(body)).status).not.toBe(200);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("never retries failed or disconnected mutations, including replayed call IDs", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error("credential_should_not_escape"));
    const first = await f.request(f.call());
    expect(first.status).toBe(503);
    expect(await first.text()).not.toContain("credential_should_not_escape");
    expect((await f.request(f.call())).status).toBe(409);
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it("checks revocation again after asynchronous tool preparation", async () => {
    const f = fixture();
    f.resolveTools.mockImplementation(async () => {
      f.assertActive.mockRejectedValue(new CustomToolRunnerBrokerError(403));
      return f.tools;
    });
    expect((await f.request(f.call())).status).toBe(403);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("cancels host execution on disconnect and does not wait for a stuck tool", async () => {
    const f = fixture();
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    f.tools[0].execute = async (_id, _args, received) => {
      signal = received;
      controller.abort();
      return new Promise(() => {});
    };
    expect((await f.request(f.call(), controller.signal)).status).toBe(408);
    expect(signal?.aborted).toBe(true);
  });

  it("cancels execution at server-side lease expiry even if a caller ignores client limits", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal: AbortSignal | undefined;
    f.tools[0].execute = async (_id, _args, received) => { signal = received; return new Promise(() => {}); };
    const work = f.request(f.call());
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await work).status).toBe(408);
    expect(signal?.aborted).toBe(true);
  });

  it("rejects invalid results without reflecting private diagnostic fields", async () => {
    const f = fixture();
    f.execute.mockResolvedValue({ ...result, credential: "private_value" } as typeof result);
    const response = await f.request(f.call());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private_value");
  });
});
