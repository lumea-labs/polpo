import type {
  ModelRouteClassifier,
  ModelRouteClassifierInput,
  ModelRouteClassifierOptions,
} from "@polpo-ai/core/model-router";
import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

const DEFAULT_MODEL_ROUTE_CLASSIFIER_SYSTEM = [
  "Select exactly one allowed semantic model profile for the current request.",
  "Use only a profile listed in the input.",
  "Return a confidence from 0 to 1, a short reason that does not quote the request,",
  "and zero or more short routing labels.",
  "Never return a provider name or raw model id.",
].join(" ");

const ModelRouteDecisionSchema = z.object({
  profile: z.string().min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(512),
  labels: z.array(z.string().min(1).max(64)).max(16),
}).strict();

export interface StructuredModelRouteGenerationResult {
  readonly output?: unknown;
}

export type StructuredModelRouteGenerate = (
  options: Record<string, unknown>,
) => Promise<StructuredModelRouteGenerationResult>;

export interface StructuredModelRouteClassifierOptions {
  readonly model: LanguageModel;
  /** Host-private classifier instructions; never part of user settings. */
  readonly system?: string;
  readonly providerOptions?: Record<string, Record<string, unknown>>;
  /** Test/host injection point. Defaults to AI SDK generateText. */
  readonly generate?: StructuredModelRouteGenerate;
}

export function createStructuredModelRouteClassifier(
  options: StructuredModelRouteClassifierOptions,
): ModelRouteClassifier {
  const generate = options.generate
    ?? (generateText as unknown as StructuredModelRouteGenerate);

  return Object.freeze({
    async classify(
      input: ModelRouteClassifierInput,
      classifierOptions: ModelRouteClassifierOptions,
    ): Promise<unknown> {
      const response = await generate({
        model: options.model,
        system: options.system ?? DEFAULT_MODEL_ROUTE_CLASSIFIER_SYSTEM,
        prompt: JSON.stringify(input),
        output: Output.object({ schema: ModelRouteDecisionSchema }),
        temperature: 0,
        maxOutputTokens: 256,
        abortSignal: classifierOptions.signal,
        ...(options.providerOptions
          ? { providerOptions: options.providerOptions }
          : {}),
      });
      if (response.output === undefined || response.output === null) {
        throw new Error("Model route classifier did not return structured output");
      }
      return response.output;
    },
  });
}
