import {
  DeterministicMemoryConsolidationPolicy,
  MemoryLearningService,
  type CanonicalTurnCommitted,
  type CanonicalTurnDispatchHandler,
  type MemoryExtractionCandidateStore,
  type MemoryExtractor,
  type MemoryItemStore,
  type SessionContentPart,
  type SessionStore,
} from "@polpo-ai/core";

export interface LocalMemoryLearningHandlerOptions {
  readonly extractor: MemoryExtractor;
  readonly sessionStore: SessionStore;
  readonly candidateStore: MemoryExtractionCandidateStore;
  readonly itemStore: MemoryItemStore;
  readonly namespace: string;
  readonly projectId?: string;
}

export function createLocalMemoryLearningHandler(
  options: LocalMemoryLearningHandlerOptions,
): CanonicalTurnDispatchHandler {
  const service = new MemoryLearningService({
    extractor: options.extractor,
    policy: new DeterministicMemoryConsolidationPolicy({
      itemStore: options.itemStore,
    }),
    candidateStore: options.candidateStore,
    itemStore: options.itemStore,
  });
  return {
    async dispatch(turn: CanonicalTurnCommitted): Promise<void> {
      const policy = turn.learningPolicy;
      if (!policy) return;
      const messages = await options.sessionStore.getMessages(turn.sessionId);
      const userMessage = messages.find((message) => message.id === turn.userMessage.id);
      const assistantMessage = turn.assistantMessage
        ? messages.find((message) => message.id === turn.assistantMessage!.id)
        : undefined;
      if (!userMessage || !assistantMessage) {
        throw new Error("Canonical Memory turn references missing visible messages");
      }
      const access = {
        ...(options.projectId ? { projectId: options.projectId } : {}),
        agentName: turn.agentName,
        ...(turn.trustedInvocation.externalUserId
          ? { externalUserId: turn.trustedInvocation.externalUserId }
          : {}),
        ...(turn.trustedInvocation.channelId
          ? { channelId: turn.trustedInvocation.channelId }
          : {}),
        sessionId: turn.sessionId,
      };
      await service.process({
        turn,
        userContent: visibleSessionContent(userMessage.content),
        assistantContent: visibleSessionContent(assistantMessage.content),
        mode: policy.mode,
        surfaces: policy.surfaces,
        kinds: policy.kinds,
        candidateContext: { namespace: options.namespace, access },
        itemContext: { namespace: options.namespace, access, surface: turn.surface },
      });
    },
  };
}

function visibleSessionContent(content: string | SessionContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<SessionContentPart, { type: "text" }> =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("\n");
}
