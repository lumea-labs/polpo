import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/util/auth.js", () => ({
  requireAuth: vi.fn(async () => ({ apiKey: "cli-session", baseUrl: "https://api.example.test" })),
}));
import { requireAuth } from "../src/util/auth.js";
import { runDeploy } from "../src/commands/cloud/deploy.js";
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("environment-bound deploy", () => {
  it.each([
    [{}, "development"],
    [{ prod: true }, "production"],
    [{ env: "production" }, "production"],
  ] as const)("targets %j for definitions and multipart uploads without copying secrets/state", async (options, environment) => {
    const root = await mkdtemp(join(tmpdir(), "polpo-deploy-env-"));
    roots.push(root);
    const dir = join(root, ".polpo");
    await mkdir(join(dir, "avatars"), { recursive: true });
    await mkdir(join(dir, "tools"));
    const config = JSON.stringify({ schemaVersion: 2, project: "example", projectId: "p1", projectSlug: "example-p1" });
    await writeFile(join(dir, "project.json"), config);
    await writeFile(join(dir, "avatars", "support.png"), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(dir, "tools", "hello.ts"), "export default { name: 'hello', description: 'Hello', parameters: { type: 'object', properties: {} }, execute: async () => 'hello' };");
    await writeFile(join(dir, "memory.md"), "private development memory");
    await writeFile(join(dir, "vault.enc"), "not even decrypted by deploy");
    await writeFile(join(dir, ".env"), "OPENAI_API_KEY=local-only-placeholder\n");
    vi.stubEnv("ANTHROPIC_API_KEY", "local-only-placeholder");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (new URL(url).pathname === "/v1/credentials/current") return Response.json({
        credential: { id: "key", type: "environment", environment },
        organization: { id: "org", name: "Example", slug: "example" },
        projects: [{ id: "p1", name: "Example", slug: "example-p1", environments: [{ id: "env", name: environment }] }],
      });
      return Response.json({ ok: true, data: init?.method === "GET" ? [] : {} });
    }));
    const report = await runDeploy({ dir: root, yes: true, force: true, silent: true, ...options });
    expect(report.total.failed).toBe(0);
    expect(report.environment).toBe(environment);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const { url, init } of calls) {
      if (new URL(url).pathname === "/v1/credentials/current") {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cli-session");
        continue;
      }
      expect(new URL(url).pathname).toMatch(new RegExp(`^/environments/${environment}/v1/(tools|files)(/|$)`));
      expect(new Headers(init?.headers).get("x-project-id")).toBe("p1");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cli-session");
    }
    const upload = calls.find(call => call.init?.body instanceof FormData)!;
    expect(new Headers(upload.init?.headers).has("content-type")).toBe(false);
    expect(Buffer.from(await ((upload.init?.body as FormData).get("file") as File).arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(await readFile(join(dir, "project.json"), "utf8")).toBe(config);
  });

  it("rejects conflicting targets before authentication or filesystem writes", async () => {
    await expect(runDeploy({ dir: "/not-read", prod: true, env: "development" })).rejects.toThrow(/conflict/i);
    expect(requireAuth).not.toHaveBeenCalled();
  });

  it.each([
    ["production", "p1", /production.*--prod/i],
    ["development", "foreign-project", /access.*p1/i],
    ["test", "p1", /legacy.*migrat/i],
  ])("rejects a %s credential for %s before writes", async (environment, accessibleProject, error) => {
    const root = await mkdtemp(join(tmpdir(), "polpo-deploy-auth-"));
    roots.push(root);
    await mkdir(join(root, ".polpo"));
    const config = JSON.stringify({ schemaVersion: 2, project: "example", projectId: "p1" });
    await writeFile(join(root, ".polpo", "project.json"), config);
    const fetcher = vi.fn(async () => Response.json({
      credential: { id: "key", type: environment === "test" ? "legacy" : "environment",
        environment: environment === "test" ? null : environment,
        ...(environment === "test" ? { legacyEnvironment: "test" } : {}) },
      organization: { id: "org", name: "Example", slug: "example" },
      projects: [{ id: accessibleProject, name: "Example", slug: "example-ref",
        environments: environment === "test" ? [] : [{ id: "env", name: environment }] }],
    }));
    vi.stubGlobal("fetch", fetcher);
    await expect(runDeploy({ dir: root, yes: true, silent: true })).rejects.toThrow(error);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readFile(join(root, ".polpo", "project.json"), "utf8")).toBe(config);
  });
});
