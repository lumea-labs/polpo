import type { ChatSuggestion } from "@polpo-ai/core/chat-interactions";
import { completionResolvedModelInfo } from "./agent-step-runner.js";
import type { ChatCompletionExecution } from "./chat-handler.js";
import { generateChatSuggestions } from "./chat-suggestions.js";
import { isStructuredResponseFormat } from "./structured-output.js";

/** Run the optional, fail-open suggestion pass for a successful text turn. */
export async function suggestionsForCompletion(
  execution: ChatCompletionExecution,
  finalText: string,
  signal?: AbortSignal,
): Promise<ChatSuggestion[]> {
  if (
    !execution.interactionCapabilities?.suggestions
    || isStructuredResponseFormat(execution.body.response_format)
    || !finalText.trim()
    || signal?.aborted
  ) {
    return [];
  }

  const settings = execution.interactionSettings.suggestions;

  const result = await generateChatSuggestions({
    model: execution.m.aiModel,
    providerOptions: execution.providerOpts,
    messages: execution.body.messages ?? [],
    finalText,
    maxItems: settings.maxItems,
    guidance: settings.guidance,
    signal,
  });

  if (result.usage) {
    try {
      execution.deps.onAuxiliaryModelFinished?.({
        operation: "chat_suggestions",
        usage: result.usage,
        model: execution.m.id ?? execution.m.provider,
        resolvedModel: completionResolvedModelInfo(execution.m),
        agent: execution.body.agent,
        sessionId: execution.sessionId ?? undefined,
        user: execution.body.user,
        providerMetadata: result.providerMetadata,
      });
    } catch { /* auxiliary accounting never fails the main response */ }
  }

  return result.suggestions;
}
