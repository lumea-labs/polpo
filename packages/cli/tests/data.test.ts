import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDataCommand } from "../src/commands/cloud/data.js";

describe("Data CLI JSON and HTTP boundary", () => {
  let directory: string;
  let fetcher: ReturnType<typeof vi.fn>;
  let previousExitCode: typeof process.exitCode;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "polpo-data-cli-"));
    previousExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.stubEnv("POLPO_API_KEY", "local-test-key");
    fetcher = vi
      .fn()
      .mockImplementation(async () => Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });
  afterEach(async () => {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  const run = async (...args: string[]) => {
    const program = new Command().exitOverride();
    registerDataCommand(program);
    await program.parseAsync(
      [
        "data",
        ...args,
        "--url",
        "https://data.example.test/api",
        "--project",
        "project-test",
      ],
      { from: "user" },
    );
  };
  const jsonFile = async (body: unknown) => {
    const path = join(directory, "input.json");
    await writeFile(path, JSON.stringify(body));
    return path;
  };

  it("executes the JSON SQL request through the scoped API without changing retry or mode", async () => {
    const body = {
      sql: "UPDATE customers SET name=$1 WHERE _id=$2 AND _version=$3 RETURNING *",
      params: ["Maria", "11111111-1111-4111-8111-111111111111", 1],
      mode: "write",
      maxRows: 1,
      idempotencyKey: "rename-42",
    };
    await run("query", "crm", await jsonFile(body));
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://data.example.test/api/v1/data/crm/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          Authorization: "Bearer local-test-key",
          "x-project-id": "project-test",
        }),
      }),
    );
    expect(process.exitCode).toBeUndefined();
  });
  it("preserves migration identity, expected version and destructive intent, then lists history", async () => {
    const body = {
      id: "drop_legacy",
      expectedVersion: 3,
      statements: [{ sql: "DROP TABLE legacy" }],
      allowDestructive: true,
    };
    await run("migrate-sql", "crm", await jsonFile(body));
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://data.example.test/api/v1/data/crm/migrations",
      expect.objectContaining({ method: "POST", body: JSON.stringify(body) }),
    );
    await run("migrations", "crm");
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://data.example.test/api/v1/data/crm/migrations",
      expect.objectContaining({ method: "GET" }),
    );
  });
  it("rejects invalid query bounds and host-forged arguments before any request", async () => {
    await run(
      "query",
      "crm",
      await jsonFile({ sql: "SELECT 1", maxRows: 201, scope: "other-project" }),
    );
    expect(process.exitCode).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects malformed and oversized input files before any request", async () => {
    const path = join(directory, "bad.json");
    await writeFile(path, "{");
    await run("query", "crm", path);
    expect(process.stderr.write).toHaveBeenCalledWith(
      "Invalid Data JSON file\n",
    );
    await writeFile(path, "x".repeat(262145));
    await run("migrate-sql", "crm", path);
    expect(process.stderr.write).toHaveBeenCalledWith(
      "Data input exceeds 256 KiB\n",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires the exact database deletion confirmation and sends its expected version", async () => {
    await run("delete", "crm", "--version", "3", "--confirm", "another");
    expect(fetcher).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await run("delete", "crm", "--version", "3", "--confirm", "crm");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://data.example.test/api/v1/data/crm?expectedVersion=3",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
  it("returns a failing exit code for API denial without printing success", async () => {
    fetcher.mockResolvedValueOnce(
      Response.json(
        {
          ok: false,
          code: "data_forbidden",
          error: "Data access is not granted",
        },
        { status: 403 },
      ),
    );
    await run("query", "crm", await jsonFile({ sql: "SELECT 1" }));
    expect(process.exitCode).toBe(1);
    expect(process.stderr.write).toHaveBeenCalledWith(
      "Data access is not granted\n",
    );
    expect(process.stdout.write).not.toHaveBeenCalled();
  });
});
