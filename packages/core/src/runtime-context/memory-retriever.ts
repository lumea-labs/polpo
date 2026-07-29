import { nanoid } from "nanoid";
import type {
  MemoryItem,
  MemoryItemStore,
  MemoryStoreContext,
  MemoryUsageEvent,
} from "../memory/index.js";
import type {
  RuntimeContextRetriever,
  RuntimeContextTrust,
} from "./types.js";

export interface CreateMemoryRuntimeContextRetrieverOptions {
  readonly store: MemoryItemStore;
  readonly resolveContext: (
    input: Parameters<RuntimeContextRetriever>[0],
  ) => MemoryStoreContext | Promise<MemoryStoreContext>;
  readonly maxResults?: number;
  readonly resolveTrust?: (
    item: MemoryItem,
  ) => RuntimeContextTrust | Promise<RuntimeContextTrust>;
  readonly createUsageId?: () => string;
  readonly now?: () => Date | string;
  /** Usage telemetry is best-effort and never changes retrieval semantics. */
  readonly onUsageError?: (
    error: unknown,
    event: MemoryUsageEvent,
  ) => void | Promise<void>;
}

function operationTime(
  options: CreateMemoryRuntimeContextRetrieverOptions,
): string {
  const value = options.now?.() ?? new Date();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Memory retrieval time must be valid");
  }
  return parsed.toISOString();
}

function defaultTrust(item: MemoryItem): RuntimeContextTrust {
  return item.provenance.source === "explicit"
    && item.provenance.actor === "user"
    ? "user_provided"
    : "untrusted";
}

export function createMemoryRuntimeContextRetriever(
  options: CreateMemoryRuntimeContextRetrieverOptions,
): RuntimeContextRetriever {
  return async (input) => {
    if (input.signal?.aborted) {
      const error = new Error("Runtime context retrieval was aborted");
      error.name = "AbortError";
      throw error;
    }
    const context = await options.resolveContext(input);
    const results = await options.store.search({
      query: input.query,
      tokenBudget: input.tokenBudget,
      maxResults: options.maxResults ?? 20,
    }, context);
    const entries = await Promise.all(results.map(async (result) => ({
      id: result.item.id,
      content: result.item.content,
      source: {
        type: "memory" as const,
        id: result.item.id,
        label: result.item.kind,
        ...(result.item.provenance.sourceId
          ? { reference: result.item.provenance.sourceId }
          : {}),
      },
      timestamp: result.item.updatedAt,
      trust: await (options.resolveTrust?.(result.item)
        ?? defaultTrust(result.item)),
      score: result.score,
      estimatedTokens: result.estimatedTokens,
    })));

    const at = operationTime(options);
    await Promise.all(results.map(async ({ item }) => {
      const event: MemoryUsageEvent = {
        id: options.createUsageId?.() ?? `memory-usage-${nanoid(16)}`,
        memoryId: item.id,
        type: "retrieved",
        at,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      };
      try {
        await options.store.appendUsage(event, context);
      } catch (error) {
        try {
          await options.onUsageError?.(error, event);
        } catch {
          // Observability must never change retrieval semantics.
        }
      }
    }));

    return {
      segments: entries.length > 0
        ? [{ kind: "memory", entries }]
        : [],
    };
  };
}
