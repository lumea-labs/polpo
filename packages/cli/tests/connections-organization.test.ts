import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerConnectionsCommand } from "../src/commands/cloud/connections.js";

const mocks = vi.hoisted(() => ({
  loadProjectId: vi.fn<() => string | undefined>(),
  requireAuth: vi.fn(),
}));
vi.mock("../src/commands/cloud/project-context.js", () => ({ loadProjectId: mocks.loadProjectId }));
vi.mock("../src/util/auth.js", () => ({ requireAuth: mocks.requireAuth }));

const configuration = {
  providerId: "mcp_url", resourceUrl: "https://mcp.example/mcp", transport: "http",
  registration: { mode: "dynamic", clientName: "Example App" },
};
const operations = [
  { name: "MCP list", args: ["mcp", "configurations", "list"], method: "GET", suffix: "/mcp-oauth-configurations" },
  { name: "MCP create", args: ["mcp", "configurations", "create", "<file>"], method: "POST", suffix: "/mcp-oauth-configurations", body: configuration },
  { name: "MCP update", args: ["mcp", "configurations", "update", "config/one", "<file>", "--revision", "v1"], method: "PUT", suffix: "/mcp-oauth-configurations/config%2Fone", body: { ...configuration, expectedRevision: "v1" } },
  { name: "MCP revoke", args: ["mcp", "configurations", "revoke", "config/one", "--revision", "v2"], method: "DELETE", suffix: "/mcp-oauth-configurations/config%2Fone?expectedRevision=v2" },
  { name: "OAuth list", args: ["oauth-clients", "list"], method: "GET", suffix: "/oauth-clients" },
  { name: "OAuth set", args: ["oauth-clients", "set", "contacts/one", "--client-id", "own-client", "--authentication", "business", "--client-secret-env", "POLPO_TEST_OAUTH_SECRET"], method: "PUT", suffix: "/oauth-clients/contacts%2Fone", body: { clientId: "own-client", authenticationId: "business", clientSecret: "fixture-only-secret", returnOrigins: [] } },
  { name: "OAuth revoke", args: ["oauth-clients", "revoke", "contacts/one", "--authentication", "business/oauth"], method: "DELETE", suffix: "/oauth-clients/contacts%2Fone?authenticationId=business%2Foauth" },
];

describe("Connection client administration scope", () => {
  let directory: string;
  let inputFile: string;
  const fetchImpl = vi.fn<typeof fetch>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "polpo-connect-organization-"));
    inputFile = join(directory, "configuration.json");
    await writeFile(inputFile, JSON.stringify(configuration), { mode: 0o600 });
    mocks.loadProjectId.mockReset().mockReturnValue(undefined);
    mocks.requireAuth.mockReset().mockResolvedValue({ baseUrl: "https://api.polpo.test", apiKey: "fixture-platform-key" });
    fetchImpl.mockReset().mockImplementation(async () => new Response(JSON.stringify({ ok: true, data: { id: "saved" } }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubEnv("POLPO_TEST_OAUTH_SECRET", "fixture-only-secret");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  async function run(args: string[]) {
    const program = new Command();
    program.exitOverride();
    registerConnectionsCommand(program);
    await program.parseAsync(["connections", ...args.map(arg => arg === "<file>" ? inputFile : arg), "--json"], { from: "user" });
  }

  for (const projectId of [undefined, "unrelated/local-project"]) {
    it.each(operations)(`runs $name for an organization with local project ${projectId ?? "absent"}, without a project header`, async operation => {
      mocks.loadProjectId.mockReturnValue(projectId);
      await run([...operation.args, "--organization", "org/one"]);
      expect(process.exitCode).not.toBe(1);
      expect(mocks.requireAuth).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [url, request] = fetchImpl.mock.calls[0]!;
      expect(url).toBe(`https://api.polpo.test/v1/orgs/org%2Fone/connect${operation.suffix}`);
      expect(request?.method).toBe(operation.method);
      const headers = new Headers(request?.headers);
      expect(headers.get("authorization")).toBe("Bearer fixture-platform-key");
      expect(headers.has("x-project-id")).toBe(false);
      expect(mocks.loadProjectId).not.toHaveBeenCalled();
      expect(request?.body === undefined ? undefined : JSON.parse(String(request.body))).toEqual(operation.body);
      expect(JSON.stringify(vi.mocked(process.stdout.write).mock.calls)).not.toContain("fixture-only-secret");
    });
  }

  it.each(operations)("still requires a linked project for project-scoped $name", async operation => {
    await run(operation.args);
    expect(process.exitCode).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("No project linked"));
  });

  it.each(["", "   "])("rejects an explicit empty organization instead of revoking in the local project: %j", async organization => {
    mocks.loadProjectId.mockReturnValue("unrelated/local-project");
    await run(["mcp", "configurations", "revoke", "configuration", "--revision", "v1", "--organization", organization]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(mocks.loadProjectId).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("non-empty organization ID"));
  });

  it.each(operations)("retains project paths and the project header for $name", async operation => {
    mocks.loadProjectId.mockReturnValue("project/one");
    await run(operation.args);
    expect(process.exitCode).not.toBe(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, request] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`https://api.polpo.test/v1/projects/project%2Fone/connect${operation.suffix}`);
    expect(new Headers(request?.headers).get("x-project-id")).toBe("project/one");
    expect(request?.method).toBe(operation.method);
    expect(request?.body === undefined ? undefined : JSON.parse(String(request.body))).toEqual(operation.body);
  });

  it.each([["mcp", "configurations", "list"], ["oauth-clients", "list"]])("requires authentication for organization administration: %s", async (...args) => {
    mocks.requireAuth.mockRejectedValueOnce(new Error("Authentication required"));
    await run([...args, "--organization", "org/one"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining("Authentication required"));
  });
});
