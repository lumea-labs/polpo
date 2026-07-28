import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareScheduleDeployments,
  scheduleDefinitionForPull,
} from "../src/util/schedules.js";
import { deploySchedules } from "../src/commands/cloud/deploy.js";
import type { ApiClient } from "../src/commands/cloud/api.js";

const NOW = new Date("2026-07-28T08:00:00.000Z");

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "polpo-schedules-"));
  const polpoDir = join(root, ".polpo");
  mkdirSync(join(polpoDir, "schedules"), { recursive: true });
  return polpoDir;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("schedule deployment preparation", () => {
  it("normalizes v2 files and previews the next timezone occurrence", () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "agents.json"), [
      { agent: { name: "reporter" } },
    ]);
    writeJson(join(polpoDir, "schedules", "daily.json"), {
      id: "daily",
      name: "Daily report",
      timing: {
        kind: "cron",
        expression: "0 11 * * *",
        timezone: "Europe/Rome",
      },
      invocation: {
        surface: "agent",
        agentName: "reporter",
        input: { prompt: "Prepare the report" },
      },
    });

    expect(prepareScheduleDeployments(polpoDir, { now: NOW })).toEqual([
      expect.objectContaining({
        kind: "v2",
        name: "Daily report",
        nextOccurrenceAt: "2026-07-28T09:00:00.000Z",
        timezone: "Europe/Rome",
        warnings: [],
        payload: expect.objectContaining({
          id: "daily",
          status: "active",
          policy: {
            catchUp: "skip",
            misfireGraceSeconds: 300,
            maxConcurrency: 1,
          },
        }),
      }),
    ]);
  });

  it("keeps legacy mission files deployable with an explicit warning", () => {
    const polpoDir = project();
    mkdirSync(join(polpoDir, "missions"), { recursive: true });
    writeJson(join(polpoDir, "missions", "nightly.json"), {
      id: "mission-1",
    });
    writeJson(join(polpoDir, "schedules", "nightly.json"), {
      missionId: "mission-1",
      expression: "0 2 * * *",
      recurring: true,
    });

    const [prepared] = prepareScheduleDeployments(polpoDir, { now: NOW });

    expect(prepared).toMatchObject({
      kind: "legacy",
      name: "mission-1",
      payload: {
        missionId: "mission-1",
        expression: "0 2 * * *",
        recurring: true,
      },
    });
    expect(prepared.warnings.join(" ")).toMatch(/legacy/i);
  });

  it("rejects every file before deployment when a locally-known agent is missing", () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "agents.json"), [
      { agent: { name: "writer" } },
    ]);
    writeJson(join(polpoDir, "schedules", "bad.json"), {
      timing: {
        kind: "cron",
        expression: "* * * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "task",
        agentName: "missing",
        title: "Work",
        prompt: "Do the work",
      },
    });

    expect(() => prepareScheduleDeployments(polpoDir, { now: NOW }))
      .toThrow(/missing.*agent/i);
  });

  it("reports all malformed files without leaking file payloads", () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "schedules", "bad-cron.json"), {
      timing: {
        kind: "cron",
        expression: "not cron",
        timezone: "UTC",
      },
      invocation: {
        surface: "webhook",
        webhookId: "hook-1",
      },
      secret: "must-not-appear",
    });
    writeFileSync(
      join(polpoDir, "schedules", "bad-json.json"),
      "{\"token\":\"must-not-appear\"",
    );

    expect(() => prepareScheduleDeployments(polpoDir, { now: NOW }))
      .toThrowError(expect.objectContaining({
        message: expect.stringContaining("bad-cron.json"),
      }));
    try {
      prepareScheduleDeployments(polpoDir, { now: NOW });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("bad-json.json");
      expect(message).not.toContain("must-not-appear");
    }
  });

  it("rejects duplicate explicit schedule identities before deployment", () => {
    const polpoDir = project();
    const definition = {
      id: "duplicate",
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: { surface: "webhook", webhookId: "daily" },
    };
    writeJson(join(polpoDir, "schedules", "one.json"), definition);
    writeJson(join(polpoDir, "schedules", "two.json"), definition);

    expect(() => prepareScheduleDeployments(polpoDir, { now: NOW }))
      .toThrow(/duplicate.*one\.json.*two\.json/i);
  });

  it("rejects a locally-known missing loop and accepts remote-only references", () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "agents.json"), [{ name: "worker" }]);
    mkdirSync(join(polpoDir, "loops"), { recursive: true });
    writeJson(join(polpoDir, "loops", "known.json"), {
      name: "known",
      kind: "sequential",
      steps: [],
    });
    writeJson(join(polpoDir, "schedules", "loop.json"), {
      timing: {
        kind: "cron",
        expression: "*/5 * * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "agent",
        agentName: "worker",
        input: { prompt: "Work" },
        execution: { loop: "missing" },
      },
    });

    expect(() => prepareScheduleDeployments(polpoDir, { now: NOW }))
      .toThrow(/missing.*loop/i);

    writeFileSync(join(polpoDir, "loops", "known.json"), "not-json");
    expect(() => prepareScheduleDeployments(polpoDir, { now: NOW }))
      .toThrow(/missing.*loop/i);
  });

  it("serializes pulled schedules as redeployable definitions only", () => {
    expect(scheduleDefinitionForPull({
      id: "daily",
      name: "Daily",
      description: "A report",
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "agent",
        agentName: "reporter",
        input: { prompt: "Report" },
      },
      status: "active",
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 300,
        maxConcurrency: 1,
      },
      metadata: {},
      driver: {
        kind: "qstash",
        status: "registered",
        providerId: "secret-provider-id",
        updatedAt: NOW.toISOString(),
      },
      nextOccurrenceAt: "2026-07-29T09:00:00.000Z",
      lastOccurrenceAt: "2026-07-28T09:00:00.000Z",
      revision: 4,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })).toEqual({
      id: "daily",
      name: "Daily",
      description: "A report",
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: {
        surface: "agent",
        agentName: "reporter",
        input: { prompt: "Report" },
      },
      status: "active",
      policy: {
        catchUp: "skip",
        misfireGraceSeconds: 300,
        maxConcurrency: 1,
      },
      metadata: {},
    });
  });
});

describe("schedule deployment", () => {
  function api(post: ApiClient["post"]): ApiClient {
    return {
      get: async () => ({ status: 500, data: {} }),
      post,
      put: async () => ({ status: 500, data: {} }),
      patch: async () => ({ status: 500, data: {} }),
      delete: async () => ({ status: 500, data: {} }),
    };
  }

  it("preflights every file before sending the first request", async () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "schedules", "valid.json"), {
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: { surface: "webhook", webhookId: "daily" },
    });
    writeJson(join(polpoDir, "schedules", "invalid.json"), {
      timing: { kind: "cron", expression: "broken", timezone: "UTC" },
      invocation: { surface: "webhook", webhookId: "bad" },
    });
    let calls = 0;

    await expect(deploySchedules(api(async () => {
      calls += 1;
      return { status: 201, data: {} };
    }), polpoDir)).rejects.toThrow(/preflight/i);

    expect(calls).toBe(0);
  });

  it("reports safe preview and driver state without provider identifiers", async () => {
    const polpoDir = project();
    writeJson(join(polpoDir, "schedules", "daily.json"), {
      name: "Daily",
      timing: {
        kind: "cron",
        expression: "0 9 * * *",
        timezone: "UTC",
      },
      invocation: { surface: "webhook", webhookId: "daily" },
    });

    const result = await deploySchedules(api(async () => ({
      status: 201,
      data: {
        ok: true,
        data: {
          driver: {
            status: "registered",
            providerId: "provider-secret-identifier",
          },
        },
      },
    })), polpoDir);

    expect(result).toMatchObject({ created: 1, failed: 0 });
    expect(result.details.join(" ")).toContain("driver registered");
    expect(result.details.join(" ")).toContain("(UTC)");
    expect(result.details.join(" ")).not.toContain(
      "provider-secret-identifier",
    );
  });
});
