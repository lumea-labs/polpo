import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("../src/commands/cloud/api.js", () => ({ createApiClient: () => api }));
vi.mock("../src/commands/cloud/project-context.js", () => ({ loadProjectId: () => "project/one" }));
vi.mock("../src/util/auth.js", () => ({ requireAuth: vi.fn(async () => ({})) }));
import { registerConnectionsCommand } from "../src/commands/cloud/connections.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  for (const method of Object.values(api)) method.mockResolvedValue({ status: 200, data: { ok: true, data: { status: "active" } } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = undefined; });

async function run(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerConnectionsCommand(program);
  await program.parseAsync(["connections", ...args, "--json"], { from: "user" });
}

describe("Connection management command requests", () => {
  it("keeps namespace and exact external account when listing and revoking", async () => {
    await run(["end-users", "list", "user/one", "--namespace", "customer/app & team"]);
    expect(api.get).toHaveBeenCalledWith("/v1/projects/project%2Fone/connect/end-users/user%2Fone/connections?namespace=customer%2Fapp+%26+team");
    await run(["end-users", "revoke", "user/one", "connection/two", "--namespace", "customer/app & team"]);
    expect(api.post).toHaveBeenCalledWith("/v1/projects/project%2Fone/connect/end-users/user%2Fone/connections/connection%2Ftwo/revoke?namespace=customer%2Fapp+%26+team");
  });

  it("configures a customer app's selected authentication method without printing its secret", async () => {
    vi.stubEnv("POLPO_ACCEPTANCE_OAUTH_SECRET", "fixture-only-secret");
    await run(["oauth-clients", "set", "contacts", "--authentication", "business", "--organization", "org/one",
      "--client-id", "own-client", "--client-secret-env", "POLPO_ACCEPTANCE_OAUTH_SECRET"]);
    expect(api.put).toHaveBeenCalledWith("/v1/orgs/org%2Fone/connect/oauth-clients/contacts", expect.objectContaining({ authenticationId: "business", clientId: "own-client", clientSecret: "fixture-only-secret" }));
    expect(vi.mocked(process.stdout.write).mock.calls.flat().join(" ")).not.toContain("fixture-only-secret");
    await run(["oauth-clients", "revoke", "contacts", "--authentication", "business/oauth"]);
    expect(api.delete).toHaveBeenCalledWith("/v1/projects/project%2Fone/connect/oauth-clients/contacts?authenticationId=business%2Foauth");
  });

  it("distinguishes replacing approved setup origins from clearing them", async () => {
    await run(["setup-config", "set", "--origin", "https://app.example"]);
    expect(api.put).toHaveBeenLastCalledWith("/v1/projects/project%2Fone/connect/setup-configuration", { returnOrigins: ["https://app.example"] });
    await run(["setup-config", "set", "--clear"]);
    expect(api.put).toHaveBeenLastCalledWith("/v1/projects/project%2Fone/connect/setup-configuration", { returnOrigins: [] });
  });
});
