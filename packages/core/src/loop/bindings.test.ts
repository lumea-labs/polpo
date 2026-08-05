import { describe, expect, it } from "vitest";
import {
  LoopContextBindingError,
  resolveLoopInputBindings,
} from "./bindings.js";

describe("resolveLoopInputBindings", () => {
  const context = {
    request: {
      metadata: {
        projectRef: "project-123",
        empty: "",
      },
    },
    prior: {
      count: 0,
      approved: false,
      nullable: null,
      files: [{ path: "/tmp/app" }],
    },
  };

  it("resolves exact context markers recursively without changing static values", () => {
    expect(resolveLoopInputBindings({
      projectRef: { $context: "request.metadata.projectRef" },
      createIfMissing: true,
      nested: [{ count: { $context: "prior.count" } }],
    }, context)).toEqual({
      projectRef: "project-123",
      createIfMissing: true,
      nested: [{ count: 0 }],
    });
  });

  it.each([
    ["prior.approved", false],
    ["prior.count", 0],
    ["request.metadata.empty", ""],
    ["prior.nullable", null],
    ["prior.files.0.path", "/tmp/app"],
  ])("distinguishes an existing falsy value at %s from a missing path", (path, value) => {
    expect(resolveLoopInputBindings({ $context: path }, context)).toBe(value);
  });

  it("returns a detached JSON value so tool mutation cannot change context", () => {
    const resolved = resolveLoopInputBindings(
      { files: { $context: "prior.files" } },
      context,
    ) as { files: Array<{ path: string }> };

    resolved.files[0]!.path = "/tmp/changed";
    expect(context.prior.files[0]!.path).toBe("/tmp/app");
  });

  it("fails deterministically when a context path is missing", () => {
    expect(() => resolveLoopInputBindings(
      { projectRef: { $context: "request.metadata.missing" } },
      context,
    )).toThrowError(expect.objectContaining<Partial<LoopContextBindingError>>({
      code: "loop_binding_missing",
      contextPath: "request.metadata.missing",
      inputPath: "$.projectRef",
    }));
  });

  it.each([
    [{ $context: "" }, "empty"],
    [{ $context: 42 }, "string"],
    [{ $context: "request.metadata.projectRef", extra: true }, "only"],
    [{ $context: "request.__proto__.value" }, "unsafe"],
    [{ $context: "request..metadata" }, "empty segment"],
  ])("rejects malformed binding marker %#", (input, message) => {
    expect(() => resolveLoopInputBindings(input, context)).toThrowError(
      expect.objectContaining<Partial<LoopContextBindingError>>({
        code: "loop_binding_invalid",
      }),
    );
    expect(() => resolveLoopInputBindings(input, context)).toThrow(message);
  });

  it("rejects circular static input deterministically", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(() => resolveLoopInputBindings(input, context)).toThrowError(
      expect.objectContaining<Partial<LoopContextBindingError>>({
        code: "loop_binding_invalid",
      }),
    );
  });

  it("copies prototype-like object keys without mutating object prototypes", () => {
    const metadata = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(metadata, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    const resolved = resolveLoopInputBindings(
      { metadata: { $context: "payload" } },
      { payload: metadata },
    ) as { metadata: Record<string, unknown> };

    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(Object.hasOwn(resolved.metadata, "__proto__")).toBe(true);
    expect(resolved.metadata.__proto__).toEqual({ polluted: true });
  });

  it("rejects non-JSON values resolved from context", () => {
    expect(() => resolveLoopInputBindings(
      { value: { $context: "payload" } },
      { payload: Number.POSITIVE_INFINITY },
    )).toThrowError(expect.objectContaining<Partial<LoopContextBindingError>>({
      code: "loop_binding_invalid",
    }));
  });

  it("rejects accessors without invoking them", () => {
    let reads = 0;
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "secret", {
      enumerable: true,
      get() {
        reads += 1;
        return "leaked";
      },
    });

    expect(() => resolveLoopInputBindings(
      { value: { $context: "payload" } },
      { payload },
    )).toThrowError(expect.objectContaining<Partial<LoopContextBindingError>>({
      code: "loop_binding_invalid",
    }));
    expect(reads).toBe(0);
  });

  it("rejects sparse arrays instead of silently changing their JSON shape", () => {
    const payload = new Array(2);
    payload[1] = "value";
    expect(() => resolveLoopInputBindings(
      { value: { $context: "payload" } },
      { payload },
    )).toThrowError(expect.objectContaining<Partial<LoopContextBindingError>>({
      code: "loop_binding_invalid",
    }));
  });
});
