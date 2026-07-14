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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  type CustomTool,
  type CustomToolContext,
} from "../custom-tools.js";

/** Minimal ctx — bindCustomTool only passes it through, so stubs suffice. */
function fakeCtx(overrides: Partial<CustomToolContext> = {}): Omit<CustomToolContext, "signal" | "onUpdate"> {
  return {
    fs: { marker: "fs" } as any,
    shell: { marker: "shell" } as any,
    vault: { marker: "vault" } as any,
    env: { FOO: "bar" },
    workDir: "/work",
    polpo: { marker: "polpo" },
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

  it("injects the full ctx (fs/shell/vault/env/workDir/polpo) plus signal & onUpdate", async () => {
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
    expect(received.vault).toEqual({ marker: "vault" });
    expect(received.env).toEqual({ FOO: "bar" });
    expect(received.workDir).toBe("/work");
    expect(received.polpo).toEqual({ marker: "polpo" });
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
