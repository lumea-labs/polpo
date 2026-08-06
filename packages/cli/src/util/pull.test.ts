import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullProject } from "./pull.js";
import { readProjectAgents } from "@polpo-ai/file-stores";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) =>
    rm(dir, { recursive: true, force: true })));
});

describe("pullProject agent execution router", () => {
  it("round-trips execution router settings into an agent definition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-pull-router-"));
    dirs.push(dir);
    const agent = {
      name: "researcher",
      model: "test",
      assignedLoops: ["research"],
      executionRouter: {
        mode: "auto",
        allowedLoops: ["research"],
        minConfidence: 0.82,
        timeoutMs: 750,
        maxInputChars: 2048,
      },
      teamName: "default",
    };
    const client = {
      get: async (path: string) => {
        if (path === "/v1/agents") {
          return { status: 200, data: { data: [agent] } };
        }
        return { status: 404, data: {} };
      },
    };

    const result = await pullProject(client as any, dir, {
      force: true,
      interactive: false,
    });
    const entries = readProjectAgents(dir);

    expect(result.errors).toEqual([]);
    expect(entries[0].agent.executionRouter).toEqual(agent.executionRouter);
  });
});
