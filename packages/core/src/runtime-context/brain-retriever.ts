import type {
  BrainReadService,
  BrainRetrievalResult,
  BrainServiceContext,
} from "../brain/index.js";
import type {
  RuntimeContextRetriever,
  RuntimeContextTrust,
} from "./types.js";

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 1_000;

export interface CreateBrainRuntimeContextRetrieverOptions {
  readonly service: BrainReadService;
  readonly resolveContext: (
    input: Parameters<RuntimeContextRetriever>[0],
  ) => BrainServiceContext | Promise<BrainServiceContext>;
  readonly maxResults?: number;
  readonly resolveTrust?: (
    result: BrainRetrievalResult,
  ) => RuntimeContextTrust | Promise<RuntimeContextTrust>;
  readonly now?: () => Date | string;
}

function abortError(): Error {
  const error = new Error("Runtime context retrieval was aborted");
  error.name = "AbortError";
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function maxResults(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESULTS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESULTS) {
    throw new Error(`maxResults must be an integer between 1 and ${MAX_RESULTS}`);
  }
  return value;
}

function timestamp(value: Date | string, name: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${name} must be a valid timestamp`);
  }
  return parsed.toISOString();
}

function resultTimestamp(
  result: BrainRetrievalResult,
  options: CreateBrainRuntimeContextRetrieverOptions,
): string {
  const capturedAt = result.chunk.citation.capturedAt;
  return capturedAt
    ? timestamp(capturedAt, "Brain citation capturedAt")
    : timestamp(options.now?.() ?? new Date(), "Brain retrieval time");
}

function citationHandle(result: BrainRetrievalResult): string {
  const citation = result.chunk.citation;
  return `${citation.sourceId}@${citation.version}#${citation.chunkId}`;
}

export function createBrainRuntimeContextRetriever(
  options: CreateBrainRuntimeContextRetrieverOptions,
): RuntimeContextRetriever {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Brain runtime retriever options are required");
  }
  if (!options.service || typeof options.service.search !== "function") {
    throw new Error("Brain runtime retriever service is required");
  }
  if (typeof options.resolveContext !== "function") {
    throw new Error("Brain runtime context resolver is required");
  }
  const limit = maxResults(options.maxResults);

  return async (input) => {
    assertNotAborted(input.signal);
    const context = await options.resolveContext(input);
    assertNotAborted(input.signal);
    const results = await options.service.search(context, {
      query: input.query,
      limit,
      tokenBudget: input.tokenBudget,
    });
    assertNotAborted(input.signal);

    const entries = await Promise.all(results.map(async (result) => {
      const citation = result.chunk.citation;
      const reference = citation.uri ?? citation.locator;
      return {
        id: result.chunk.id,
        content: result.chunk.content,
        source: {
          type: "brain" as const,
          id: citation.sourceId,
          label: citation.label,
          ...(reference ? { reference } : {}),
        },
        timestamp: resultTimestamp(result, options),
        version: result.chunk.version,
        trust: await (options.resolveTrust?.(result) ?? result.trust),
        citation: {
          handle: citationHandle(result),
          sourceId: citation.sourceId,
          version: citation.version,
          ...(citation.uri ? { uri: citation.uri } : {}),
          label: citation.label,
        },
        score: result.score,
        ...(result.chunk.tokenCount !== undefined
          ? { estimatedTokens: result.chunk.tokenCount }
          : {}),
      };
    }));
    assertNotAborted(input.signal);

    return {
      segments: entries.length > 0
        ? [{ kind: "brain", entries }]
        : [],
    };
  };
}
