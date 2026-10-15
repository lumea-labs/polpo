import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLoginCommand } from "../src/commands/cloud/login.js";
import { createApiClient } from "../src/commands/cloud/api.js";
import { saveCredentials } from "../src/commands/cloud/config.js";
import { resolveDefaultOrg } from "../src/util/org.js";
import { getProject, listProjects } from "../src/util/project.js";
import { assertCredentialTarget, readCredentialIdentity } from "../src/util/credential-identity.js";

vi.mock("../src/commands/cloud/config.js", () => ({ loadCredentials: () => null, saveCredentials: vi.fn() }));
vi.mock("../src/commands/cloud/prompt.js", () => ({ isTTY: () => false }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(), outro: vi.fn(), spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
const identity = {
  credential: { id: "key-one", type: "environment", environment: "development" },
  organization: { id: "org-one", name: "Example", slug: "example" },
  projects: [{ id: "project-one", name: "Demo", slug: "demo-ref", environments: [{ id: "env-one", name: "development" }] }],
};
const credentials = { apiKey: "synthetic-environment-key", baseUrl: "https://api.example.test" };
const restricted = () => Response.json({ code: "environment_admin_route_required" }, { status: 403 });
const login = () => {
  const program = new Command().exitOverride();
  registerLoginCommand(program);
  return program.parseAsync(["login", "--api-key", credentials.apiKey, "--url", credentials.baseUrl], { from: "user" });
};
beforeEach(() => {
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("CLI credential discovery", () => {
  it("validates an environment key without requiring organization administration", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/v1/credentials/current") ? Response.json(identity) : restricted());
    vi.stubGlobal("fetch", fetcher);
    await login();
    expect(saveCredentials).toHaveBeenCalledWith(credentials.apiKey, credentials.baseUrl);
    expect(fetcher.mock.calls.every(([url]) => url.endsWith("/v1/credentials/current"))).toBe(true);
  });
  it("models a shared Live key during a project-by-project Production migration", async () => {
    const mixed = { ...identity,
      credential: { id: "shared", type: "mixed", environment: "production", legacyEnvironment: "live" },
      projects: [{ ...identity.projects[0], environments: [{ id: "prod-one", name: "production" }] },
        { id: "legacy-project", name: "Legacy", slug: "legacy", environments: [] }] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(mixed)));
    const parsed = await readCredentialIdentity(createApiClient(credentials));
    expect(parsed?.credential.type).toBe("mixed");
    expect(() => assertCredentialTarget(parsed, "production", "project-one")).not.toThrow();
    expect(() => assertCredentialTarget(parsed, "development", "project-one")).toThrow(/Development key/);
    expect(() => assertCredentialTarget(parsed, "production", "legacy-project")).toThrow(/has not migrated/);
  });
  it.each([401, 403, 500])("never falls back to account discovery after identity HTTP %s", async status => {
    const fetcher = vi.fn(async () => Response.json({ error: "unavailable" }, { status }));
    vi.stubGlobal("fetch", fetcher);
    await expect(login()).rejects.toThrow("exit");
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe(`${credentials.baseUrl}/v1/credentials/current`);
  });
  it.each([404, 405])("supports older servers only when discovery is unavailable (%s)", async status => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/v1/credentials/current")
      ? new Response(null, { status }) : Response.json(url.endsWith("/v1/orgs") ? [identity.organization] : [])));
    await login();
    expect(saveCredentials).toHaveBeenCalledWith(credentials.apiKey, credentials.baseUrl);
  });
  it.each([{}, { ...identity, credential: { ...identity.credential, environment: null } },
    { ...identity, credential: { ...identity.credential, type: "future" } }])("rejects malformed identity without saving a key", async data => {
    const fetcher = vi.fn(async () => Response.json(data));
    vi.stubGlobal("fetch", fetcher);
    await expect(login()).rejects.toThrow("exit");
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("discovers only authorized project metadata for a key denied administrative routes", async () => {
    const fetcher = vi.fn(async (url: string) => url.endsWith("/v1/credentials/current") ? Response.json(identity) : restricted());
    vi.stubGlobal("fetch", fetcher);
    const client = createApiClient(credentials);
    expect(await resolveDefaultOrg(client)).toEqual(identity.organization);
    expect(await listProjects(client, "org-one")).toEqual([{ id: "project-one", name: "Demo", slug: "demo-ref", orgId: "org-one" }]);
    expect(await listProjects(client, "another-org")).toEqual([]);
    expect(await getProject(client, "project-one")).toMatchObject({ id: "project-one", orgId: "org-one" });
    expect(await getProject(client, "foreign-project")).toBeNull();
  });
  it("does not turn failed project discovery into an empty project list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "unavailable" }, { status: 503 })));
    await expect(listProjects(createApiClient(credentials), "org-one")).rejects.toThrow(/503/);
  });
});
