import { describe, expect, it, vi } from "vitest";
import {
  ModelRouteCancelledError,
  modelRouteRuntimePlanFields,
  resolveModelRoute,
  type ModelRouteClassifier,
  type ResolveModelRouteInput,
} from "../model-router.js";

const profiles = {
  fast: "openai/gpt-4o-mini",
  balanced: {
    primary: "anthropic/claude-sonnet-4",
    fallbacks: [{ profile: "fast" as const }],
  },
  reasoning: "openai/gpt-5",
};

function input(
  overrides: Partial<ResolveModelRouteInput> = {},
): ResolveModelRouteInput {
  return {
    surface: "agent",
    source: "request",
    input: "Compare the evidence carefully and explain the conclusion.",
    profiles,
    config: {
      mode: "auto",
      fallbackProfile: "balanced",
      allowedProfiles: ["fast", "balanced", "reasoning"],
      minConfidence: 0.7,
      timeoutMs: 50,
    },
    ...overrides,
  };
}

function classifier(value: unknown): ModelRouteClassifier {
  return {
    classify: vi.fn(async () => value),
  };
}

describe("resolveModelRoute", () => {
  it("selects an allowed profile and resolves its concrete model policy", async () => {
    const classify = classifier({
      profile: "reasoning",
      confidence: 0.92,
      reason: "The request requires careful multi-step reasoning.",
      labels: ["reasoning", "analysis"],
    });

    const result = await resolveModelRoute(input(), { classifier: classify });

    expect(result).toEqual({
      status: "routed",
      source: "router",
      profile: "reasoning",
      selection: "openai/gpt-5",
      confidence: 0.92,
      reason: "The request requires careful multi-step reasoning.",
      labels: ["reasoning", "analysis"],
      latencyMs: expect.any(Number),
      fallbackUsed: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.labels)).toBe(true);
    expect(classify.classify).toHaveBeenCalledWith({
      version: 1,
      surface: "agent",
      source: "request",
      input: "Compare the evidence carefully and explain the conclusion.",
      profiles: ["fast", "balanced", "reasoning"],
      labels: [],
    }, {
      signal: expect.any(AbortSignal),
    });
  });

  it("maps the route into auditable Runtime Plan fields without raw classifier output", async () => {
    const route = await resolveModelRoute(input(), {
      classifier: classifier({
        profile: "reasoning",
        confidence: 0.92,
        reason: "The request requires careful multi-step reasoning.",
        labels: ["reasoning"],
      }),
    });

    expect(modelRouteRuntimePlanFields(route)).toEqual({
      model: {
        selection: "openai/gpt-5",
        profile: "reasoning",
        source: "router",
      },
      audit: {
        reasons: ["The request requires careful multi-step reasoning."],
        warnings: [],
        confidence: 0.92,
        fallbackUsed: false,
        latencyMs: {
          modelRouter: route.latencyMs,
        },
      },
    });
  });

  it("gives an explicit allowed profile precedence without invoking the classifier", async () => {
    const classify = classifier({
      profile: "reasoning",
      confidence: 1,
      reason: "Should not run",
      labels: [],
    });

    const result = await resolveModelRoute(input({
      explicitProfile: "fast",
    }), { classifier: classify });

    expect(result).toMatchObject({
      status: "explicit",
      source: "request",
      profile: "fast",
      selection: "openai/gpt-4o-mini",
      confidence: 1,
      fallbackUsed: false,
    });
    expect(classify.classify).not.toHaveBeenCalled();
  });

  it("cannot use an explicit or classified profile outside the allowlist", async () => {
    await expect(resolveModelRoute(input({
      explicitProfile: "reasoning",
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
      },
    }), {
      classifier: classifier({
        profile: "fast",
        confidence: 1,
        reason: "Allowed",
        labels: [],
      }),
    })).rejects.toMatchObject({ code: "DISALLOWED_PROFILE" });

    const result = await resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
      },
    }), {
      classifier: classifier({
        profile: "reasoning",
        confidence: 1,
        reason: "Attempted widening",
        labels: [],
      }),
    });

    expect(result).toMatchObject({
      status: "fallback",
      source: "router",
      profile: "balanced",
      fallbackUsed: true,
      reason: "Model router returned an invalid decision",
    });
  });

  it.each([
    {
      name: "a raw model id",
      output: {
        profile: "openai/gpt-5",
        confidence: 0.9,
        reason: "Raw model",
        labels: [],
      },
    },
    {
      name: "extra fields",
      output: {
        profile: "reasoning",
        confidence: 0.9,
        reason: "Unexpected field",
        labels: [],
        model: "openai/gpt-5",
      },
    },
    {
      name: "an invalid confidence",
      output: {
        profile: "reasoning",
        confidence: 4,
        reason: "Invalid confidence",
        labels: [],
      },
    },
    {
      name: "an empty reason",
      output: {
        profile: "reasoning",
        confidence: 0.9,
        reason: " ",
        labels: [],
      },
    },
    {
      name: "invalid JSON",
      output: "{\"profile\":\"reasoning\"",
    },
  ])("falls back for $name", async ({ output }) => {
    const result = await resolveModelRoute(input(), {
      classifier: classifier(output),
    });

    expect(result).toMatchObject({
      status: "fallback",
      source: "router",
      profile: "balanced",
      selection: {
        primary: "anthropic/claude-sonnet-4",
        fallbacks: ["openai/gpt-4o-mini"],
      },
      reason: "Model router returned an invalid decision",
      fallbackUsed: true,
    });
  });

  it("accepts strict JSON text but still validates the selected profile", async () => {
    const result = await resolveModelRoute(input(), {
      classifier: classifier(JSON.stringify({
        profile: "fast",
        confidence: 0.88,
        reason: "A short latency-sensitive request.",
        labels: ["latency"],
      })),
    });

    expect(result).toMatchObject({
      status: "routed",
      profile: "fast",
      selection: "openai/gpt-4o-mini",
      confidence: 0.88,
      fallbackUsed: false,
    });
  });

  it("falls back deterministically below the confidence threshold", async () => {
    const result = await resolveModelRoute(input(), {
      classifier: classifier({
        profile: "reasoning",
        confidence: 0.69,
        reason: "Uncertain",
        labels: ["reasoning"],
      }),
    });

    expect(result).toMatchObject({
      status: "fallback",
      source: "router",
      profile: "balanced",
      confidence: 0.69,
      reason: "Model router confidence was below 0.7",
      fallbackUsed: true,
    });
  });

  it("falls back on timeout, aborts the classifier, and ignores a late result", async () => {
    let signal: AbortSignal | undefined;
    let resolveLate: ((value: unknown) => void) | undefined;
    const classify = vi.fn((_input, options) => {
      signal = options.signal;
      return new Promise<unknown>((resolve) => {
        resolveLate = resolve;
      });
    });

    const result = await resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced", "reasoning"],
        timeoutMs: 5,
      },
    }), { classifier: { classify } });

    expect(signal?.aborted).toBe(true);
    expect(result).toMatchObject({
      status: "fallback",
      profile: "balanced",
      reason: "Model router timed out after 5ms",
      fallbackUsed: true,
    });

    resolveLate?.({
      profile: "reasoning",
      confidence: 1,
      reason: "Too late",
      labels: [],
    });
    await Promise.resolve();
    expect(result.profile).toBe("balanced");
  });

  it("propagates caller cancellation and never converts it into execution fallback", async () => {
    const abort = new AbortController();
    let classifierSignal: AbortSignal | undefined;
    const classify = vi.fn((_input, options) => {
      classifierSignal = options.signal;
      return new Promise<unknown>(() => {});
    });

    const pending = resolveModelRoute(input(), {
      classifier: { classify },
      signal: abort.signal,
    });
    abort.abort("client disconnected");

    await expect(pending).rejects.toBeInstanceOf(ModelRouteCancelledError);
    expect(classifierSignal?.aborted).toBe(true);
  });

  it("does not start classification when the caller signal is already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    const classify = classifier({
      profile: "fast",
      confidence: 1,
      reason: "Should not run",
      labels: [],
    });

    await expect(resolveModelRoute(input(), {
      classifier: classify,
      signal: abort.signal,
    })).rejects.toBeInstanceOf(ModelRouteCancelledError);
    expect(classify.classify).not.toHaveBeenCalled();
  });

  it("clears the deadline after a successful decision", async () => {
    let classifierSignal: AbortSignal | undefined;
    const result = await resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
        timeoutMs: 5,
      },
    }), {
      classifier: {
        classify: async (_classifierInput, options) => {
          classifierSignal = options.signal;
          return {
            profile: "fast",
            confidence: 1,
            reason: "Fast route",
            labels: [],
          };
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.status).toBe("routed");
    expect(classifierSignal?.aborted).toBe(false);
  });

  it("does not invoke the classifier when disabled, deterministic, or input is empty", async () => {
    const classify = classifier({
      profile: "reasoning",
      confidence: 1,
      reason: "Should not run",
      labels: [],
    });

    const disabled = await resolveModelRoute(input({
      config: {
        mode: "off",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
      },
    }), { classifier: classify });
    const deterministic = await resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "fast",
        allowedProfiles: ["fast"],
      },
    }), { classifier: classify });
    const empty = await resolveModelRoute(input({ input: "  " }), {
      classifier: classify,
    });

    expect(disabled).toMatchObject({
      status: "disabled",
      source: "agent",
      profile: "balanced",
      fallbackUsed: false,
    });
    expect(deterministic).toMatchObject({
      status: "skipped",
      profile: "fast",
      reason: "Only one model profile is allowed",
      fallbackUsed: false,
    });
    expect(empty).toMatchObject({
      status: "skipped",
      profile: "balanced",
      reason: "Model router input was empty",
      fallbackUsed: false,
    });
    expect(classify.classify).not.toHaveBeenCalled();
  });

  it("bounds compact classifier input and never forwards profile definitions", async () => {
    const classify = classifier({
      profile: "balanced",
      confidence: 0.9,
      reason: "Balanced route",
      labels: [],
    });
    const secret = "sk-super-secret";
    const history = "previous private history";

    await resolveModelRoute(input({
      input: `current request ${"x".repeat(10_000)}`,
      labels: ["channel", "channel", "x".repeat(200)],
      profiles: {
        ...profiles,
        private: `${secret}/${history}`,
      },
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced", "reasoning"],
        maxInputChars: 128,
      },
    }), { classifier: classify });

    const classifierInput = vi.mocked(classify.classify).mock.calls[0]?.[0];
    expect(classifierInput.input).toHaveLength(128);
    expect(classifierInput.profiles).toEqual(["fast", "balanced", "reasoning"]);
    expect(classifierInput.labels).toEqual(["channel", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]);
    const serialized = JSON.stringify(classifierInput);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(history);
    expect(serialized).not.toContain("openai/gpt");
    expect(serialized).not.toContain("anthropic/claude");
  });

  it("falls back on classifier failure without leaking its error into audit text", async () => {
    const result = await resolveModelRoute(input(), {
      classifier: {
        classify: async () => {
          throw new Error("Bearer sk-private-provider-error");
        },
      },
    });

    expect(result).toMatchObject({
      status: "fallback",
      profile: "balanced",
      reason: "Model router classifier failed",
      fallbackUsed: true,
    });
    expect(JSON.stringify(result)).not.toContain("sk-private-provider-error");
  });

  it("rejects invalid configuration before invoking a classifier", async () => {
    const classify = classifier({
      profile: "fast",
      confidence: 1,
      reason: "Should not run",
      labels: [],
    });

    await expect(resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "missing",
        allowedProfiles: ["fast", "balanced"],
      },
    }), { classifier: classify })).rejects.toMatchObject({
      code: "DISALLOWED_PROFILE",
    });
    await expect(resolveModelRoute(input({
      config: {
        mode: "auto",
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
        timeoutMs: -1,
      },
    }), { classifier: classify })).rejects.toThrow("timeoutMs");
    await expect(resolveModelRoute(input({
      config: {
        mode: "future" as never,
        fallbackProfile: "balanced",
        allowedProfiles: ["fast", "balanced"],
      },
    }), { classifier: classify })).rejects.toThrow("mode");
    expect(classify.classify).not.toHaveBeenCalled();
  });
});
