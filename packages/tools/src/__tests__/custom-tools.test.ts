/**
 * Phase 1 of defineTool — the pure-logic foundation (no sandbox, no API):
 *   - defineTool()           authoring helper → CustomTool + __custom marker
 *   - getCustomToolErrors()  shape/name validation (reused by the cloud API)
 *   - isCustomTool()         type guard
 *   - normalizeToolResult()  string | ToolResult → ToolResult
 *   - bindCustomTool()       wrap a CustomTool into a runtime PolpoTool (ctx injection)
 *   - extractCustomTool()    find the tool in a (bundled) module's exports
 *   - loadCustomToolBundle() import a bundle file + bind → PolpoTool (self-host path)
 *
 * Test-first: these encode the contract before the implementation exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Type } from "@sinclair/typebox";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defineTool,
  getCustomToolErrors,
  isCustomTool,
  normalizeToolResult,
  bindCustomTool,
  extractCustomTool,
  loadCustomToolBundle,
  createJsonSchemaExample,
  createToolInvocationContext,
  emptyCustomToolConnections,
  CustomToolBindingError,
  CustomToolTimeoutError,
  MAX_CUSTOM_TOOL_TIMEOUT_MS,
  MIN_CUSTOM_TOOL_TIMEOUT_MS,
  type CustomTool,
  type CustomToolContext,
} from "../custom-tools.js";

/** Minimal ctx — bindCustomTool only passes it through, so stubs suffice. */
function fakeCtx(overrides: Partial<CustomToolContext> = {}): Omit<CustomToolContext, "signal" | "onUpdate"> {
  return {
    fs: { marker: "fs" } as any,
    shell: { marker: "shell" } as any,
    connections: emptyCustomToolConnections(),
    env: { FOO: "bar" },
    workDir: "/work",
    polpo: { marker: "polpo" },
    invocation: createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      sessionId: "session-1",
      surface: "chat",
      user: "user-1",
      metadata: { tenantId: "tenant-1" },
    }),
    bindings: Object.freeze({}),
    ...overrides,
  };
}

const EchoSchema = Type.Object({ msg: Type.String() });

describe("createJsonSchemaExample", () => {
  it("creates deterministic nested arguments from TypeBox schemas", () => {
    const schema = Type.Object({
      email: Type.String({ format: "email" }),
      amount: Type.Number(),
      enabled: Type.Boolean(),
      tags: Type.Array(Type.String()),
      mode: Type.Union([Type.Literal("fast"), Type.Literal("safe")]),
    });
    expect(createJsonSchemaExample(schema)).toEqual({
      email: "user@example.com",
      amount: 99.99,
      enabled: true,
      tags: ["text"],
      mode: "fast",
    });
  });
});

describe("defineTool", () => {
  it("returns the spec with the __custom marker", () => {
    const tool = defineTool({
      name: "echo",
      description: "Echoes input",
      parameters: EchoSchema,
      execute: (_ctx, params) => `echo: ${params.msg}`,
    });
    expect(tool.__custom).toBe(true);
    expect(tool.name).toBe("echo");
    expect(tool.description).toBe("Echoes input");
    expect(tool.parameters).toBe(EchoSchema);
    expect(typeof tool.execute).toBe("function");
  });

  it("preserves optional label and clientSide", () => {
    const tool = defineTool({
      name: "echo",
      label: "Echo Machine",
      clientSide: true,
      description: "d",
      parameters: EchoSchema,
      execute: () => "ok",
    });
    expect(tool.label).toBe("Echo Machine");
    expect(tool.clientSide).toBe(true);
  });

  it("preserves an execution timeout without exposing it in model parameters", () => {
    const tool = defineTool({
      name: "slow_echo",
      description: "Echoes after external work",
      parameters: EchoSchema,
      timeoutMs: 15_000,
      execute: () => "ok",
    });

    expect(tool.timeoutMs).toBe(15_000);
    expect((tool.parameters as any).properties).toEqual({ msg: Type.String() });
  });

  it("preserves hidden binding declarations without adding them to model parameters", () => {
    const bindingsSchema = Type.Object({ tenantId: Type.String() });
    const tool = defineTool({
      name: "tenant_echo",
      description: "Echoes within one tenant",
      parameters: EchoSchema,
      bindingsSchema,
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
      },
      execute: (_ctx, params) => params.msg,
    });
    expect(tool.parameters).toBe(EchoSchema);
    expect(tool.bindingsSchema).toBe(bindingsSchema);
    expect(tool.serverBindings).toEqual({
      tenantId: { $context: "invocation.metadata.tenantId" },
    });
    expect((tool.parameters as any).properties).toEqual({ msg: Type.String() });
  });
});

describe("getCustomToolErrors / isCustomTool", () => {
  const valid = defineTool({
    name: "do_thing",
    description: "Does a thing",
    parameters: EchoSchema,
    execute: () => "ok",
  });

  it("accepts a valid tool", () => {
    expect(getCustomToolErrors(valid)).toEqual([]);
    expect(isCustomTool(valid)).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(getCustomToolErrors(null).length).toBeGreaterThan(0);
    expect(getCustomToolErrors("nope").length).toBeGreaterThan(0);
    expect(isCustomTool(null)).toBe(false);
  });

  it("requires a name", () => {
    expect(getCustomToolErrors({ ...valid, name: "" }).join()).toMatch(/name/i);
  });

  it("enforces snake_case names", () => {
    for (const bad of ["Echo", "my tool", "1tool", "my-tool", "MY_TOOL"]) {
      expect(getCustomToolErrors({ ...valid, name: bad }).join()).toMatch(/snake_case|name/i);
    }
    for (const ok of ["echo", "do_thing", "get_user_v2", "a1_b2"]) {
      expect(getCustomToolErrors({ ...valid, name: ok })).toEqual([]);
    }
  });

  it("requires description, parameters and execute", () => {
    expect(getCustomToolErrors({ ...valid, description: "  " }).join()).toMatch(/description/i);
    expect(getCustomToolErrors({ ...valid, parameters: undefined }).join()).toMatch(/parameters/i);
    expect(getCustomToolErrors({ ...valid, execute: "x" }).join()).toMatch(/execute/i);
  });

  it("validates optional field types", () => {
    expect(getCustomToolErrors({ ...valid, label: 5 }).join()).toMatch(/label/i);
    expect(getCustomToolErrors({ ...valid, clientSide: "yes" }).join()).toMatch(/clientSide/i);
  });

  it("rejects custom-tool timeouts outside the supported integer range", () => {
    for (const timeoutMs of [
      0,
      MIN_CUSTOM_TOOL_TIMEOUT_MS - 1,
      MAX_CUSTOM_TOOL_TIMEOUT_MS + 1,
      1_500.5,
      Number.NaN,
      "15000",
    ]) {
      expect(getCustomToolErrors({ ...valid, timeoutMs }).join()).toMatch(/timeoutMs/i);
    }
    expect(getCustomToolErrors({ ...valid, timeoutMs: MIN_CUSTOM_TOOL_TIMEOUT_MS })).toEqual([]);
    expect(getCustomToolErrors({ ...valid, timeoutMs: MAX_CUSTOM_TOOL_TIMEOUT_MS })).toEqual([]);
  });

  it("requires binding schema and mappings together", () => {
    const bindingsSchema = Type.Object({ tenantId: Type.String() });
    expect(getCustomToolErrors({ ...valid, bindingsSchema }).join()).toMatch(/serverBindings/i);
    expect(getCustomToolErrors({
      ...valid,
      serverBindings: { tenantId: { $context: "invocation.metadata.tenantId" } },
    }).join()).toMatch(/bindingsSchema/i);
  });

  it("rejects unsafe or unknown server binding paths", () => {
    const bindingsSchema = Type.Object({ tenantId: Type.String() });
    for (const path of [
      "request.metadata.tenantId",
      "invocation.__proto__.polluted",
      "invocation.metadata.constructor.prototype",
      "invocation.scope",
      "invocation.scope.unknown",
      "invocation.scope.key.extra",
      "invocation.secrets.apiKey",
    ]) {
      expect(getCustomToolErrors({
        ...valid,
        bindingsSchema,
        serverBindings: { tenantId: { $context: path } },
      }).join()).toMatch(/binding|context|path/i);
    }
  });

  it("rejects bindings that do not match the declared hidden schema", () => {
    const bindingsSchema = Type.Object({
      tenantId: Type.String(),
      grant: Type.String(),
    });
    expect(getCustomToolErrors({
      ...valid,
      bindingsSchema,
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
      },
    })).toContainEqual(expect.stringMatching(/grant.*mapping/i));
    expect(getCustomToolErrors({
      ...valid,
      bindingsSchema,
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
        grant: { $context: "invocation.metadata.grant" },
        undeclared: { $context: "invocation.metadata.siteId" },
      },
    })).toContainEqual(expect.stringMatching(/undeclared.*bindingsSchema/i));
  });

  it("isCustomTool requires the __custom marker", () => {
    const { __custom, ...withoutMarker } = valid as any;
    expect(isCustomTool(withoutMarker)).toBe(false);
  });
});

describe("normalizeToolResult", () => {
  it("wraps a plain string into a text ToolResult", () => {
    expect(normalizeToolResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
      details: null,
    });
  });

  it("passes a well-formed ToolResult through unchanged", () => {
    const r = { content: [{ type: "text" as const, text: "x" }], details: { a: 1 } };
    expect(normalizeToolResult(r)).toBe(r);
  });

  it("stringifies unexpected return values as a fallback", () => {
    const out = normalizeToolResult({ foo: 1 } as any);
    expect(out.content[0]).toEqual({ type: "text", text: JSON.stringify({ foo: 1 }) });
  });
});

describe("bindCustomTool", () => {
  let tool: CustomTool<typeof EchoSchema>;
  beforeEach(() => {
    tool = defineTool({
      name: "echo",
      description: "Echoes input",
      parameters: EchoSchema,
      execute: (_ctx, params) => `echo: ${params.msg}`,
    });
  });

  it("produces a PolpoTool with name/label/description/parameters", () => {
    const pt = bindCustomTool(tool, fakeCtx());
    expect(pt.name).toBe("echo");
    expect(pt.label).toBe("echo"); // defaults to name
    expect(pt.description).toBe("Echoes input");
    expect(pt.parameters).toBe(EchoSchema);
    expect(typeof pt.execute).toBe("function");
  });

  it("defaults label to name, honors explicit label", () => {
    expect(bindCustomTool(tool, fakeCtx()).label).toBe("echo");
    const labeled = bindCustomTool({ ...tool, label: "Echo!" }, fakeCtx());
    expect(labeled.label).toBe("Echo!");
  });

  it("runs execute with the injected ctx and normalizes a string result", async () => {
    const pt = bindCustomTool(tool, fakeCtx());
    const res = await pt.execute("call-1", { msg: "hi" });
    expect(res).toEqual({ content: [{ type: "text", text: "echo: hi" }], details: null });
  });

  it("injects the full ctx (fs/shell/connections/env/workDir/polpo) plus signal & onUpdate", async () => {
    let received: any;
    const t = defineTool({
      name: "spy",
      description: "captures ctx",
      parameters: EchoSchema,
      execute: (ctx) => {
        received = ctx;
        return "ok";
      },
    });
    const ctrl = new AbortController();
    const onUpdate = () => {};
    const pt = bindCustomTool(t, fakeCtx());
    await pt.execute("c", { msg: "x" }, ctrl.signal, onUpdate);
    expect(received.fs).toEqual({ marker: "fs" });
    expect(received.shell).toEqual({ marker: "shell" });
    expect(received.connections.has("github")).toBe(false);
    expect(received.connections.getToken("github")).toBeUndefined();
    expect(received.env).toEqual({ FOO: "bar" });
    expect(received.workDir).toBe("/work");
    expect(received.polpo).toEqual({ marker: "polpo" });
    expect(received.invocation).toMatchObject({
      requestId: "request-1",
      runId: "run-1",
      sessionId: "session-1",
      surface: "chat",
      user: "user-1",
      metadata: { tenantId: "tenant-1" },
    });
    expect(received.bindings).toEqual({});
    expect(received.signal).toBe(ctrl.signal);
    expect(received.onUpdate).toBe(onUpdate);
  });

  it("passes a ToolResult return value through unchanged", async () => {
    const t = defineTool({
      name: "rich",
      description: "rich result",
      parameters: EchoSchema,
      execute: () => ({ content: [{ type: "text" as const, text: "rich" }], details: { ok: true } }),
    });
    const res = await bindCustomTool(t, fakeCtx()).execute("c", { msg: "x" });
    expect(res.details).toEqual({ ok: true });
  });

  it("propagates errors thrown inside execute", async () => {
    const t = defineTool({
      name: "boom",
      description: "throws",
      parameters: EchoSchema,
      execute: () => {
        throw new Error("kaboom");
      },
    });
    await expect(bindCustomTool(t, fakeCtx()).execute("c", { msg: "x" })).rejects.toThrow("kaboom");
  });

  it("aborts and rejects deterministically when a configured timeout expires", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const t = defineTool({
        name: "slow_tool",
        description: "Never completes",
        parameters: EchoSchema,
        timeoutMs: MIN_CUSTOM_TOOL_TIMEOUT_MS,
        execute: (ctx) => {
          receivedSignal = ctx.signal;
          return new Promise(() => {});
        },
      });
      const execution = bindCustomTool(t, fakeCtx()).execute("c", { msg: "x" });
      const rejection = expect(execution).rejects.toMatchObject({
        name: "CustomToolTimeoutError",
        code: "custom_tool_timeout",
        timeoutMs: MIN_CUSTOM_TOOL_TIMEOUT_MS,
      });

      await vi.advanceTimersByTimeAsync(MIN_CUSTOM_TOOL_TIMEOUT_MS);
      await rejection;
      expect(receivedSignal?.aborted).toBe(true);
      expect(receivedSignal?.reason).toBeInstanceOf(CustomToolTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves and validates hidden bindings immediately before execution", async () => {
    let received: any;
    const t = defineTool({
      name: "tenant_echo",
      description: "Echoes within one tenant",
      parameters: EchoSchema,
      bindingsSchema: Type.Object({
        tenantId: Type.String(),
        externalUserId: Type.String(),
        grant: Type.String(),
        scopeKey: Type.String(),
      }),
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
        externalUserId: { $context: "invocation.user" },
        grant: { $context: "invocation.metadata.grant" },
        scopeKey: { $context: "invocation.scope.key" },
      },
      execute: (ctx, params) => {
        received = { bindings: ctx.bindings, invocation: ctx.invocation, params };
        return "ok";
      },
    });
    const invocation = createToolInvocationContext({
      requestId: "request-2",
      runId: "run-2",
      sessionId: "session-2",
      surface: "channel",
      user: "better-auth-user",
      metadata: {
        tenantId: "tenant-2",
        grant: "ag1.signed",
      },
      scope: { key: "workspace-2", version: "4" },
    });
    const pt = bindCustomTool(t, fakeCtx({ invocation }));
    await pt.execute("call-2", { msg: "hello" });

    expect(received.bindings).toEqual({
      tenantId: "tenant-2",
      externalUserId: "better-auth-user",
      grant: "ag1.signed",
      scopeKey: "workspace-2",
    });
    expect(received.params).toEqual({ msg: "hello" });
    expect(Object.isFrozen(received.bindings)).toBe(true);
    expect(Object.isFrozen(received.invocation)).toBe(true);
    expect(Object.isFrozen(received.invocation.metadata)).toBe(true);
  });

  it("does not let model arguments override a same-named hidden binding", async () => {
    let received: unknown;
    const t = defineTool({
      name: "tenant_echo",
      description: "Echoes within one tenant",
      parameters: Type.Object({ tenantId: Type.String() }),
      bindingsSchema: Type.Object({ tenantId: Type.String() }),
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
      },
      execute: (ctx, params) => {
        received = { hidden: ctx.bindings.tenantId, model: params.tenantId };
        return "ok";
      },
    });
    await bindCustomTool(t, fakeCtx()).execute("call-shadow", {
      tenantId: "attacker-controlled",
    });
    expect(received).toEqual({
      hidden: "tenant-1",
      model: "attacker-controlled",
    });
  });

  it("validates standard JSON Schema formats used by trusted bindings", async () => {
    let received: any;
    const t = defineTool({
      name: "site_context_get",
      description: "Reads one site context",
      parameters: Type.Object({}, { additionalProperties: false }),
      bindingsSchema: Type.Object({
        siteId: Type.String({ format: "uuid" }),
        grant: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      serverBindings: {
        siteId: { $context: "invocation.metadata.siteId" },
        grant: { $context: "invocation.metadata.grant" },
      },
      execute: (ctx) => {
        received = ctx.bindings;
        return "ok";
      },
    });
    const invocation = createToolInvocationContext({
      requestId: "request-uuid",
      runId: "run-uuid",
      surface: "channel",
      metadata: {
        siteId: "f35f696f-2ea3-4dda-b3c0-7c1ab8ab114d",
        grant: "ag1.signed",
      },
    });

    await bindCustomTool(t, fakeCtx({ invocation })).execute("call-uuid", {});
    expect(received).toEqual({
      siteId: "f35f696f-2ea3-4dda-b3c0-7c1ab8ab114d",
      grant: "ag1.signed",
    });
  });

  it("fails closed when a required hidden binding is missing", async () => {
    const t = defineTool({
      name: "tenant_echo",
      description: "Echoes within one tenant",
      parameters: EchoSchema,
      bindingsSchema: Type.Object({ tenantId: Type.String() }),
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
      },
      execute: () => "should not run",
    });
    const invocation = createToolInvocationContext({
      requestId: "request-3",
      runId: "run-3",
      surface: "chat",
      metadata: {},
    });
    const promise = bindCustomTool(t, fakeCtx({ invocation })).execute("call-3", { msg: "hello" });
    await expect(promise).rejects.toMatchObject({
      code: "custom_tool_binding_missing",
      name: "CustomToolBindingError",
    });
  });

  it("fails closed when a hidden binding has the wrong type", async () => {
    const t = defineTool({
      name: "tenant_echo",
      description: "Echoes within one tenant",
      parameters: EchoSchema,
      bindingsSchema: Type.Object({ tenantId: Type.String() }),
      serverBindings: {
        tenantId: { $context: "invocation.metadata.tenantId" },
      },
      execute: () => "should not run",
    });
    const invocation = createToolInvocationContext({
      requestId: "request-4",
      runId: "run-4",
      surface: "chat",
      metadata: { tenantId: 42 },
    });
    await expect(
      bindCustomTool(t, fakeCtx({ invocation })).execute("call-4", { msg: "hello" }),
    ).rejects.toBeInstanceOf(CustomToolBindingError);
    await expect(
      bindCustomTool(t, fakeCtx({ invocation })).execute("call-5", { msg: "hello" }),
    ).rejects.toMatchObject({ code: "custom_tool_binding_invalid" });
  });
});

describe("createToolInvocationContext", () => {
  it("copies and deeply freezes trusted JSON values", () => {
    const metadata = { tenant: { id: "tenant-1" }, scopes: ["read"] };
    const invocation = createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "task",
      metadata,
    });
    metadata.tenant.id = "tampered";
    metadata.scopes.push("write");
    expect(invocation.metadata).toEqual({
      tenant: { id: "tenant-1" },
      scopes: ["read"],
    });
    expect(Object.isFrozen(invocation.metadata)).toBe(true);
    expect(Object.isFrozen(invocation.metadata.tenant)).toBe(true);
    expect(Object.isFrozen(invocation.metadata.scopes)).toBe(true);
  });

  it("normalizes and freezes a trusted application scope", () => {
    const invocation = createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "channel",
      scope: { key: " workspace-1 ", version: " 3 " },
    });

    expect(invocation.scope).toEqual({ key: "workspace-1", version: "3" });
    expect(Object.isFrozen(invocation.scope)).toBe(true);
    expect(() => createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "channel",
      scope: { key: "" },
    })).toThrow(/scope key/i);
    expect(() => createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "channel",
      scope: { key: "workspace-1", extra: true } as any,
    })).toThrow(/unsupported fields/i);
  });

  it("rejects non-JSON metadata deterministically", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "chat",
      metadata: cyclic as any,
    })).toThrow(/JSON|cyclic/i);
  });

  it("rejects an unknown runtime surface even through untyped input", () => {
    expect(() => createToolInvocationContext({
      requestId: "request-1",
      runId: "run-1",
      surface: "unknown" as any,
    })).toThrow(/surface.*invalid/i);
  });
});

describe("extractCustomTool", () => {
  const tool = defineTool({
    name: "echo",
    description: "d",
    parameters: EchoSchema,
    execute: () => "ok",
  });

  it("finds a tool passed directly", () => {
    expect(extractCustomTool(tool)).toBe(tool);
  });

  it("finds a default export", () => {
    expect(extractCustomTool({ default: tool })).toBe(tool);
  });

  it("finds a nested default (esbuild interop)", () => {
    expect(extractCustomTool({ default: { default: tool } })).toBe(tool);
  });

  it("finds a named export", () => {
    expect(extractCustomTool({ myTool: tool })).toBe(tool);
  });

  it("throws a helpful error when no tool is present", () => {
    expect(() => extractCustomTool({ foo: 1 })).toThrow(/no custom tool|export default/i);
  });

  it("surfaces validation errors for a near-miss default export", () => {
    const broken = { __custom: true, name: "Bad Name", description: "d", parameters: EchoSchema, execute: () => "x" };
    expect(() => extractCustomTool({ default: broken })).toThrow(/snake_case|invalid/i);
  });
});

describe("loadCustomToolBundle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "polpo-tool-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("imports a bundle file, binds ctx, and runs", async () => {
    const file = join(dir, "echo.mjs");
    await writeFile(
      file,
      `export default {
        __custom: true,
        name: "echo",
        label: "Echo",
        description: "echoes",
        parameters: { type: "object", properties: { msg: { type: "string" } } },
        execute: async (ctx, params) => "echo: " + params.msg + " @ " + ctx.workDir,
      };`,
    );
    const pt = await loadCustomToolBundle(file, fakeCtx({ workDir: "/sandbox" }));
    expect(pt.name).toBe("echo");
    expect(pt.label).toBe("Echo");
    const res = await pt.execute("c", { msg: "hi" });
    expect(res.content[0]).toEqual({ type: "text", text: "echo: hi @ /sandbox" });
  });

  it("accepts an already-imported module object", async () => {
    const tool = defineTool({ name: "echo", description: "d", parameters: EchoSchema, execute: () => "ok" });
    const pt = await loadCustomToolBundle({ default: tool }, fakeCtx());
    expect(pt.name).toBe("echo");
    expect((await pt.execute("c", { msg: "x" })).content[0]).toEqual({ type: "text", text: "ok" });
  });

  it("rejects a bundle with no valid tool", async () => {
    const file = join(dir, "bad.mjs");
    await writeFile(file, `export const notATool = 42;`);
    await expect(loadCustomToolBundle(file, fakeCtx())).rejects.toThrow(/no custom tool|export default/i);
  });
});
