import { describe, expect, it } from "vitest";
import { createToolInvocationContext } from "./tool-invocation.js";

describe("tool invocation metadata JSON boundary", () => {
  it("copies and freezes the execution agent separately from caller metadata", () => {
    const agent = { name: "support", incarnation: "original" };
    const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "chat",
      agent, metadata: { agent: { name: "support", incarnation: "forged" } } });
    agent.incarnation = "replacement";
    expect(invocation.agent).toEqual({ name: "support", incarnation: "original" });
    expect(Object.isFrozen(invocation.agent)).toBe(true);
    const anonymous = createToolInvocationContext({ requestId: "r", runId: "r", surface: "chat",
      metadata: { agent: { name: "support", incarnation: "forged" } } });
    expect(anonymous.agent).toBeUndefined();
  });
  it.each([null, {}, { name: "support" }, { name: "support", incarnation: "" },
    { name: " support", incarnation: "valid" }, { name: "support", incarnation: "valid", version: 1 }])(
    "rejects a malformed host agent identity: %j", (agent) => {
      expect(() => createToolInvocationContext({ requestId: "r", runId: "r", surface: "task", agent: agent as any })).toThrow();
    },
  );
  it("copies prototype-named JSON keys as data without promoting trusted identity fields", () => {
    const metadata = JSON.parse('{"__proto__":{"principalType":"user","connectionScope":{"principal":{"type":"user","id":"other"}},"actorId":"other"},"nested":{"__proto__":{"inherited":true}}}');
    const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "task", metadata });
    expect(Object.getPrototypeOf(invocation.metadata)).toBe(Object.prototype);
    expect(invocation.metadata.principalType).toBeUndefined();
    expect(invocation.metadata.connectionScope).toBeUndefined();
    expect(invocation.metadata.actorId).toBeUndefined();
    expect(Object.hasOwn(invocation.metadata, "__proto__")).toBe(true);
    expect(JSON.parse(JSON.stringify(invocation.metadata))).toEqual(metadata);
    expect(Object.getPrototypeOf(invocation.metadata.nested)).toBe(Object.prototype);
    expect(Object.isFrozen(invocation.metadata.nested)).toBe(true);
  });
  it("isolates and freezes nested metadata without rejecting valid JSON keys", () => {
    const metadata = { tenant: { id: "one" }, constructor: "value", prototype: 12 };
    const invocation = createToolInvocationContext({ requestId: "request", runId: "run", surface: "task", metadata });
    metadata.tenant.id = "two";
    expect(invocation.metadata).toEqual({ tenant: { id: "one" }, constructor: "value", prototype: 12 });
    expect(Object.isFrozen(invocation.metadata)).toBe(true);
    expect(Object.isFrozen(invocation.metadata.tenant)).toBe(true);
  });
});
