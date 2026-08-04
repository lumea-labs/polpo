import { describe, it, expect } from "vitest";
import { resolveExecutionMode } from "../execution-mode.js";
import { resolveRuntimeSandboxOptions } from "../runtime-sandbox.js";

describe("resolveExecutionMode — adaptive isolation precedence", () => {
  it("defaults to subprocess with nothing set", () => {
    expect(resolveExecutionMode()).toBe("subprocess");
    expect(resolveExecutionMode({}, {}, {})).toBe("subprocess");
  });

  it("settings tier applies when task and agent are silent", () => {
    expect(resolveExecutionMode({}, {}, { taskExecution: "in-process" })).toBe("in-process");
  });

  it("agent beats settings", () => {
    expect(resolveExecutionMode({}, { executionMode: "subprocess" }, { taskExecution: "in-process" })).toBe("subprocess");
    expect(resolveExecutionMode({}, { executionMode: "in-process" }, { taskExecution: "subprocess" })).toBe("in-process");
  });

  it("task beats agent and settings", () => {
    expect(
      resolveExecutionMode(
        { executionMode: "in-process" },
        { executionMode: "subprocess" },
        { taskExecution: "subprocess" },
      ),
    ).toBe("in-process");
    expect(
      resolveExecutionMode(
        { executionMode: "subprocess" },
        { executionMode: "in-process" },
        { taskExecution: "in-process" },
      ),
    ).toBe("subprocess");
  });

  it("invalid values fall through to the next tier", () => {
    expect(resolveExecutionMode({ executionMode: "warp-drive" }, { executionMode: "in-process" })).toBe("in-process");
    expect(resolveExecutionMode({ executionMode: "" }, {}, { taskExecution: "in-process" })).toBe("in-process");
    expect(resolveExecutionMode({ executionMode: "warp" }, { executionMode: "nope" }, { taskExecution: "bad" })).toBe("subprocess");
  });
});

describe("resolveRuntimeSandboxOptions — runtime sandbox precedence", () => {
  it("returns undefined when no valid policy is set", () => {
    expect(resolveRuntimeSandboxOptions()).toBeUndefined();
    expect(resolveRuntimeSandboxOptions({}, {}, {})).toBeUndefined();
    expect(resolveRuntimeSandboxOptions({}, {}, { sandbox: { isolation: "bad" as any } })).toBeUndefined();
    class SandboxPolicy {
      isolation = "fresh" as const;
    }
    expect(resolveRuntimeSandboxOptions(
      undefined,
      undefined,
      { sandbox: new SandboxPolicy() },
    )).toBeUndefined();
  });

  it("settings, agent, and request merge with request winning", () => {
    expect(resolveRuntimeSandboxOptions(
      { sandbox: { isolation: "reuse" } },
      undefined,
      undefined,
    )).toEqual({ isolation: "reuse" });

    expect(resolveRuntimeSandboxOptions(
      { sandbox: { isolation: "reuse" } },
      { sandbox: { isolation: "fresh" } },
      undefined,
    )).toEqual({ isolation: "fresh" });

    expect(resolveRuntimeSandboxOptions(
      {
        sandbox: {
          isolation: "fresh",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
        },
      },
      { sandbox: { isolation: "fresh" } },
      { sandbox: { isolation: "reuse" } },
    )).toEqual({
      isolation: "reuse",
      lifecycle: { onRelease: "pool", idleTtlMinutes: 30 },
    });
  });

  it("invalid upper tiers fall through to lower valid policy", () => {
    expect(resolveRuntimeSandboxOptions(
      { sandbox: { isolation: "reuse" } },
      { sandbox: { isolation: "invalid" as any } },
      undefined,
    )).toEqual({ isolation: "reuse" });
  });

  it("merges lifecycle fields independently across precedence tiers", () => {
    expect(resolveRuntimeSandboxOptions(
      {
        sandbox: {
          isolation: "reuse",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 45 },
        },
      },
      { sandbox: { isolation: "fresh" } },
      { sandbox: { lifecycle: { onRelease: "pool" } } },
    )).toEqual({
      isolation: "fresh",
      lifecycle: { onRelease: "pool", idleTtlMinutes: 45 },
    });
  });

  it("clears an inherited pool TTL when a higher tier requests destroy", () => {
    expect(resolveRuntimeSandboxOptions(
      {
        sandbox: {
          lifecycle: { onRelease: "pool", idleTtlMinutes: 60 },
        },
      },
      { sandbox: { lifecycle: { onRelease: "destroy" } } },
    )).toEqual({ lifecycle: { onRelease: "destroy" } });
  });

  it("ignores malformed lifecycle fields without weakening valid lower tiers", () => {
    expect(resolveRuntimeSandboxOptions(
      {
        sandbox: {
          isolation: "reuse",
          lifecycle: { onRelease: "pool", idleTtlMinutes: 15 },
        },
      },
      {
        sandbox: {
          lifecycle: {
            onRelease: "archive" as any,
            idleTtlMinutes: 0,
          },
        },
      },
    )).toEqual({
      isolation: "reuse",
      lifecycle: { onRelease: "pool", idleTtlMinutes: 15 },
    });
  });
});
