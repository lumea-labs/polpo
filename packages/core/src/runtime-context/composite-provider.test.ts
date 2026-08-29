import { describe, expect, it, vi } from "vitest";
import {
  createCompositeRuntimeContextProvider,
} from "./composite-provider.js";
import type {
  RuntimeContextProvider,
  RuntimeContextRetrievalInput,
} from "./types.js";

function input(
  tokenBudget = 1_000,
  signal?: AbortSignal,
): RuntimeContextRetrievalInput {
  return {
    agentName: "support",
    query: "Customer refund policy",
    surface: "agent",
    source: "request",
    tokenBudget,
    ...(signal ? { signal } : {}),
  };
}

function provider(
  tokenBudget: number,
  retrieve: RuntimeContextProvider["retrieve"],
): RuntimeContextProvider {
  return { tokenBudget, retrieve };
}

describe("createCompositeRuntimeContextProvider", () => {
  it("retrieves providers concurrently with bounded budgets and stable output order", async () => {
    const calls: string[] = [];
    let releaseMemory!: () => void;
    let releaseBrain!: () => void;
    const memoryReady = new Promise<void>((resolve) => {
      releaseMemory = resolve;
    });
    const brainReady = new Promise<void>((resolve) => {
      releaseBrain = resolve;
    });
    const memory = vi.fn(async (value: RuntimeContextRetrievalInput) => {
      calls.push(`memory:${value.tokenBudget}`);
      releaseMemory();
      await brainReady;
      return {
        segments: [{
          kind: "memory" as const,
          entries: [{
            id: "memory-a",
            content: "Prefers concise answers.",
            source: { type: "memory" as const, id: "memory-a" },
            timestamp: "2026-07-31T10:00:00.000Z",
            trust: "user_provided" as const,
          }],
        }],
        legacyMemory: { agent: "replace" as const },
      };
    });
    const brain = vi.fn(async (value: RuntimeContextRetrievalInput) => {
      calls.push(`brain:${value.tokenBudget}`);
      releaseBrain();
      await memoryReady;
      return {
        segments: [{
          kind: "brain" as const,
          entries: [{
            id: "chunk-a",
            content: "Refunds require approval.",
            source: { type: "brain" as const, id: "handbook" },
            timestamp: "2026-07-31T09:00:00.000Z",
            version: "v2",
            trust: "trusted" as const,
            citation: {
              handle: "handbook@v2#chunk-a",
              sourceId: "handbook",
              version: "v2",
            },
          }],
        }],
        legacyMemory: { shared: "replace" as const },
      };
    });
    const composite = createCompositeRuntimeContextProvider({
      tokenBudget: 1_200,
      providers: [
        provider(400, memory),
        provider(900, brain),
      ],
    });

    await expect(composite.retrieve(input(1_000))).resolves.toMatchObject({
      segments: [
        { kind: "memory", entries: [{ id: "memory-a" }] },
        { kind: "brain", entries: [{ id: "chunk-a" }] },
      ],
      legacyMemory: {
        agent: "replace",
        shared: "replace",
      },
    });
    expect(calls).toEqual(["memory:308", "brain:692"]);
  });

  it("skips disabled providers and preserves an empty replacement directive", async () => {
    const disabled = vi.fn();
    const active = vi.fn(async () => ({
      segments: [],
      legacyMemory: { shared: "replace" as const },
    }));
    const composite = createCompositeRuntimeContextProvider({
      tokenBudget: 600,
      providers: [
        provider(0, disabled),
        provider(600, active),
      ],
    });

    await expect(composite.retrieve(input(600))).resolves.toEqual({
      segments: [],
      legacyMemory: { shared: "replace" },
    });
    expect(disabled).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledOnce();
  });

  it("rejects malformed configuration and honors an already-aborted request", async () => {
    expect(() => createCompositeRuntimeContextProvider({
      tokenBudget: -1,
      providers: [],
    })).toThrow("tokenBudget");
    expect(() => createCompositeRuntimeContextProvider({
      tokenBudget: 100,
      providers: [null as unknown as RuntimeContextProvider],
    })).toThrow("providers[0]");

    const controller = new AbortController();
    controller.abort();
    const retrieve = vi.fn();
    const composite = createCompositeRuntimeContextProvider({
      tokenBudget: 100,
      providers: [provider(100, retrieve)],
    });
    await expect(
      composite.retrieve(input(100, controller.signal)),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("never allocates more than the request budget and preserves every corpus deterministically", async () => {
    const budgets: number[] = [];
    const composite = createCompositeRuntimeContextProvider({
      tokenBudget: 1_000,
      providers: [
        provider(400, async (value) => {
          budgets.push(value.tokenBudget);
          return { segments: [] };
        }),
        provider(900, async (value) => {
          budgets.push(value.tokenBudget);
          return { segments: [] };
        }),
      ],
    });

    await composite.retrieve(input(100));
    expect(budgets).toEqual([31, 69]);
    expect(budgets.reduce((sum, value) => sum + value, 0)).toBe(100);
  });
});
