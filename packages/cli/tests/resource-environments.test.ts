import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDataCommand } from "../src/commands/cloud/data.js";
import { registerToolsCommand } from "../src/commands/cloud/tools.js";
import { registerChannelsCommand } from "../src/commands/cloud/channels.js";
import { registerConnectionsCommand } from "../src/commands/cloud/connections.js";
import { registerVolumesCommand } from "../src/commands/cloud/volumes.js";
import { registerMemoryCommands } from "../src/commands/cloud/memory.js";
import { registerByokCommand } from "../src/commands/cloud/byok.js";
import { registerLogsCommand } from "../src/commands/cloud/logs.js";
import { registerStatusCommand } from "../src/commands/cloud/status.js";
vi.mock("../src/util/auth.js", () => ({ requireAuth: vi.fn(async () => ({ apiKey: "cli-token", baseUrl: "https://api.example.test" })) }));
vi.mock("../src/commands/cloud/project-context.js", () => ({ loadProjectId: () => "project-one" }));
vi.mock("@clack/prompts", () => ({
  intro: vi.fn(), outro: vi.fn(), spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const cases = [
  ["data", registerDataCommand, ["data", "list"]],
  ["tools", registerToolsCommand, ["tools", "list"]],
  ["channels", registerChannelsCommand, ["channels", "list", "--json"]],
  ["connections", registerConnectionsCommand, ["connections", "list", "--json"]],
  ["volumes", registerVolumesCommand, ["volumes", "list", "--json"]],
  ["memory", registerMemoryCommands, ["memory", "candidates", "list", "--agent", "support", "--user", "customer", "--json"]],
  ["byok", registerByokCommand, ["byok", "list"]],
  ["logs", registerLogsCommand, ["cloud-logs"]],
  ["logs stream", registerLogsCommand, ["cloud-logs", "--follow"]],
  ["status", registerStatusCommand, ["cloud-status"]],
] as const;

describe("resource command environment transport", () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let exitCode: typeof process.exitCode;
  beforeEach(() => {
    exitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    fetcher = vi.fn(async (url: string) => url.endsWith("/events")
      ? new Response("event: heartbeat\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } })
      : Response.json({ ok: true, data: [] }));
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = exitCode;
  });

  for (const [name, register, args] of cases) {
    it.each([false, true])(`${name} targets the selected environment (production=%s)`, async production => {
      const command = new Command().exitOverride();
      register(command);
      await command.parseAsync([...args, ...(production ? ["--prod"] : [])], { from: "user" });
      expect(process.exitCode).toBeUndefined();
      expect(fetcher).toHaveBeenCalled();
      const environment = production ? "production" : "development";
      for (const [url, init] of fetcher.mock.calls) {
        expect(url).toMatch(new RegExp(`^https://api.example.test/environments/${environment}/v1/`));
        expect(new Headers((init as RequestInit).headers).get("x-project-id")).toBe("project-one");
        expect(new Headers((init as RequestInit).headers).get("authorization")).toBe("Bearer cli-token");
      }
      if (name === "byok") expect(fetcher.mock.calls[0][0]).toBe(`https://api.example.test/environments/${environment}/v1/byok/project-one`);
    });
  }
});
