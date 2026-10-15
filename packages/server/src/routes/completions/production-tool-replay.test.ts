import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  ToolProgressTracker,
  combineChatSuggestions,
  resolveChatSuggestionPlan,
} from "@polpo-ai/core";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { CompletionRouteDeps } from "../completions.js";
import { runAgentStepCompletion } from "./agent-step-runner.js";
import { completionRequestSchema } from "./schemas.js";

interface ProductionReplay {
  id: string;
  source: { orderedEventsSha256: string };
  historical: { deliveryFrames: number; skillCalls: number };
  events: Array<{
    sequence: number;
    callId: string;
    name: "skill_read" | "skill_list";
    arguments: Record<string, unknown>;
    result: { sha256: string; bytes: number; kind: string };
  }>;
}

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./__fixtures__/prod-tool-001.sanitized.json",
  import.meta.url,
)), "utf8")) as ProductionReplay;
const deliveryFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./__fixtures__/prod-tool-001.delivery.sanitized.json",
  import.meta.url,
)), "utf8")) as {
  frameCount: number;
  sanitizedFramesSha256: string;
  frames: Array<{ sequence: number; type: string }>;
};
const negativeFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./__fixtures__/prod-negative-001.sanitized.json",
  import.meta.url,
)), "utf8")) as any;
const harnessFixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./__fixtures__/harness-001.sanitized.json",
  import.meta.url,
)), "utf8")) as any;
const manifest = JSON.parse(readFileSync(fileURLToPath(new URL(
  "./__fixtures__/production-failure-manifest.json",
  import.meta.url,
)), "utf8")) as any;

const stableRead = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
  resultStability: "stable",
} as const;

describe("PROD-TOOL-001 exact production replay", () => {
  it("keeps every retained production artifact explicitly classified", () => {
    expect(manifest.status).toBe("classified");
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries.map((entry: any) => entry.id)).toEqual([
      "PROD-TOOL-001",
      "PROD-NEGATIVE-001",
      "HARNESS-001",
    ]);
    expect(manifest.entries.every((entry: any) =>
      typeof entry.classification === "string" && entry.classification.length > 0
    )).toBe(true);
  });

  it("retains the exact ordered 4,758-frame delivery shape and terminal failure", () => {
    expect(deliveryFixture.frameCount).toBe(4758);
    expect(deliveryFixture.frames).toHaveLength(4758);
    expect(deliveryFixture.frames.every((frame, index) =>
      frame.sequence === index + 1
    )).toBe(true);
    expect(deliveryFixture.frames[0]).toMatchObject({ type: "run.started" });
    expect(deliveryFixture.frames.at(-1)).toMatchObject({ type: "run.failed" });
    expect(createHash("sha256")
      .update(JSON.stringify(deliveryFixture.frames))
      .digest("hex"))
      .toBe("dd4e38521747f791ee29b5ada4900601b399909f19d7c47495244ea3409cdd53");
  });

  it("retains the source evidence and exact ordered 200-call payload", () => {
    expect(fixture).toMatchObject({
      id: "PROD-TOOL-001",
      source: {
        orderedEventsSha256: "19b6b34836fa7539756e30d6fbb9df82773fa4b1e485502cad47340e1e456a4c",
      },
      historical: { deliveryFrames: 4758, skillCalls: 200 },
    });
    expect(fixture.events).toHaveLength(200);
    expect(fixture.events.filter((event) => event.name === "skill_read")).toHaveLength(198);
    expect(fixture.events.filter((event) => event.name === "skill_list")).toHaveLength(2);
    expect(fixture.events.filter((event) => event.result.kind === "error")).toHaveLength(3);
    expect(fixture.events.map((event) => event.sequence)).toEqual(
      [...fixture.events].map((event) => event.sequence).sort((a, b) => a - b),
    );
  });

  it("stops the recorded livelock without replaying stable executors", () => {
    const tracker = new ToolProgressTracker({ maxIdenticalObservations: 4 });
    let executions = 0;
    let reused = 0;
    let stoppedAt = -1;

    for (const [index, event] of fixture.events.entries()) {
      const call = { name: event.name, args: event.arguments, annotations: stableRead };
      const decision = tracker.inspect(call);
      if (decision.action === "stall") {
        stoppedAt = index;
        break;
      }
      if (decision.action === "reuse") {
        reused += 1;
        continue;
      }
      executions += 1;
      tracker.record({
        ...call,
        result: `${event.result.kind}:${event.result.bytes}:${event.result.sha256}`,
        isError: event.result.kind === "error",
      });
    }

    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(199);
    expect(executions).toBeLessThanOrEqual(12);
    expect(reused).toBeGreaterThan(0);
  });

  it("is mutation-sensitive to the exact repeated production call", () => {
    const locateFirstStall = (events: ProductionReplay["events"]): number => {
      const tracker = new ToolProgressTracker({ maxIdenticalObservations: 4 });
      for (const [index, event] of events.entries()) {
        const call = { name: event.name, args: event.arguments, annotations: stableRead };
        const decision = tracker.inspect(call);
        if (decision.action === "stall") return index;
        if (decision.action === "execute") {
          tracker.record({
            ...call,
            result: `${event.result.kind}:${event.result.bytes}:${event.result.sha256}`,
            isError: event.result.kind === "error",
          });
        }
      }
      return -1;
    };

    const productionStallIndex = locateFirstStall(fixture.events);
    expect(productionStallIndex).toBeGreaterThan(0);

    const mutatedEvents = fixture.events.map((event, index) => index === productionStallIndex
      ? {
          ...event,
          arguments: { ...event.arguments, path: "__mutation_breaks_identical_read__" },
        }
      : event);

    expect(locateFirstStall(mutatedEvents)).toBeGreaterThan(productionStallIndex);
  });

  it("bounds the actual agent-step runtime with the recorded ordered calls", async () => {
    const usage = {
      inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: undefined, reasoning: undefined },
    };
    let modelTurns = 0;
    let currentEvent = fixture.events[0]!;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        currentEvent = fixture.events[modelTurns]!;
        modelTurns += 1;
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: currentEvent.callId ?? `fixture-call-${modelTurns}`,
              toolName: currentEvent.name,
              input: JSON.stringify(currentEvent.arguments),
            },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage },
          ] as any[]),
        };
      },
    });
    const executor = vi.fn(async () =>
      `${currentEvent.result.kind}:${currentEvent.result.bytes}:${currentEvent.result.sha256}`);
    const deps = {
      getConfig: () => ({ settings: {} }),
      getMemoryStore: () => undefined,
      emit: vi.fn(),
      resolveAgentModel: vi.fn(async () => ({
        model: {
          id: "fixture/model",
          aiModel: model,
          provider: "fixture",
          contextWindow: 128_000,
          maxTokens: 4096,
        },
      })),
      resolveAgentTools: vi.fn(async () => ({
        tools: [
          {
            name: "skill_read",
            description: "Read a skill",
            annotations: stableRead,
            parameters: {
              type: "object",
              properties: { name: { type: "string" }, path: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
          {
            name: "skill_list",
            description: "List skills",
            annotations: stableRead,
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        executor,
      })),
      buildRuntimePrompt: vi.fn(async () => "system"),
    } as unknown as CompletionRouteDeps;

    await expect(runAgentStepCompletion({
      deps,
      agentConfig: { name: "leo", model: "fixture/model", maxTurns: 200 },
      aiMessages: [{ role: "user", content: "Create the design brief" }],
      extraSystemParts: [],
      context: {},
      stepName: "design_brief",
      runId: "looprun-MpCVStByYud63byN",
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string" } },
        required: ["summary"],
        additionalProperties: false,
      },
    })).rejects.toMatchObject({
      code: "tool_loop_stalled",
      stepName: "design_brief",
      details: expect.objectContaining({ phase: "tool_progress" }),
    });

    expect(modelTurns).toBeLessThan(200);
    expect(executor.mock.calls.length).toBeLessThanOrEqual(12);
    expect(deps.emit).toHaveBeenCalledWith(
      "runtime:tool-progress",
      expect.objectContaining({
        action: "stall",
        code: "tool_loop_stalled",
        runId: "looprun-MpCVStByYud63byN",
      }),
    );
  });
});

describe("classified production acceptance artifacts", () => {
  it("preserves PROD-NEGATIVE-001 as a pre-Run request rejection", () => {
    const parsed = completionRequestSchema.safeParse(negativeFixture.request);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected the retained request to be rejected");
    expect(parsed.error.issues).toContainEqual(expect.objectContaining({
      path: ["tool_choice"],
      message: negativeFixture.expected.message,
    }));
    expect(negativeFixture.expected).toMatchObject({
      httpStatus: 400,
      runCreated: false,
    });
  });

  it("preserves HARNESS-001 as five valid message suggestions with optional kind", () => {
    const plan = resolveChatSuggestionPlan(
      { enabled: true, maxItems: 5 },
      { enabled: true, maxItems: 5 },
    );
    const combined = combineChatSuggestions(plan, harnessFixture.response.suggestions);
    expect(combined).toHaveLength(5);
    expect(combined.every((suggestion) => suggestion.kind === undefined)).toBe(true);
    expect(harnessFixture.response).toMatchObject({
      beforeStop: true,
      beforeDone: true,
      done: true,
      persistedIdentically: true,
      replayedIdentically: true,
    });
  });
});
