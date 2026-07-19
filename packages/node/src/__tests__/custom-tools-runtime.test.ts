import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import { createLocalCustomToolRuntime } from "../custom-tools/runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("LocalCustomToolRuntime", () => {
  it("compiles, validates, executes and filters project tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-custom-tools-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    await mkdir(polpoDir, { recursive: true });
    const runtime = createLocalCustomToolRuntime({
      polpoDir,
      workDir: root,
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
    });
    const source = `
      import { defineTool } from "@polpo-ai/tools";
      import { Type } from "@sinclair/typebox";
      export default defineTool({
        name: "echo_value",
        description: "Echo a value",
        parameters: Type.Object({ value: Type.String() }),
        async execute(_ctx, params) { return JSON.stringify({ echoed: params.value }); },
      });
    `;
    await runtime.store.putSource("echo_value", source);

    const deployed = await runtime.deploy("echo_value", source);
    expect(deployed.errors).toEqual([]);
    expect(deployed.meta).toMatchObject({ name: "echo_value", description: "Echo a value" });
    await runtime.store.putBundle("echo_value", deployed.bundle!);
    await runtime.store.putMeta("echo_value", deployed.meta!);

    const result = await runtime.run("echo_value", { value: "hello" }) as any;
    expect(result.content[0].text).toBe('{"echoed":"hello"}');
    expect(await runtime.generateExample("echo_value")).toEqual({ value: "text" });
    expect(await runtime.loadAssigned(["read"])).toEqual([]);
    expect((await runtime.loadAssigned(["echo_value"])).map((tool) => tool.name)).toEqual(["echo_value"]);
    expect((await runtime.loadAssigned(["*"])).map((tool) => tool.name)).toEqual(["echo_value"]);
  });

  it("rejects built-in collisions and mismatched exported names", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-custom-tools-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    await mkdir(polpoDir, { recursive: true });
    const runtime = createLocalCustomToolRuntime({
      polpoDir,
      workDir: root,
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
    });
    const source = (name: string) => `
      import { defineTool } from "@polpo-ai/tools";
      import { Type } from "@sinclair/typebox";
      export default defineTool({
        name: "${name}",
        description: "Test tool",
        parameters: Type.Object({}),
        async execute() { return "ok"; },
      });
    `;

    expect((await runtime.deploy("read", source("read"))).errors[0]).toMatch(/built-in/);
    expect((await runtime.deploy("expected_name", source("other_name"))).errors[0]).toMatch(
      /expected "expected_name"/,
    );
  });
});
