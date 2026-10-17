import { describe, expect, it } from "vitest";
import { RuntimeHookEngine, validateRuntimeHookPack } from "./runtime-hooks.js";
import { TerminationGate } from "./termination-gate.js";

const policy = { maxCycles: 2, maxDurationMs: 1000, maxTokens: 100 };
describe("termination gate", () => {
  it("preserves structured diagnostics and counts cycles across a serialized resume", () => {
    const gate = new TerminationGate(policy, undefined, () => 10);
    gate.beginAttempt();
    expect(gate.decide({ action: "continue", feedback: { failures: [{ file: "src/index.ts", line: 3 }] } }, 2)).toContain('"line":3');
    const restored = new TerminationGate(policy, JSON.parse(JSON.stringify(gate.snapshot())), () => 20);
    restored.beginAttempt();
    restored.decide({ action: "continue", feedback: "second" }, 3);
    restored.beginAttempt();
    expect(() => restored.decide({ action: "continue", feedback: "third" }, 4)).toThrow(/cycles/);
  });
  it("never accepts an unvalidated result when a budget is exhausted", () => {
    const gate = new TerminationGate(policy, undefined, () => 10);
    gate.beginAttempt();
    expect(() => gate.decide({ action: "continue", feedback: "repair" }, 0)).toThrow(/turns/);
    const tokens = new TerminationGate(policy, undefined, () => 10);
    tokens.recordUsage({ totalTokens: 100 });
    expect(() => tokens.assertAvailable()).toThrow(/tokens/);
    const elapsed = new TerminationGate(policy, { version: 1, cycles: 1, startedAt: 0, tokens: 3, attempts: 1, policy }, () => 1001);
    expect(() => elapsed.assertAvailable()).toThrow(/time/);
  });
  it("refuses corrupt checkpoints and policy changes that loosen a resumed budget", () => {
    expect(() => new TerminationGate(policy, { version: 1, cycles: -1 } as any)).toThrow();
    const gate = new TerminationGate(policy, undefined, () => 10);
    gate.recordUsage({ inputTokens: 30, outputTokens: 20 });
    expect(gate.snapshot().tokens).toBe(50);
  });
  it("requires all limits and only permits control turn:stop gates", () => {
    const hook = { id: "validate", event: "turn:stop", terminationGate: policy, handler: { type: "tool", tool: "validate" } };
    expect(validateRuntimeHookPack({ version: 1, name: "quality", hooks: [hook] }).hooks[0]).toMatchObject({ terminationGate: policy });
    for (const change of [{ event: "tool:after" }, { mode: "observe" }, { terminationGate: { maxCycles: 2 } }, { terminationGate: { ...policy, maxCycles: 0 } }]) {
      expect(() => validateRuntimeHookPack({ version: 1, name: "quality", hooks: [{ ...hook, ...change }] })).toThrow();
    }
  });
  it("resolves only matching gate policies and preserves continue on replay", async () => {
    const engine = new RuntimeHookEngine({
      definitions: [{ id: "validate", event: "turn:stop", terminationGate: policy, matcher: { steps: ["implement"] }, handler: { type: "tool", tool: "validate" } }],
      host: { execute: async () => ({ decision: { action: "continue", feedback: { errors: ["missing import"] } } }) },
    });
    expect(engine.getTerminationGatePolicy({ surface: "loop", identity: { step: "plan" } })).toBeUndefined();
    expect(engine.getTerminationGatePolicy({ surface: "loop", identity: { step: "implement" } })).toEqual(policy);
    expect((await engine.dispatch({ event: "turn:stop", surface: "loop", identity: { step: "implement" } })).decision).toMatchObject({ action: "continue" });
  });
});


describe("termination validator failures", () => {
  it.each([undefined, {}, { action: "continue" }, { action: "continue", feedback: null }, { action: "invented" }])("fails closed for malformed decision %j", async decision => {
    const engine = new RuntimeHookEngine({ definitions: [{ id: "gate", event: "turn:stop", terminationGate: policy, handler: { type: "tool", tool: "validate" } }], host: { execute: async () => ({ decision } as any) } });
    expect((await engine.dispatch({ surface: "chat", event: "turn:stop" })).decision.action).toBe("deny");
  });
  it("never downgrades a configured gate to fail-open on timeout or exception", async () => {
    for (const execute of [async () => { throw new Error("validator unavailable"); }, async () => await new Promise<never>(() => {})]) {
      const engine = new RuntimeHookEngine({ definitions: [{ id: "gate", event: "turn:stop", terminationGate: policy, onFailure: "continue", handler: { type: "tool", tool: "validate", timeoutMs: 5 } }], host: { execute } });
      expect((await engine.dispatch({ surface: "chat", event: "turn:stop" })).decision.action).toBe("deny");
    }
  });
  it("passes a deadline cancellation into the validator", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const engine = new RuntimeHookEngine({ definitions: [{ id: "gate", event: "turn:stop", terminationGate: policy, handler: { type: "tool", tool: "validate" } }], host: { execute: async request => {
      request.signal.addEventListener("abort", () => { cancelled = true; });
      controller.abort();
      return await new Promise<never>(() => {});
    } } });
    const result = await engine.dispatch({ surface: "chat", event: "turn:stop", signal: controller.signal });
    expect(cancelled).toBe(true);
    expect(result.decision.action).toBe("deny");
  });
  it("keeps the more restrictive policy when restoring state", () => {
    const gate = new TerminationGate(policy);
    const restored = new TerminationGate({ maxCycles: 20, maxDurationMs: 60_000, maxTokens: 5000 }, gate.snapshot());
    expect(restored.policy).toEqual(policy);
    expect(() => restored.recordUsage({})).toThrow(/usage/);
  });
});
