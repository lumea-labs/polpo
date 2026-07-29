import { describe, expect, it, vi } from "vitest";
import {
  ExecutionRouteCancelledError,
  compileExecutionRouteManifest,
  createExplicitExecutionRoute,
  createExecutionRouteResolvedEvent,
  executionRouteRuntimePlanFields,
  resolveExecutionRoute,
  validateExecutionRouterConfig,
  type ExecutionRouteClassifier,
  type ProjectLoopConfig,
} from "../index.js";

const projectLoops: ProjectLoopConfig[] = [
  {
    name: "research",
    label: "Research",
    description: "Investigate sources and produce a cited answer.",
    metadata: { credential: "PRIVATE METADATA" },
    start: "collect",
    steps: {
      collect: {
        type: "agent",
        tools: ["search_web"],
        systemPrompt: "PRIVATE STEP PROMPT",
        next: "end",
      },
    },
  },
  {
    name: "build",
    label: "Build",
    description: "Create or modify project files.",
    start: "implement",
    steps: {
      implement: {
        type: "agent",
        tools: ["bash", "write"],
        next: "end",
      },
    },
  },
];

function manifest() {
  return compileExecutionRouteManifest({
    assignedLoops: ["research", "missing", "build", "research"],
    projectLoops,
  });
}

function classifier(
  value: unknown,
  inspect?: (input: unknown, signal: AbortSignal) => void,
): ExecutionRouteClassifier {
  return {
    classify: async (input, options) => {
      inspect?.(input, options.signal);
      return value;
    },
  };
}

describe("execution router configuration", () => {
  it("validates persisted settings at the host boundary", () => {
    expect(() => validateExecutionRouterConfig({
      mode: "auto",
      allowedLoops: ["research"],
      minConfidence: 0.8,
    })).not.toThrow();
    expect(() => validateExecutionRouterConfig({
      mode: "auto",
      allowedLoops: [],
    })).toThrow("requires at least one allowed loop");
  });
});

describe("compileExecutionRouteManifest", () => {
  it("keeps assignment order, deduplicates, reports missing loops, and strips private config", () => {
    const compiled = manifest();

    expect(compiled).toEqual({
      version: 1,
      loops: [
        {
          name: "research",
          label: "Research",
          description: "Investigate sources and produce a cited answer.",
        },
        {
          name: "build",
          label: "Build",
          description: "Create or modify project files.",
        },
      ],
      unresolvedLoops: ["missing"],
    });
    expect(JSON.stringify(compiled)).not.toContain("PRIVATE");
    expect(JSON.stringify(compiled)).not.toContain("search_web");
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.loops)).toBe(true);
    expect(Object.isFrozen(compiled.loops[0])).toBe(true);
  });

  it("ignores loaded loops that are not assigned and rejects malformed inputs", () => {
    expect(compileExecutionRouteManifest({
      assignedLoops: ["research"],
      projectLoops: [...projectLoops, {
        name: "admin",
        description: "Must never become a candidate.",
        start: "run",
        steps: { run: { type: "agent", next: "end" } },
      }],
    }).loops.map((loop) => loop.name)).toEqual(["research"]);

    expect(() => compileExecutionRouteManifest({
      assignedLoops: ["research", 42] as any,
      projectLoops,
    })).toThrow("assignedLoops");
    expect(() => compileExecutionRouteManifest({
      assignedLoops: ["research"],
      projectLoops: [{ ...projectLoops[0], name: " research " }],
    })).toThrow("name");
  });
});

describe("resolveExecutionRoute", () => {
  it("rejects invalid trusted invocation identity before classifier work", async () => {
    const classify = vi.fn();

    await expect(resolveExecutionRoute({
      surface: "admin" as any,
      source: "request",
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, { classifier: { classify } })).rejects.toThrow("surface");
    await expect(resolveExecutionRoute({
      surface: "agent",
      source: "browser" as any,
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, { classifier: { classify } })).rejects.toThrow("source");

    expect(classify).not.toHaveBeenCalled();
  });

  it("is off by default and never resolves a classifier", async () => {
    const resolveClassifier = vi.fn(async () =>
      classifier({ mode: "loop", loop: "research", confidence: 1, reason: "route" }));

    const route = await resolveExecutionRoute({
      surface: "channel",
      source: "channel",
      input: "Research this topic",
      manifest: manifest(),
      config: { allowedLoops: ["research"] },
    }, { resolveClassifier });

    expect(route).toMatchObject({
      surface: "channel",
      invocationSource: "channel",
      status: "disabled",
      decisionSource: "default",
      mode: "direct",
      reason: "Execution router is disabled",
      latencyMs: 0,
      fallbackUsed: false,
    });
    expect(resolveClassifier).not.toHaveBeenCalled();
  });

  it("lets an authorized explicit loop win without classifier work", async () => {
    const resolveClassifier = vi.fn();
    const route = await resolveExecutionRoute({
      surface: "task",
      source: "task",
      input: "Do the work",
      explicitLoop: "build",
      manifest: manifest(),
      config: {
        mode: "auto",
        allowedLoops: ["research"],
      },
    }, { resolveClassifier });

    expect(route).toMatchObject({
      status: "explicit",
      decisionSource: "request",
      mode: "loop",
      loop: "build",
      confidence: 1,
      fallbackUsed: false,
    });
    expect(resolveClassifier).not.toHaveBeenCalled();
  });

  it("rejects an explicit loop that is not in the authorized manifest", async () => {
    await expect(resolveExecutionRoute({
      surface: "agent",
      source: "request",
      explicitLoop: "admin",
      manifest: manifest(),
      config: { mode: "off", allowedLoops: [] },
    })).rejects.toThrow('Explicit loop "admin" is not authorized');
  });

  it("routes only to the intersection of assigned and router-allowed loops", async () => {
    const inspect = vi.fn();
    const route = await resolveExecutionRoute({
      surface: "webhook",
      source: "internal",
      input: "Build a landing page",
      labels: ["premium", " premium ", "channel:telegram"],
      manifest: manifest(),
      config: {
        mode: "auto",
        allowedLoops: ["build", "not-assigned"],
        minConfidence: 0.75,
      },
    }, {
      classifier: classifier(
        { mode: "loop", loop: "build", confidence: 0.91, reason: "Needs file changes" },
        (input, signal) => inspect(input, signal),
      ),
    });

    expect(route).toMatchObject({
      status: "routed",
      decisionSource: "router",
      mode: "loop",
      loop: "build",
      confidence: 0.91,
      reason: "Needs file changes",
      fallbackUsed: false,
    });
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0][0]).toEqual({
      version: 1,
      surface: "webhook",
      source: "internal",
      input: "Build a landing page",
      loops: [{
        name: "build",
        label: "Build",
        description: "Create or modify project files.",
      }],
      labels: ["premium", "channel:telegram"],
    });
    expect(Object.isFrozen(inspect.mock.calls[0][0])).toBe(true);
  });

  it("accepts a confident direct decision", async () => {
    const route = await resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Say hello",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research", "build"] },
    }, {
      classifier: classifier({
        mode: "direct",
        confidence: 0.98,
        reason: "A normal reply is sufficient",
      }),
    });

    expect(route).toMatchObject({
      status: "routed",
      decisionSource: "router",
      mode: "direct",
      confidence: 0.98,
      fallbackUsed: false,
    });
    expect(route).not.toHaveProperty("loop");
  });

  it.each([
    ["low confidence", { mode: "loop", loop: "research", confidence: 0.2, reason: "Maybe" }],
    ["unknown loop", { mode: "loop", loop: "admin", confidence: 0.99, reason: "Unsafe" }],
    ["missing loop", { mode: "loop", confidence: 0.99, reason: "Malformed" }],
    ["loop on direct", { mode: "direct", loop: "research", confidence: 0.99, reason: "Malformed" }],
    ["extra fields", { mode: "direct", confidence: 0.99, reason: "Malformed", model: "secret/model" }],
    ["missing confidence", { mode: "direct", reason: "Malformed" }],
    ["invalid confidence", { mode: "direct", confidence: Number.NaN, reason: "Malformed" }],
    ["empty reason", { mode: "direct", confidence: 0.99, reason: "  " }],
    ["non-object", "direct"],
  ])("falls back to direct for %s", async (_label, decision) => {
    const route = await resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Do something",
      manifest: manifest(),
      config: {
        mode: "auto",
        allowedLoops: ["research", "build"],
        minConfidence: 0.8,
      },
    }, { classifier: classifier(decision) });

    expect(route.mode).toBe("direct");
    expect(route.status).toBe("fallback");
    expect(route.decisionSource).toBe("router");
    expect(route.fallbackUsed).toBe(true);
    expect(route).not.toHaveProperty("loop");
  });

  it("skips classification for no candidates, empty input, and unavailable classifier", async () => {
    const resolveClassifier = vi.fn(async () => undefined);
    const noCandidates = await resolveExecutionRoute({
      surface: "task",
      source: "task",
      input: "Run",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["not-assigned"] },
    }, { resolveClassifier });
    expect(noCandidates).toMatchObject({ status: "skipped", mode: "direct", fallbackUsed: false });
    expect(resolveClassifier).not.toHaveBeenCalled();

    const emptyInput = await resolveExecutionRoute({
      surface: "task",
      source: "task",
      input: " \n ",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["build"] },
    }, { resolveClassifier });
    expect(emptyInput.reason).toBe("Execution router input was empty");
    expect(resolveClassifier).not.toHaveBeenCalled();

    const unavailable = await resolveExecutionRoute({
      surface: "task",
      source: "task",
      input: "Build",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["build"] },
    }, { resolveClassifier });
    expect(unavailable.reason).toBe("Execution router classifier is unavailable");
    expect(resolveClassifier).toHaveBeenCalledOnce();
  });

  it("bounds classifier data and never forwards loop internals", async () => {
    let seen: any;
    const route = await resolveExecutionRoute({
      surface: "channel",
      source: "channel",
      input: `  ${"x".repeat(10_000)}  `,
      labels: Array.from({ length: 40 }, (_, index) => `label-${index}-${"y".repeat(100)}`),
      manifest: manifest(),
      config: {
        mode: "auto",
        allowedLoops: ["research"],
        maxInputChars: 128,
      },
    }, {
      classifier: classifier(
        { mode: "direct", confidence: 1, reason: "Direct" },
        (input) => { seen = input; },
      ),
    });

    expect(route.mode).toBe("direct");
    expect(seen.input).toHaveLength(128);
    expect(seen.labels).toHaveLength(16);
    expect(seen.labels.every((label: string) => label.length <= 64)).toBe(true);
    expect(JSON.stringify(seen)).not.toContain("PRIVATE");
    expect(JSON.stringify(seen)).not.toContain("search_web");
    expect(JSON.stringify(seen)).not.toContain("secret/model");
  });

  it("times out, aborts the classifier, and ignores a late result", async () => {
    let classifierSignal: AbortSignal | undefined;
    let finish!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { finish = resolve; });

    const route = await resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Research",
      manifest: manifest(),
      config: {
        mode: "auto",
        allowedLoops: ["research"],
        timeoutMs: 5,
      },
    }, {
      classifier: {
        classify: async (_input, options) => {
          classifierSignal = options.signal;
          return pending;
        },
      },
    });

    expect(route).toMatchObject({
      status: "fallback",
      mode: "direct",
      fallbackUsed: true,
    });
    expect(route.reason).toContain("timed out");
    expect(classifierSignal?.aborted).toBe(true);
    finish({ mode: "loop", loop: "research", confidence: 1, reason: "Late" });
    await Promise.resolve();
    expect(route.mode).toBe("direct");
  });

  it("propagates caller cancellation and aborts classifier work", async () => {
    const caller = new AbortController();
    let classifierSignal: AbortSignal | undefined;
    const running = resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, {
      signal: caller.signal,
      classifier: {
        classify: async (_input, options) => {
          classifierSignal = options.signal;
          return new Promise(() => {});
        },
      },
    });

    caller.abort();
    await expect(running).rejects.toBeInstanceOf(ExecutionRouteCancelledError);
    expect(classifierSignal?.aborted).toBe(true);
  });

  it("fails safely on classifier factory and classifier errors", async () => {
    const factoryFailure = await resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, {
      resolveClassifier: async () => {
        throw new Error("provider secret");
      },
    });
    expect(factoryFailure).toMatchObject({
      mode: "direct",
      status: "fallback",
      reason: "Execution router classifier failed",
      fallbackUsed: true,
    });
    expect(factoryFailure.reason).not.toContain("secret");

    const classifierFailure = await resolveExecutionRoute({
      surface: "agent",
      source: "request",
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, {
      classifier: {
        classify: async () => {
          throw new Error("credential leaked by provider");
        },
      },
    });
    expect(classifierFailure.reason).toBe("Execution router classifier failed");
  });

  it("rejects unsafe configuration before classifier work", async () => {
    const classify = vi.fn();
    const cases = [
      { mode: "invalid", allowedLoops: ["research"] },
      { mode: "auto", allowedLoops: "research" },
      { mode: "auto", allowedLoops: [] },
      { mode: "auto", allowedLoops: ["research"], minConfidence: 2 },
      { mode: "auto", allowedLoops: ["research"], timeoutMs: 0 },
      { mode: "auto", allowedLoops: ["research"], maxInputChars: 100_000 },
      { mode: "auto", allowedLoops: ["research"], model: "private/model" },
    ];

    for (const config of cases) {
      await expect(resolveExecutionRoute({
        surface: "agent",
        source: "request",
        input: "Research",
        manifest: manifest(),
        config: config as any,
      }, { classifier: { classify } })).rejects.toThrow();
    }
    expect(classify).not.toHaveBeenCalled();
  });

  it("returns immutable plan fields and a surface-preserving event", async () => {
    const route = await resolveExecutionRoute({
      surface: "channel",
      source: "channel",
      input: "Research",
      manifest: manifest(),
      config: { mode: "auto", allowedLoops: ["research"] },
    }, {
      classifier: classifier({
        mode: "loop",
        loop: "research",
        confidence: 0.95,
        reason: "Needs source collection",
      }),
    });
    const fields = executionRouteRuntimePlanFields(route);
    const event = createExecutionRouteResolvedEvent(route);

    expect(fields).toEqual({
      execution: {
        mode: "loop",
        loop: "research",
        source: "router",
      },
      audit: {
        reasons: ["Needs source collection"],
        warnings: [],
        confidence: 0.95,
        fallbackUsed: false,
      },
    });
    expect(event).toEqual({
      type: "runtime.execution_route.resolved",
      route,
    });
    expect(event.route.surface).toBe("channel");
    expect(event.route.invocationSource).toBe("channel");
    expect(Object.isFrozen(route)).toBe(true);
    expect(Object.isFrozen(fields)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
  });
});

describe("createExplicitExecutionRoute", () => {
  it("creates the same immutable request decision for inline and project loops", () => {
    const route = createExplicitExecutionRoute({
      surface: "channel",
      source: "channel",
      loop: "legacy-inline",
    });

    expect(route).toEqual({
      surface: "channel",
      invocationSource: "channel",
      status: "explicit",
      decisionSource: "request",
      mode: "loop",
      loop: "legacy-inline",
      confidence: 1,
      reason: "Explicit loop request",
      latencyMs: 0,
      fallbackUsed: false,
    });
    expect(Object.isFrozen(route)).toBe(true);
  });

  it("rejects malformed invocation identity, loop names, and reasons", () => {
    expect(() => createExplicitExecutionRoute({
      surface: "task",
      source: "request",
      loop: " build ",
    })).toThrow("loop");
    expect(() => createExplicitExecutionRoute({
      surface: "invalid" as any,
      source: "request",
      loop: "build",
    })).toThrow("surface");
    expect(() => createExplicitExecutionRoute({
      surface: "task",
      source: "invalid" as any,
      loop: "build",
    })).toThrow("source");
    expect(() => createExplicitExecutionRoute({
      surface: "task",
      source: "task",
      loop: "build",
      reason: "",
    })).toThrow("reason");
  });
});
