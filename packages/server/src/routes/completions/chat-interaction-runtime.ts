import {
  normalizeChatInteractionSettings,
  normalizeChatSuggestionRequest,
  resolveChatSuggestionPlan,
  combineChatSuggestions,
  resolveChatInteractionCapabilities,
  type ChatSuggestion,
} from "@polpo-ai/core/chat-interactions";
import { agentConfigForModelPrimary, completionResolvedModelInfo } from "./agent-step-runner.js";
import type { ChatCompletionExecution } from "./chat-handler.js";
import { DEFAULT_CHAT_SUGGESTION_TIMEOUT_MS, generateChatSuggestions } from "./chat-suggestions.js";
import type { ProjectLoopCompletionOptions } from "./project-loop-runner.js";
import { isStructuredResponseFormat } from "./structured-output.js";

/** Run the optional, fail-open suggestion pass for a successful text turn. */
export async function suggestionsForCompletion(
  execution: Pick<ChatCompletionExecution, "interactionCapabilities" | "interactionSettings" | "body" | "m" | "providerOpts" | "deps" | "sessionId">,
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
  const request = normalizeChatSuggestionRequest(execution.body.polpo?.capabilities?.suggestions);
  const plan = resolveChatSuggestionPlan(settings, request);
  if (plan.generatedCount === 0) return plan.actions;

  const result = await generateChatSuggestions({
    model: execution.m.aiModel,
    providerOptions: execution.providerOpts,
    messages: execution.body.messages ?? [],
    finalText,
    maxItems: plan.generatedCount,
    requestGuidance: request.guidance,
    context: request.context,
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

  return signal?.aborted ? [] : combineChatSuggestions(plan, result.suggestions);
}


/** Loop auxiliary pass, bounded across session/model resolution as well as inference. */
export async function suggestionsForProjectLoopCompletion(
  options: ProjectLoopCompletionOptions,
  finalText: string,
  assistantMessageId: string | null,
  signal?: AbortSignal,
): Promise<ChatSuggestion[]> {
  const interactionSettings = normalizeChatInteractionSettings(options.agentConfig?.chat);
  const interactionCapabilities = resolveChatInteractionCapabilities({
    surface: options.runtimeInvocation?.surface,
    settings: interactionSettings,
    client: options.body.polpo?.capabilities,
  });
  if (!interactionCapabilities.suggestions || !finalText.trim() || signal?.aborted
    || isStructuredResponseFormat(options.body.response_format)) return [];
  const plan = resolveChatSuggestionPlan(interactionSettings.suggestions, options.body.polpo?.capabilities?.suggestions);
  if (plan.generatedCount === 0) return plan.actions;

  const controller = new AbortController();
  let finish: (suggestions: ChatSuggestion[]) => void;
  const cancelled = new Promise<ChatSuggestion[]>(resolve => { finish = resolve; });
  const cancel = () => { controller.abort(); finish(signal?.aborted ? [] : plan.actions); };
  const timeout = setTimeout(cancel, DEFAULT_CHAT_SUGGESTION_TIMEOUT_MS);
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([cancelled, (async () => {
      const [resolved, history] = await Promise.all([
        options.deps.resolveAgentModel(
          agentConfigForModelPrimary(options.agentConfig, options.deps.getConfig()?.settings),
          options.agentConfig?.reasoning ?? options.deps.getConfig()?.settings?.reasoning,
        ),
        options.sessionStore && options.sessionId && assistantMessageId
          ? options.sessionStore.getMessages(options.sessionId)
          : undefined,
      ]);
      if (controller.signal.aborted) return [];
      // Exclude the current placeholder and any concurrently appended later turn.
      const boundary = history?.findIndex((message: { id: string }) => message.id === assistantMessageId) ?? -1;
      const messages = boundary >= 0 ? history.slice(0, boundary) : options.body.messages ?? [];
      return suggestionsForCompletion({
        deps: options.deps,
        body: { ...options.body, messages },
        m: resolved.model,
        providerOpts: resolved.providerOptions,
        sessionId: options.sessionId,
        interactionSettings,
        interactionCapabilities,
      }, finalText, controller.signal);
    })().catch(() => signal?.aborted ? [] : plan.actions)]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
