import type { ModelRuntimeMode } from "./model-runtime.js";

export interface StructuredOutputRuntimeRoute {
  provider: string;
  runtimeMode?: ModelRuntimeMode;
}

export function needsSeparateStructuredOutputReasoningPass(
  _route: StructuredOutputRuntimeRoute,
  _reasoning: string | undefined,
  _providerOptions?: Record<string, any>,
): boolean {
  return false;
}

/**
 * @deprecated Native Anthropic structured outputs retain thinking. Keep the
 * provider options unchanged and start any terminal schema pass as a new user
 * turn instead of treating the last assistant message as a response prefill.
 */
export function providerOptionsForStructuredOutputPass(
  _route: StructuredOutputRuntimeRoute,
  _reasoning: string | undefined,
  providerOptions: Record<string, any> | undefined,
): Record<string, any> | undefined {
  return providerOptions;
}
