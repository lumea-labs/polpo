import { describe, expect, it } from "vitest";
import { completionRoutes, type CompletionRouteDeps } from "./completions.js";

describe("completionRoutes project loop runtime", () => {
  function makeDeps(projectLoop?: any): CompletionRouteDeps {
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
        executor: async (name, args) => {
          if (name === "audit_step") return JSON.stringify({ ok: true, args });
          if (name !== "unix_time") return `Error: Unknown tool "${name}"`;
          const value = now;
          now += 5;
          return String(value);
        },
      }),
      getProjectLoop: async (name) => projectLoop ?? ({
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

  it("executes project loop hook tool actions through the completion runtime", async () => {
    const app = completionRoutes(() => makeDeps({
      name: "time-tracker",
      context: "shared",
      start: "capture_start",
      hooks: {
        "tool:after": [{ tool: "audit_step", input: { source: "hook" }, saveAs: "audit.last" }],
      },
      steps: {
        capture_start: {
          type: "tool",
          tool: "unix_time",
          saveAs: "timing.start",
          next: "end",
        },
      },
    }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(JSON.parse(json.choices[0].message.content)).toMatchObject({
      timing: { start: "100" },
      audit: { last: { ok: true, args: { source: "hook" } } },
    });
    expect(json.loop_trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool.call", tool: "audit_step", data: expect.objectContaining({ hook: "tool:after" }) }),
        expect.objectContaining({ type: "tool.result", tool: "audit_step", data: expect.objectContaining({ hook: "tool:after" }) }),
      ]),
    );
  });

  it("blocks project loop execution when a runtime policy denies a lifecycle point", async () => {
    const app = completionRoutes(() => makeDeps({
      name: "time-tracker",
      context: "shared",
      start: "capture_start",
      policies: [
        { id: "block-time", effect: "deny", hook: "tool:before", when: "tool.name == 'unix_time'", message: "time capture disabled" },
      ],
      steps: {
        capture_start: {
          type: "tool",
          tool: "unix_time",
          saveAs: "timing.start",
          next: "end",
        },
      },
    }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "timer",
        messages: [{ role: "user", content: "track it" }],
      }),
    });

    expect(res.status).toBe(403);
    const json = await res.json() as any;
    expect(json.error).toMatchObject({
      type: "loop_runtime_error",
      code: "loop_policy_blocked",
      message: 'Loop policy "block-time" denied tool:before: time capture disabled',
    });
  });
});
