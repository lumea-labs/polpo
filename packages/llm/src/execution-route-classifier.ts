import type {
  ExecutionRouteClassifier,
  ExecutionRouteClassifierInput,
  ExecutionRouteClassifierOptions,
} from "@polpo-ai/core/execution-router";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

const DEFAULT_EXECUTION_ROUTE_CLASSIFIER_SYSTEM = [
  "Choose direct execution or exactly one allowed loop for the current request.",
  "Use only a loop listed in the input.",
  "Choose direct when a normal agent turn is sufficient or the choice is uncertain.",
  "Return a confidence from 0 to 1 and a short reason that does not quote the request.",
  "Never return a model, provider, tool, credential, or unlisted loop.",
].join(" ");

const DirectExecutionRouteDecisionSchema = z.object({
  mode: z.literal("direct"),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(512),
}).strict();

const LoopExecutionRouteDecisionSchema = z.object({
  mode: z.literal("loop"),
  loop: z.string().min(1).max(128),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(512),
}).strict();

const ExecutionRouteDecisionSchema = z.discriminatedUnion("mode", [
  DirectExecutionRouteDecisionSchema,
  LoopExecutionRouteDecisionSchema,
]);

export interface StructuredExecutionRouteGenerationResult {
  readonly output?: unknown;
}

export type StructuredExecutionRouteGenerate = (
  options: Record<string, unknown>,
) => Promise<StructuredExecutionRouteGenerationResult>;

export interface StructuredExecutionRouteClassifierOptions {
  readonly model: LanguageModel;
  /** Host-private classifier instructions; never part of user settings. */
  readonly system?: string;
  readonly providerOptions?: Record<string, Record<string, unknown>>;
  /** Test/host injection point. Defaults to AI SDK generateText. */
  readonly generate?: StructuredExecutionRouteGenerate;
}

export function createStructuredExecutionRouteClassifier(
  options: StructuredExecutionRouteClassifierOptions,
): ExecutionRouteClassifier {
  const generate = options.generate
    ?? (generateText as unknown as StructuredExecutionRouteGenerate);

  return Object.freeze({
    async classify(
      input: ExecutionRouteClassifierInput,
      classifierOptions: ExecutionRouteClassifierOptions,
    ): Promise<unknown> {
      const response = await generate({
        model: options.model,
        system: options.system ?? DEFAULT_EXECUTION_ROUTE_CLASSIFIER_SYSTEM,
        prompt: JSON.stringify(input),
        output: Output.object({ schema: ExecutionRouteDecisionSchema }),
        temperature: 0,
        maxOutputTokens: 256,
        abortSignal: classifierOptions.signal,
        ...(options.providerOptions
          ? { providerOptions: options.providerOptions }
          : {}),
      });
      if (response.output === undefined || response.output === null) {
        throw new Error(
          "Execution route classifier did not return structured output",
        );
      }
      return response.output;
    },
  });
}
