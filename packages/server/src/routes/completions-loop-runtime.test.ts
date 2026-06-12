import { describe, expect, it } from "vitest";
import { completionRoutes, type CompletionRouteDeps } from "./completions.js";

describe("completionRoutes project loop runtime", () => {
  it("executes an assigned default project loop and returns shared tool context", async () => {
    let now = 100;
    const deps: CompletionRouteDeps = {
      getAgents: async () => [{
        name: "timer",
        model: "test",
        assignedLoops: ["time-tracker"],
        defaultLoop: "time-tracker",
        allowedTools: ["unix_time"],
      }],
      getConfig: () => ({}),
      getMemoryStore: () => null,
      getSessionStore: () => null,
      getStore: () => null,
      emit: () => {},
      buildAgentPrompt: () => {
        throw new Error("tool-only project loop should not build an agent prompt");
      },
      resolveAgentModel: async () => {
        throw new Error("tool-only project loop should not resolve a model");
      },
      resolveAgentTools: async () => ({
        tools: [],
        executor: async (name) => {
          if (name !== "unix_time") return `Error: Unknown tool "${name}"`;
          const value = now;
          now += 5;
          return String(value);
        },
      }),
      getProjectLoop: async (name) => ({
        name,
        context: "shared",
        start: "capture_start",
        steps: {
          capture_start: {
            type: "tool",
            tool: "unix_time",
            saveAs: "timing.start",
            next: "capture_end",
          },
          capture_end: {
            type: "tool",
            tool: "unix_time",
            saveAs: "timing.end",
            next: "end",
          },
        },
      }),
    };

    const app = completionRoutes(() => deps);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-loop")).toBe("time-tracker");
    const json = await res.json() as any;
    expect(json.choices[0].message.content).toContain('"timing"');
    expect(JSON.parse(json.choices[0].message.content)).toEqual({
      timing: {
        start: "100",
        end: "105",
      },
    });
  });
});
