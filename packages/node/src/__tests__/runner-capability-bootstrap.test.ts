import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readRunnerCapabilities, bindRunnerCapabilities } from "../core/runner-capability-bootstrap.js";

const mcp = () => ({ version: 2 as const, url: "https://polpo.example/mcp", token: "fixture-secret",
  agentName: "support", agentIdentity: { name: "support", incarnation: "original" }, runId: "run", sandboxId: "sandbox", expiresAt: new Date(Date.now() + 60_000).toISOString() });

const payload = () => ({ version: 2 as const, agentName: "support", agentIdentity: { name: "support", incarnation: "original" }, runId: "run", sandboxId: "sandbox", mcp: mcp(),
  data: { url: "https://polpo.example/data", token: "data-secret", sandboxId: "sandbox", agentName: "support" } });

afterEach(() => vi.useRealTimers());

describe("runner MCP bootstrap", () => {
  it("rejects a config from a different agent lifetime before constructing ports", () => {
    const config = { runId: "run", agent: { name: "support" }, agentIdentity: { name: "support", incarnation: "replacement" } };
    expect(() => bindRunnerCapabilities(payload(), config)).toThrow(/^Runner capability bootstrap failed$/);
  });

  it("rejects an invocation substituting a different identity even with the same name", () => {
    const config = { runId: "run", agent: { name: "support" }, agentIdentity: { name: "support", incarnation: "original" },
      toolInvocation: { requestId: "request", runId: "run", surface: "task" as const, metadata: {}, agent: { name: "support", incarnation: "replacement" } } };
    expect(() => bindRunnerCapabilities(payload(), config)).toThrow(/^Runner capability bootstrap failed$/);
  });

  it("reads one bounded frame after readiness, does not wait for EOF and removes listeners", async () => {
    const stream = new PassThrough();
    const ready = vi.fn(() => {
      const encoded = JSON.stringify(payload());
      stream.write(encoded.slice(0, 25));
      stream.write(encoded.slice(25) + "\n");
    });
    const result = await readRunnerCapabilities(stream, ready);
    expect(result.mcp?.token).toBe("fixture-secret");
    expect(ready).toHaveBeenCalledOnce();
    expect(stream.readableEnded).toBe(false);
    expect(stream.isPaused()).toBe(true);
    expect(stream.listenerCount("data")).toBe(0);
    expect(stream.listenerCount("end")).toBe(0);
    expect(stream.listenerCount("error")).toBe(0);
    expect(process.env.POLPO_MCP_CAPABILITY).toBeUndefined();
  });

  it.each(["incomplete", "oversized", "duplicate", "malformed", "expired", "unexpected"]) ("rejects %s without echoing the payload", async scenario => {
    const stream = new PassThrough();
    const input = payload();
    if (scenario === "expired") input.mcp.expiresAt = "2000-01-01T00:00:00.000Z";
    const encoded = JSON.stringify(scenario === "unexpected" ? { ...input, headers: { secret: "do-not-print" } } : input);
    const work = readRunnerCapabilities(stream, () => {
      if (scenario === "incomplete") stream.end(encoded);
      else if (scenario === "oversized") stream.write("fixture-secret".repeat(2000));
      else if (scenario === "duplicate") stream.write(encoded + "\n" + encoded + "\n");
      else if (scenario === "malformed") stream.write("fixture-secret\n");
      else stream.write(encoded + "\n");
    });
    await expect(work).rejects.toThrow(/^Runner capability bootstrap failed$/);
    expect(stream.listenerCount("data")).toBe(0);
  });

  it("times out and removes its listeners while an input writer stays open", async () => {
    vi.useFakeTimers();
    const stream = new PassThrough();
    const work = readRunnerCapabilities(stream, () => {});
    const check = expect(work).rejects.toThrow(/^Runner capability bootstrap failed$/);
    await vi.advanceTimersByTimeAsync(30_001);
    await check;
    expect(stream.listenerCount("data")).toBe(0);
  });

  it("binds to the actual config agent and run without storing the bearer in config", async () => {
    const stream = new PassThrough();
    const binding = await readRunnerCapabilities(stream, () => stream.write(JSON.stringify(payload()) + "\n"));
    const config = { runId: "run", agent: { name: "support" }, agentIdentity: { name: "support", incarnation: "original" } };
    expect(typeof bindRunnerCapabilities(binding, config).resolveMcpCapabilities).toBe("function");
    expect(JSON.stringify(config)).not.toContain("fixture-secret");
    expect(() => bindRunnerCapabilities(binding, { ...config, runId: "other" })).toThrow();
    expect(() => bindRunnerCapabilities(binding, { ...config, agent: { name: "other" } })).toThrow();
  });
});


describe("combined runner capabilities", () => {
  const config = { runId: "run", agent: { name: "support" }, agentIdentity: { name: "support", incarnation: "original" } };
  it("binds MCP and Data together without modifying environment or config", async () => {
    const input = payload();
    const before = process.env.POLPO_DATA_CAPABILITY;
    const ports = bindRunnerCapabilities(input, config);
    expect(typeof ports.resolveMcpCapabilities).toBe("function");
    expect(typeof ports.data?.list).toBe("function");
    expect(process.env.POLPO_DATA_CAPABILITY).toBe(before);
    expect(JSON.stringify(config)).not.toContain("secret");
  });
  it("explicitly disables implicit Data fallback when the frame only grants MCP", () => {
    const { data: _, ...input } = payload();
    expect(bindRunnerCapabilities(input, config).data).toBeNull();
  });
  it("supports a Data-only runner", () => {
    const { mcp: _, ...input } = payload();
    const ports = bindRunnerCapabilities(input, config);
    expect(ports.resolveMcpCapabilities).toBeUndefined();
    expect(typeof ports.data?.list).toBe("function");
  });
  it.each(["data-agent", "data-sandbox", "mcp-agent", "mcp-run", "mcp-sandbox", "http", "credentials", "query", "empty", "mcp-lifetime", "missing-identity", "old-protocol"])("rejects the entire frame for %s", scenario => {
    const input: any = payload();
    if (scenario === "data-agent") input.data.agentName = "other";
    if (scenario === "data-sandbox") input.data.sandboxId = "other";
    if (scenario === "mcp-agent") input.mcp.agentName = "other";
    if (scenario === "mcp-run") input.mcp.runId = "other";
    if (scenario === "mcp-sandbox") input.mcp.sandboxId = "other";
    if (scenario === "http") input.data.url = "http://example.test/data";
    if (scenario === "credentials") input.mcp.url = "https://secret@example.test/mcp";
    if (scenario === "query") input.data.url += "?secret=value";
    if (scenario === "empty") { delete input.mcp; delete input.data; }
    if (scenario === "mcp-lifetime") input.mcp.agentIdentity.incarnation = "replacement";
    if (scenario === "missing-identity") delete input.agentIdentity;
    if (scenario === "old-protocol") input.version = 1;
    expect(() => bindRunnerCapabilities(input, config)).toThrow(/^Runner capability bootstrap failed$/);
  });
});
