import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createApiClient: vi.fn(),
  loadProjectId: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("../src/commands/cloud/api.js", () => ({
  createApiClient: mocks.createApiClient,
}));

vi.mock("../src/commands/cloud/project-context.js", () => ({
  loadProjectId: mocks.loadProjectId,
}));

vi.mock("../src/util/auth.js", () => ({
  requireAuth: mocks.requireAuth,
}));

import {
  registerSessionCommands,
  sessionToolCallPath,
} from "../src/commands/cloud/sessions.js";

const tempDirs: string[] = [];

function program(): Command {
  const value = new Command();
  value.exitOverride();
  registerSessionCommands(value);
  return value;
}

beforeEach(() => {
  mocks.loadProjectId.mockReturnValue("project-1");
  mocks.requireAuth.mockResolvedValue({
    apiKey: "account-key",
    baseUrl: "https://api.polpo.test",
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  process.exitCode = undefined;
  return Promise.all(tempDirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

describe("Session client-tool commands", () => {
  it("reads title metadata and renames with a title revision in the selected environment", async () => {
    const get = vi.fn().mockResolvedValue({ status: 200, data: { data: { id: "s/1", titleRevision: 2 } } });
    const patch = vi.fn().mockResolvedValue({ status: 200, data: { data: { renamed: true, session: { titleRevision: 3 } } } });
    mocks.createApiClient.mockReturnValue({ get, patch });
    await program().parseAsync(["node", "polpo", "sessions", "show", "s/1", "--prod"]);
    await program().parseAsync(["node", "polpo", "sessions", "rename", "s/1", "Manual title", "--title-revision", "2", "--prod"]);
    expect(get).toHaveBeenCalledWith("/v1/chat/sessions/s%2F1");
    expect(patch).toHaveBeenCalledWith("/v1/chat/sessions/s%2F1", { title: "Manual title", expectedTitleRevision: 2 });
    expect(mocks.createApiClient).toHaveBeenLastCalledWith(expect.anything(), "project-1", "production");
  });
  it("encodes resource identities and omits absent exact identity selectors", () => {
    expect(sessionToolCallPath("session/one", "call?one"))
      .toBe("/v1/chat/sessions/session%2Fone/tool-calls/call%3Fone");
    expect(sessionToolCallPath("session", "call", {
      agent: "site agent",
      user: "user+one@example.test",
    })).toBe(
      "/v1/chat/sessions/session/tool-calls/call"
      + "?agent=site+agent&user=user%2Bone%40example.test",
    );
  });

  it("inspects through the selected Cloud environment without mutating the tool call", async () => {
    const get = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        data: {
          sessionId: "session-1",
          toolCallId: "call-1",
          sessionVersion: 4,
          status: "pending",
        },
      },
    });
    const put = vi.fn();
    mocks.createApiClient.mockReturnValue({ get, put });

    await program().parseAsync([
      "node",
      "polpo",
      "sessions",
      "tool-call",
      "session-1",
      "call-1",
      "--agent",
      "support",
      "--user",
      "user-1",
      "--prod",
      "--json",
    ]);

    expect(mocks.createApiClient).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "account-key" }),
      "project-1",
      "production",
    );
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      "/v1/chat/sessions/session-1/tool-calls/call-1?agent=support&user=user-1",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("settles once with the exact result and idempotency key", async () => {
    const get = vi.fn();
    const put = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        ok: true,
        data: {
          status: "settled",
          receipt: {
            id: "receipt-1",
            outcome: "success",
            sessionVersion: 5,
          },
        },
      },
    });
    mocks.createApiClient.mockReturnValue({ get, put });

    const dir = await mkdtemp(join(tmpdir(), "polpo-settlement-cli-"));
    tempDirs.push(dir);
    const resultFile = join(dir, "result.json");
    await writeFile(resultFile, "{\"saved\":true}\n", "utf8");

    await program().parseAsync([
      "node",
      "polpo",
      "sessions",
      "settle-tool-call",
      "session-1",
      "call-1",
      "--agent",
      "support",
      "--user",
      "user-1",
      "--outcome",
      "success",
      "--session-version",
      "4",
      "--idempotency-key",
      "repair-20261017",
      "--result-file",
      resultFile,
      "--json",
    ]);

    expect(put).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledWith(
      "/v1/chat/sessions/session-1/tool-calls/call-1/settlement",
      {
        agent: "support",
        user: "user-1",
        expectedSessionVersion: 4,
        outcome: "success",
        result: "{\"saved\":true}\n",
      },
      { headers: { "Idempotency-Key": "repair-20261017" } },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects success without a result before authentication or an API request", async () => {
    const put = vi.fn();
    mocks.createApiClient.mockReturnValue({ put });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await program().parseAsync([
      "node",
      "polpo",
      "sessions",
      "settle-tool-call",
      "session-1",
      "call-1",
      "--outcome",
      "success",
      "--session-version",
      "4",
      "--idempotency-key",
      "repair-20261017",
    ]);

    expect(process.exitCode).toBe(1);
    expect(mocks.requireAuth).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("--result-file is required"));
    error.mockRestore();
  });
});
