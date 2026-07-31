import type {
  RuntimeContextLegacyMemoryPolicy,
  RuntimeContextProvider,
  RuntimeContextResult,
  RuntimeContextRetrievalInput,
} from "./types.js";

const MAX_TOKEN_BUDGET = 128_000;

export interface CreateCompositeRuntimeContextProviderOptions {
  readonly tokenBudget: number;
  readonly providers: readonly RuntimeContextProvider[];
}

function tokenBudget(value: unknown, name: string): number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) > MAX_TOKEN_BUDGET
  ) {
    throw new Error(
      `${name} must be an integer between 0 and ${MAX_TOKEN_BUDGET}`,
    );
  }
  return value as number;
}

function abortError(): Error {
  const error = new Error("Runtime context retrieval was aborted");
  error.name = "AbortError";
  return error;
}

function mergeLegacyMemory(
  results: readonly RuntimeContextResult[],
): RuntimeContextLegacyMemoryPolicy | undefined {
  const agent = results.some(
    (result) => result.legacyMemory?.agent === "replace",
  );
  const shared = results.some(
    (result) => result.legacyMemory?.shared === "replace",
  );
  if (!agent && !shared) return undefined;
  return Object.freeze({
    ...(agent ? { agent: "replace" as const } : {}),
    ...(shared ? { shared: "replace" as const } : {}),
  });
}

export function createCompositeRuntimeContextProvider(
  options: CreateCompositeRuntimeContextProviderOptions,
): RuntimeContextProvider {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Composite runtime context options are required");
  }
  const totalBudget = tokenBudget(options.tokenBudget, "tokenBudget");
  if (!Array.isArray(options.providers)) {
    throw new Error("providers must be an array");
  }
  const providers = Object.freeze(options.providers.map((provider, index) => {
    if (
      !provider
      || typeof provider !== "object"
      || typeof provider.retrieve !== "function"
    ) {
      throw new Error(`providers[${index}] must be a runtime context provider`);
    }
    tokenBudget(provider.tokenBudget, `providers[${index}].tokenBudget`);
    return provider;
  }));

  return Object.freeze({
    tokenBudget: totalBudget,
    retrieve: async (input: RuntimeContextRetrievalInput) => {
      if (input.signal?.aborted) throw abortError();
      const active = providers.filter((provider) => provider.tokenBudget > 0);
      const results = await Promise.all(active.map((provider) =>
        provider.retrieve(Object.freeze({
          ...input,
          tokenBudget: Math.min(input.tokenBudget, provider.tokenBudget),
        }))
      ));
      if (input.signal?.aborted) throw abortError();
      const legacyMemory = mergeLegacyMemory(results);
      return {
        segments: results.flatMap((result) => result.segments),
        ...(legacyMemory ? { legacyMemory } : {}),
      };
    },
  });
}
