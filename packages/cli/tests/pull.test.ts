import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pullProject } from "../src/util/pull.js";

describe("pullProject", () => {
  it("preserves agent loops and pipeline in agents.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-pull-"));
    const polpoDir = join(dir, ".polpo");
    const client = {
      async get(path: string) {
        if (path === "/v1/agents") {
          return {
            status: 200,
            data: {
              data: [{
                name: "loop-agent",
                role: "router",
                runtime: "polpo-runner",
                loops: {
                  classify: { systemPrompt: "Classify.", tools: ["read"] },
                  answer: { systemPrompt: "Answer." },
                },
                pipeline: {
                  steps: [{ loop: "classify" }, { loop: "answer" }],
                },
              }],
            },
          };
        }
        return { status: 200, data: { data: [] } };
      },
    };

    try {
      await pullProject(client as any, polpoDir, { force: true, interactive: false });

      const agents = JSON.parse(await readFile(join(polpoDir, "agents.json"), "utf-8"));
      expect(agents[0].agent.runtime).toBe("polpo-runner");
      expect(agents[0].agent.loops.classify.tools).toEqual(["read"]);
      expect(agents[0].agent.pipeline.steps).toEqual([{ loop: "classify" }, { loop: "answer" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
