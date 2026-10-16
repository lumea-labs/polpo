import type { ModelRuntimeMode } from "./model-runtime.js";

export interface StructuredOutputRuntimeRoute {
  provider: string;
  runtimeMode?: ModelRuntimeMode;
}

export function needsSeparateStructuredOutputReasoningPass(
  route: StructuredOutputRuntimeRoute,
  reasoning: string | undefined,
  providerOptions?: Record<string, any>,
): boolean {
  const anthropic = providerOptions?.anthropic;
  const thinking = anthropic && typeof anthropic === "object" && !Array.isArray(anthropic)
    ? anthropic.thinking
    : undefined;
  const hasEffectiveThinking = Boolean(
    thinking
    && typeof thinking === "object"
    && !Array.isArray(thinking)
    && thinking.type !== "disabled",
  );
  return route.provider === "anthropic"
    && route.runtimeMode === "gateway"
    && (
      hasEffectiveThinking
      || (reasoning !== undefined && reasoning !== "off")
    );
}

/**
 * Vercel AI Gateway currently implements Anthropic structured output as a
 * forced synthetic tool. Anthropic rejects forced tool choice while extended
 * thinking is enabled, so the terminal schema pass must omit thinking on this
 * concrete route. Direct Anthropic adapters use native output_config and keep
 * reasoning and structured output in one request.
 */
export function providerOptionsForStructuredOutputPass(
  route: StructuredOutputRuntimeRoute,
  reasoning: string | undefined,
  providerOptions: Record<string, any> | undefined,
): Record<string, any> | undefined {
  if (!needsSeparateStructuredOutputReasoningPass(route, reasoning, providerOptions)) {
    return providerOptions;
  }
  const anthropic = providerOptions?.anthropic;
  if (!anthropic || typeof anthropic !== "object" || Array.isArray(anthropic)) {
    return providerOptions;
  }
  const { thinking: _thinking, effort: _effort, ...terminalAnthropic } = anthropic;
  return {
    ...providerOptions,
    anthropic: terminalAnthropic,
  };
}
