import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFileSystem } from "../adapters/node-filesystem.js";
import { NodeShell } from "../adapters/node-shell.js";
import { createLocalCustomToolRuntime } from "../custom-tools/runtime.js";
import {
  createToolInvocationContext,
  parseCustomToolSourceArtifact,
} from "@polpo-ai/tools";

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
        timeoutMs: 15000,
        async execute(_ctx, params) { return JSON.stringify({ echoed: params.value }); },
      });
    `;
    await runtime.store.putSource("echo_value", source);

    const deployed = await runtime.deploy("echo_value", source);
    expect(deployed.errors).toEqual([]);
    expect(deployed.meta).toMatchObject({
      name: "echo_value",
      description: "Echo a value",
      timeoutMs: 15000,
    });
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

  it("bundles and executes relative modules from a versioned source artifact", async () => {
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
    const artifact = parseCustomToolSourceArtifact({
      version: 1,
      entry: "site_context_get.ts",
      files: {
        "site_context_get.ts": `
          import { defineTool } from "@polpo-ai/tools";
          import { Type } from "@sinclair/typebox";
          import { formatSite } from "./_leo_platform";
          export default defineTool({
            name: "site_context_get",
            description: "Get trusted site context",
            parameters: Type.Object({ site: Type.String() }),
            async execute(_ctx, params) { return formatSite(params.site); },
          });
        `,
        "_leo_platform.ts": `
          export function formatSite(site: string) { return { site, trusted: true }; }
        `,
      },
    });
    await runtime.store.putArtifact("site_context_get", artifact);

    const deployed = await runtime.deployArtifact("site_context_get", artifact);
    expect(deployed.errors).toEqual([]);
    expect(deployed.meta).toMatchObject({ name: "site_context_get" });
    const result = await runtime.run("site_context_get", { site: "site-1" }) as any;
    expect(JSON.parse(result.content[0].text)).toEqual({ site: "site-1", trusted: true });
  });

  it("deploys slot metadata and resolves a fresh capability for every invocation", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-custom-tools-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    await mkdir(polpoDir, { recursive: true });
    const calls: string[] = [];
    const runtime = createLocalCustomToolRuntime({
      polpoDir,
      workDir: root,
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
      connectionCapabilityResolver: {
        async resolve(input) {
          calls.push(`${input.invocation.user}:${input.toolCallId}`);
          return {
            providerId: "sitoinchat",
            scopes: ["site:read"],
            getToken: () => `token:${input.invocation.user}`,
          };
        },
      },
    });
    const source = `
      import { defineTool } from "@polpo-ai/tools";
      import { Type } from "@sinclair/typebox";
      export default defineTool({
        name: "site_context_get",
        description: "Get one site",
        parameters: Type.Object({}),
        connections: {
          siteApi: { provider: "sitoinchat", scopes: ["site:read"] },
        },
        async execute(ctx) { return ctx.connections.require("siteApi").getToken(); },
      });
    `;
    await runtime.store.putSource("site_context_get", source);
    const deployed = await runtime.deploy("site_context_get", source);
    expect(deployed.errors).toEqual([]);
    expect(deployed.meta?.connections).toEqual({
      siteApi: { provider: "sitoinchat", scopes: ["site:read"] },
    });
    await runtime.store.putBundle("site_context_get", deployed.bundle!);
    await runtime.store.putMeta("site_context_get", deployed.meta!);

    for (const user of ["user-1", "user-2"]) {
      const tool = await runtime.load(
        "site_context_get",
        undefined,
        createToolInvocationContext({
          requestId: `request-${user}`,
          runId: `run-${user}`,
          surface: "chat",
          user,
        }),
      );
      const result = await tool.execute(`call-${user}`, {});
      expect(result.content[0]).toEqual({ type: "text", text: `token:${user}` });
    }
    expect(calls).toEqual([
      "user-1:call-user-1",
      "user-2:call-user-2",
    ]);
  });

  it("executes gateway-mode connections through the invocation-bound runtime capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "polpo-custom-tools-"));
    roots.push(root);
    const polpoDir = join(root, ".polpo");
    await mkdir(polpoDir, { recursive: true });
    const requests: Array<{ user: string; method: string; path: string }> = [];
    const runtime = createLocalCustomToolRuntime({
      polpoDir,
      workDir: root,
      fs: new NodeFileSystem(),
      shell: new NodeShell(),
      connectionCapabilityResolver: {
        async resolve(input) {
          const request = async (gatewayRequest: { method: string; path: string }) => {
            requests.push({
              user: input.invocation.user!,
              method: gatewayRequest.method,
              path: gatewayRequest.path,
            });
            return {
              status: 200,
              headers: {},
              body: { user: input.invocation.user, path: gatewayRequest.path },
            };
          };
          return {
            mode: "gateway" as const,
            providerId: "sitoinchat",
            scopes: ["site:read"],
            request,
          };
        },
      },
    });
    const source = `
      import { defineTool } from "@polpo-ai/tools";
      import { Type } from "@sinclair/typebox";
      export default defineTool({
        name: "site_context_get",
        description: "Get one site",
        parameters: Type.Object({ siteId: Type.String() }),
        connections: {
          siteApi: {
            provider: "sitoinchat",
            scopes: ["site:read"],
            mode: "gateway",
          },
        },
        async execute(ctx, params) {
          const response = await ctx.connections.require("siteApi").request({
            method: "GET",
            path: "/v1/sites/" + encodeURIComponent(params.siteId),
          });
          return response.body;
        },
      });
    `;
    await runtime.store.putSource("site_context_get", source);
    const deployed = await runtime.deploy("site_context_get", source);
    expect(deployed.errors).toEqual([]);
    expect(deployed.meta?.connections).toEqual({
      siteApi: {
        provider: "sitoinchat",
        scopes: ["site:read"],
        mode: "gateway",
      },
    });
    await runtime.store.putBundle("site_context_get", deployed.bundle!);
    await runtime.store.putMeta("site_context_get", deployed.meta!);

    const tool = await runtime.load(
      "site_context_get",
      undefined,
      createToolInvocationContext({
        requestId: "request-user-1",
        runId: "run-user-1",
        surface: "chat",
        user: "user-1",
      }),
    );
    const result = await tool.execute("call-user-1", { siteId: "site/one" });
    expect(JSON.parse(result.content[0].text)).toEqual({
      user: "user-1",
      path: "/v1/sites/site%2Fone",
    });
    expect(requests).toEqual([{
      user: "user-1",
      method: "GET",
      path: "/v1/sites/site%2Fone",
    }]);
  });
});
