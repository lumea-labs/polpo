import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pullProject } from "../src/util/pull.js";
import { readProjectAgents } from "@polpo-ai/file-stores";

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

      const agents = readProjectAgents(polpoDir);
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

  it("preserves the complete cloud agent contract across config and instructions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "polpo-pull-agent-"));
    const polpoDir = join(dir, ".polpo");
    const remote = {
      name: "builder",
      role: "Builder",
      model: { profile: "pro" },
      allowedModelProfiles: ["pro"],
      modelRouting: { mode: "auto" },
      chat: {
        allowUserQuestions: true,
        suggestions: {
          enabled: true,
          maxItems: 3,
          guidance: "Suggest concrete next actions.",
        },
      },
      memory: {
        tools: {
          search: true,
          remember: true,
          writeScope: "invocation-user",
          writableKinds: ["fact", "preference"],
        },
      },
      image_model: "fal/image",
      video_model: "fal/video",
      vision_model: "openai/vision",
      transcribe_model: "deepgram/nova-3",
      tts_model: "elevenlabs/multilingual-v2",
      search_provider: "exa",
      allowedTools: ["bash"],
      allowedPaths: ["/workspace"],
      systemPrompt: "Build carefully.\n",
      skills: ["frontend-design"],
      maxTurns: 30,
      maxConcurrency: 2,
      reasoning: "high",
      runtime: "node",
      assignedLoops: ["build"],
      executionRouter: { mode: "off" },
      reportsTo: "lead",
      browserProfile: "builder",
      emailAllowedDomains: ["example.com"],
      sandbox: {
        isolation: "fresh",
        lifecycle: { onRelease: "pool" },
        volumes: [
          { name: "workspace", access: "read-write", writeBack: "manual" },
          { name: "reference", access: "read-only" },
        ],
      },
      mcpServers: {
        docs: { type: "http", url: "https://example.com/mcp" },
      },
      teamName: "product",
      createdAt: "2026-08-06T00:00:00.000Z",
    };
    const client = {
      async get(path: string) {
        if (path === "/v1/agents") return { status: 200, data: { data: [remote] } };
        return { status: 200, data: { data: [] } };
      },
    };

    try {
      await pullProject(client as any, polpoDir, { force: true, interactive: false });
      const [entry] = readProjectAgents(polpoDir);
      expect(entry.teamName).toBe("product");
      expect(entry.agent).toEqual({
        ...remote,
        teamName: undefined,
        createdAt: undefined,
      });
      expect(await readFile(join(polpoDir, "agents", "builder", "instructions.md"), "utf-8"))
        .toBe("Build carefully.\n");
      const definition = JSON.parse(await readFile(
        join(polpoDir, "agents", "builder", "agent.json"),
        "utf-8",
      ));
      expect(definition).not.toHaveProperty("name");
      expect(definition).not.toHaveProperty("systemPrompt");
      expect(definition).not.toHaveProperty("createdAt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
