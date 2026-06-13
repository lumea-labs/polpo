import { describe, expect, it } from "vitest";
import { completionRoutes, type CompletionRouteDeps } from "./completions.js";

describe("completionRoutes project loop runtime", () => {
  function makeDeps(): CompletionRouteDeps {
    let now = 100;
    return {
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
  }

  it("executes an assigned default project loop and returns shared tool context", async () => {
    const deps = makeDeps();

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
    expect(json.loop_trace.map((event: any) => event.type)).toEqual([
      "loop.start",
      "tool.call",
      "tool.result",
      "transition",
      "tool.call",
      "tool.result",
      "loop.end",
    ]);
    expect(json.loop_trace[0]).toMatchObject({ loop: "time-tracker", status: "started" });
  });

  it("streams project loop step tool call events", async () => {
    const app = completionRoutes(() => makeDeps());
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        stream: true,
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-loop")).toBe("time-tracker");
    const body = await res.text();
    const chunks = body
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("data: "))
      .map((block) => block.slice("data: ".length))
      .filter((data) => data !== "[DONE]")
      .map((data) => JSON.parse(data));
    const toolEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.tool_call)
      .filter(Boolean);
    const traceEvents = chunks
      .map((chunk) => chunk.choices?.[0]?.loop_trace)
      .filter(Boolean);

    expect(toolEvents.map((event: any) => event.state)).toContain("calling");
    expect(toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "unix_time", result: "100", state: "completed" }),
        expect.objectContaining({ name: "unix_time", result: "105", state: "completed" }),
      ]),
    );
    expect(traceEvents.map((event: any) => event.type)).toContain("tool.call");
    expect(traceEvents.map((event: any) => event.type)).toContain("loop.end");
  });
});
