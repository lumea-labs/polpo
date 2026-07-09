import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pullProject } from "../src/util/pull.js";

describe("pullProject", () => {
  it("pulls project loops separately from agent assignments", async () => {
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
                assignedLoops: ["router-flow"],
                teamName: "platform",
              }],
            },
          };
        }
        if (path === "/v1/loops") {
          return {
            status: 200,
            data: {
              data: [{
                name: "router-flow",
                start: "classify",
                steps: {
                  classify: { type: "agent", systemPrompt: "Classify.", tools: ["read"], next: "answer" },
                  answer: { type: "agent", systemPrompt: "Answer.", next: "end" },
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
      expect(agents[0].agent.assignedLoops).toEqual(["router-flow"]);
      expect(agents[0].agent.loops).toBeUndefined();
      expect(agents[0].agent.pipeline).toBeUndefined();
      expect(agents[0].teamName).toBe("platform");

      const loop = JSON.parse(await readFile(join(polpoDir, "loops", "router-flow.json"), "utf-8"));
      expect(loop.steps.classify.tools).toEqual(["read"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
