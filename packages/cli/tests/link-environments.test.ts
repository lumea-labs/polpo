import { Command } from "commander";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLinkCommand } from "../src/commands/link.js";

vi.mock("../src/util/auth.js", () => ({ requireAuth: async () => ({ apiKey: "fixture-key", baseUrl: "https://api.example.test" }) }));
vi.mock("../src/update-check.js", () => ({ promptForUpdateIfAvailable: async () => ({ updated: false }) }));
vi.mock("../src/util/skills.js", () => ({ installCodingAgentSkills: async () => true, skillsInstallHint: () => "" }));
vi.mock("../src/util/install-cli.js", () => ({ isPolpoOnPath: () => true, installPolpoGlobally: vi.fn(), globalInstallHint: () => "" }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(), outro: vi.fn(), spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn(), step: vi.fn() },
}));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "polpo-link-env-"));
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
function run(...args: string[]) {
  const command = new Command().exitOverride(); registerLinkCommand(command);
  return command.parseAsync(["link", "--project-id", "p1", "--dir", root, "--yes", ...args], { from: "user" });
}
function mockApi(environment: string) {
  const fetcher = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/v1/credentials/current") return Response.json({
      credential: { id: "key", type: "environment", environment },
      organization: { id: "org", name: "Example", slug: "example" },
      projects: [{ id: "p1", name: "Demo", slug: "demo-ref", environments: [{ id: "env", name: environment }] }],
    });
    if (path === "/v1/projects/p1") return Response.json({ code: "environment_admin_route_required" }, { status: 403 });
    if (path.startsWith(`/environments/${environment}/v1/`)) return Response.json({ ok: true, data: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("link with an environment key", () => {
  it("links and pulls Development without minting a new key or copying a credential", async () => {
    const fetcher = mockApi("development");
    await run();
    expect(JSON.parse(await readFile(join(root, ".polpo", "project.json"), "utf8"))).toMatchObject({ projectId: "p1", project: "Demo" });
    expect(existsSync(join(root, ".env.local"))).toBe(false);
    expect(fetcher.mock.calls.some(([url]) => url.includes("/environments/development/v1/"))).toBe(true);
    expect(fetcher.mock.calls.every(([, init]) => (init as RequestInit)?.method === "GET")).toBe(true);
  });
  it("requires --prod for a Production key before writing the project directory", async () => {
    const fetcher = mockApi("production");
    await expect(run()).rejects.toThrow("exit");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(existsSync(join(root, ".polpo"))).toBe(false);
  });
  it("links Production explicitly without storing a default environment", async () => {
    mockApi("production");
    await run("--prod");
    const config = JSON.parse(await readFile(join(root, ".polpo", "project.json"), "utf8"));
    expect(config).toMatchObject({ projectId: "p1" });
    expect(config).not.toHaveProperty("environment");
  });
});
