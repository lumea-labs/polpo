import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRunsCommands } from "../src/commands/cloud/runs.js";

vi.mock("../src/util/auth.js", () => ({
  requireAuth: vi.fn(async () => ({
    apiKey: "cli-token",
    baseUrl: "https://api.example.test",
  })),
}));

vi.mock("../src/commands/cloud/project-context.js", () => ({
  loadProjectId: () => "project-one",
}));

const receipt = {
  version: 1,
  runId: "run/one",
  messageId: "message one",
  mode: "steer",
  acceptance: "best_effort",
  policySource: "loop",
  admission: "accepted",
  delivery: "pending",
  locale: "it-IT",
  admittedAt: "2026-10-17T00:00:00.000Z",
};

describe("Runs CLI steering transport", () => {
  let fetcher: ReturnType<typeof vi.fn>;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/abort")) {
        return Response.json({ ok: true, data: { runId: "run/one", aborted: true } }, { status: 202 });
      }
      return Response.json({ ok: true, data: { receipt } }, {
        status: init.method === "POST" ? 202 : 200,
      });
    });
    vi.stubGlobal("fetch", fetcher);
  });

  afterEach(() => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function run(...args: string[]) {
    const program = new Command().exitOverride();
    registerRunsCommands(program);
    await program.parseAsync(args, { from: "user" });
  }

  it("sends an idempotent localized instruction to the selected environment", async () => {
    await run(
      "runs",
      "steer",
      "run/one",
      "--message",
      "Cambia il titolo",
      "--id",
      "message one",
      "--locale",
      "it-IT",
      "--prod",
      "--json",
    );

    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://api.example.test/environments/production/v1/runs/run%2Fone/steering",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          id: "message one",
          mode: "steer",
          locale: "it-IT",
          content: { text: "Cambia il titolo" },
        }),
        headers: expect.objectContaining({
          Authorization: "Bearer cli-token",
          "x-project-id": "project-one",
        }),
      }),
    );
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(receipt, null, 2));
    expect(process.exitCode).toBeUndefined();
  });

  it("reads an encoded receipt and aborts the same public run id", async () => {
    await run("runs", "steering", "get", "run/one", "message one", "--json");
    await run("runs", "abort", "run/one", "--reason", "Stop now", "--json");

    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/environments/development/v1/runs/run%2Fone/steering/message%20one",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "https://api.example.test/environments/development/v1/runs/run%2Fone/abort",
    );
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ reason: "Stop now" }),
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects an unknown delivery mode before sending a request", async () => {
    await run("runs", "steer", "run-1", "--message", "hello", "--mode", "later");

    expect(fetcher).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
