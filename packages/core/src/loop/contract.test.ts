import { describe, expect, it } from "vitest";
import { agentLoopConfigSchema, projectLoopConfigSchema } from "../schemas.js";
import { normalizeProjectLoop } from "./normalize.js";
import type { ProjectLoopConfig } from "./types.js";

describe("agentLoopConfigSchema", () => {
  it("accepts a loop collection with a deterministic pipeline", () => {
    const parsed = agentLoopConfigSchema.parse({
      name: "router-agent",
      runtime: "polpo-runner",
      loops: {
        classify: {
          systemPrompt: "Classify the request.",
          tools: ["read"],
          skills: ["classification"],
          output: {
            schema: {
              type: "object",
              properties: { route: { type: "string" } },
            },
          },
          stopWhen: { expression: "output.route != null" },
        },
        answer: {
          systemPrompt: "Answer the request.",
          tools: ["write"],
        },
      },
      pipeline: {
        context: "shared",
        steps: [
          { loop: "classify" },
          {
            switch: {
              cases: [
                { when: "output.route == 'answer'", steps: [{ loop: "answer" }] },
              ],
            },
          },
        ],
      },
    });

    expect(Object.keys(parsed.loops)).toEqual(["classify", "answer"]);
    expect(parsed.loops.classify.skills).toEqual(["classification"]);
    expect(parsed.pipeline?.steps).toHaveLength(2);
  });

  it("rejects pipelines that reference unknown loops", () => {
    const parsed = agentLoopConfigSchema.safeParse({
      loops: {
        classify: {},
      },
      pipeline: {
        steps: [{ loop: "missing" }],
      },
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('unknown loop "missing"');
  });

  it("accepts a project-level loop graph and normalizes it to executor shape", () => {
    const loop = projectLoopConfigSchema.parse({
      name: "coding-flow",
      context: "shared",
      start: "plan",
      steps: {
        plan: {
          type: "agent",
          systemPrompt: "Plan.",
          tools: ["read"],
          skills: ["planning"],
          next: "approve_plan",
        },
        approve_plan: {
          type: "human",
          next: [
            { when: "approve_plan.decision == 'approve'", to: "build" },
            { to: "end" },
          ],
        },
        build: {
          type: "agent",
          tools: ["read", "write", "edit"],
          toolChoice: { mode: "required", tool: "edit" },
          next: "clone_repo",
        },
        clone_repo: {
          type: "tool",
          tool: "clone_repository",
          input: {
            repoUrl: "https://github.com/acme/app.git",
            targetDir: "workspace/app",
          },
          saveAs: "repo.clone",
          next: "end",
        },
      },
    });

    const normalized = normalizeProjectLoop(loop as ProjectLoopConfig);
    expect(Object.keys(normalized.loops)).toEqual(["plan", "build"]);
    expect(normalized.loops.build.toolChoice).toEqual({ mode: "required", tool: "edit" });
    expect(normalized.pipeline?.steps).toMatchObject([
      { loop: "plan" },
      { human: "approve_plan" },
      { switch: { cases: [{ when: "approve_plan.decision == 'approve'" }] } },
    ]);
    expect(JSON.stringify(normalized.pipeline?.steps)).toContain("clone_repository");
  });
});
