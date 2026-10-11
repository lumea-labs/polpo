import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerConnectionsCommand } from "../src/commands/cloud/connections.js";

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("../src/commands/cloud/api.js", () => ({ createApiClient: () => mocks }));
vi.mock("../src/commands/cloud/project-context.js", () => ({ loadProjectId: () => "project/one" }));
vi.mock("../src/util/auth.js", () => ({ requireAuth: async () => ({ baseUrl: "https://api.polpo.sh", apiKey: "private-polpo-key" }) }));

describe("Connections CLI creation", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "polpo-connect-create-"));
    for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue({ status: 201, data: { ok: true, data: { id: "connection" } } });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); process.exitCode = 0; });

  it.each(["api-key", "public", "mcp"])("creates %s from a private file while preserving identity and method selection", async (kind) => {
    const payload = { providerId: "notes", authenticationId: "token", audience: "end_user",
      subject: { type: "external_user", namespace: "app", id: "viewer" }, binding: { scopeEpoch: "one" },
      ...(kind === "public" ? {} : { apiKey: "private-fixture-secret" }), ...(kind === "mcp" ? { url: "https://mcp.example" } : {}) };
    const filename = join(directory, "input.json");
    await writeFile(filename, JSON.stringify(payload), { mode: 0o600 });
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "create", kind, filename, "--json"], { from: "user" });
    expect(mocks.post).toHaveBeenCalledWith(`/v1/projects/project%2Fone/connect/connections/${kind}`, payload);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('"id": "connection"'));
    expect(JSON.stringify(vi.mocked(process.stdout.write).mock.calls)).not.toContain("private-fixture-secret");
  });

  it("rejects malformed file input before an API write without echoing its contents", async () => {
    const filename = join(directory, "input.json"); await writeFile(filename, '{"apiKey":"private-fixture-secret"');
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "create", "api-key", filename, "--json"], { from: "user" });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain("private-fixture-secret");
  });

  it("creates embedded setup with a reusable MCP configuration and application-scoped owner", async () => {
    const subject = { type: "external_user", namespace: "app", id: "gioia" };
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "setup-session", "mcp_url", "--audience", "end_user", "--subject", JSON.stringify(subject),
      "--return-url", "https://app.example/connected", "--oauth-client-mode", "customer", "--configuration", "mcp-config", "--json"], { from: "user" });
    expect(mocks.post).toHaveBeenCalledWith("/v1/projects/project%2Fone/connect/setup-sessions", expect.objectContaining({
      providerId: "mcp_url", audience: "end_user", subject, returnUrl: "https://app.example/connected",
      oauthClientMode: "customer", configurationId: "mcp-config",
    }));
  });

  it("manages MCP OAuth configurations through private files and explicit edit revisions", async () => {
    const input = { providerId: "mcp_url", resourceUrl: "https://mcp.example/mcp", transport: "http",
      registration: { mode: "pre_registered", client: { client_id: "client", client_secret: "private-secret" } } };
    const file = join(directory, "mcp-client.json"); await writeFile(file, JSON.stringify(input), { mode: 0o600 });
    const invoke = async (args: string[]) => { const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
      await program.parseAsync(["connections", "mcp", "configurations", ...args, "--json"], { from: "user" }); };
    await invoke(["create", file]);
    await invoke(["update", "config/one", file, "--revision", "v1"]);
    await invoke(["revoke", "config/one", "--revision", "v2"]);
    await invoke(["list", "--organization", "org/one"]);
    const path = "/v1/projects/project%2Fone/connect/mcp-oauth-configurations";
    expect(mocks.post).toHaveBeenCalledWith(path, input);
    expect(mocks.put).toHaveBeenCalledWith(`${path}/config%2Fone`, { ...input, expectedRevision: "v1" });
    expect(mocks.delete).toHaveBeenCalledWith(`${path}/config%2Fone?expectedRevision=v2`);
    expect(mocks.get).toHaveBeenCalledWith("/v1/orgs/org%2Fone/connect/mcp-oauth-configurations");
    expect(JSON.stringify(vi.mocked(process.stdout.write).mock.calls)).not.toContain("private-secret");
  });

  it.each(["linear", "https://mcp.example/mcp"])("opens session-authenticated setup for %s without starting OAuth with a key", async (server) => {
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "mcp", "connect", server, "--json"], { from: "user" });
    expect(mocks.post).not.toHaveBeenCalled();
    const result = JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]![0]));
    const link = new URL(result.setupUrl);
    expect(link.origin).toBe("https://polpo.sh");
    expect(link.pathname).toBe("/projects/project%2Fone/connections/browse");
    expect(link.searchParams.get("provider")).toBe("mcp_url");
    expect(link.searchParams.get(server === "linear" ? "mcpPreset" : "mcpUrl")).toBe(server);
    expect(result.requiresBrowserSession).toBe(true);
    expect(result.setupUrl).not.toContain("private-polpo-key");
  });

  it("supports a local dashboard and custom name/transport without API mutation", async () => {
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "mcp", "connect", "https://mcp.example/mcp", "--dashboard-url", "http://localhost:3411",
      "--name", "Team & support", "--transport", "sse", "--json"], { from: "user" });
    const link = new URL(JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]![0])).setupUrl);
    expect(link.origin).toBe("http://localhost:3411");
    expect(link.searchParams.get("mcpName")).toBe("Team & support");
    expect(link.searchParams.get("mcpTransport")).toBe("sse");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each([
    ["--subject", '{"id":"private-owner"}'], ["--binding", '{"id":"private-binding"}'],
    ["--provider", "notes"], ["--authentication", "oauth"], ["--scope", "special:scope"],
    ["--audience", "end_user"], ["--dashboard-url", "javascript:alert(1)"],
  ])("rejects unsupported or unsafe browser setup options: %s", async (...options) => {
    const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
    await program.parseAsync(["connections", "mcp", "connect", "https://mcp.example/mcp", ...options, "--json"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
  });

  it("registers/disables definitions and inspects OAuth setup prerequisites through project routes", async () => {
    const definition = { version: 2, id: "notes", name: "Notes", source: "custom", protocol: "http_api",
      authentication: [{ id: "public", type: "none" }], http: { origins: ["https://api.example"] } };
    const filename = join(directory, "connector.json"); await writeFile(filename, JSON.stringify(definition));
    const invoke = async (args: string[]) => { const program = new Command(); program.exitOverride(); registerConnectionsCommand(program);
      await program.parseAsync(["connections", ...args, "--json"], { from: "user" }); };
    await invoke(["connectors", "register", filename]);
    await invoke(["connectors", "disable", "notes/two"]);
    await invoke(["setup-readiness", "notes", "--authentication", "public", "--oauth-client-mode", "customer"]);
    expect(mocks.post.mock.calls).toEqual([
      ["/v1/projects/project%2Fone/connect/connectors", definition],
      ["/v1/projects/project%2Fone/connect/connectors/notes%2Ftwo/disable"],
      ["/v1/projects/project%2Fone/connect/setup-readiness", { providerId: "notes", authenticationId: "public", oauthClientMode: "customer" }],
    ]);
  });
});
