import type {
  ChannelAttachment,
  ChannelInboundMessage,
  ChannelInboundTurn,
  ChannelTurnHandler,
  ChannelTurnResult,
} from "@polpo-ai/channels";
import type { SessionContentPart, SessionStore } from "@polpo-ai/core/session-store";
import {
  createToolInvocationContext,
  type ToolInvocationJsonValue,
  type ToolInvocationScope,
} from "@polpo-ai/core";
import type { CompletionRouteDeps } from "../routes/completions.js";
import {
  runConversationTurn,
  type ConversationTurnResult,
  type RunConversationTurnInput,
} from "../routes/completions/conversation-turn.js";

export type ChannelAttachmentResolutionContext = {
  message: ChannelInboundMessage;
  turn: ChannelInboundTurn;
};

export type ChannelConversationContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: { url: string; detail?: "auto" | "low" | "high" };
    }
  | { type: "file"; file_id: string };

export type ChannelConversationTurnExecutor = (
  input: RunConversationTurnInput,
) => Promise<ConversationTurnResult>;

export type ChannelInvocationResolution =
  | {
      disposition: "dispatch";
      user: string;
      metadata?: Record<string, ToolInvocationJsonValue>;
      scope?: ToolInvocationScope;
    }
  | {
      disposition: "consume";
      reply?: string;
    };

export interface ConversationChannelBridgeOptions {
  agent: string | ((turn: ChannelInboundTurn) => string | Promise<string>);
  createSession?: (input: {
    agent: string;
    metadata: Record<string, string>;
    scope?: ToolInvocationScope;
    title?: string;
    user: string;
  }) => Promise<string>;
  executeTurn?: ChannelConversationTurnExecutor;
  historyLimit?: number;
  maxInlineAttachmentBytes?: number;
  onRunEvent?: (event: Record<string, unknown>) => void;
  onSessionResolved?: (
    turn: ChannelInboundTurn,
    sessionId: string,
    scope?: ToolInvocationScope,
  ) => void | Promise<void>;
  resolveAttachment?: (
    attachment: ChannelAttachment,
    context: ChannelAttachmentResolutionContext,
  ) => Promise<
    ChannelConversationContentPart[] | ChannelConversationContentPart | null
  >;
  /**
   * Resolve host-trusted application identity before agent/session/model work.
   * A consumed turn returns directly to the provider and never enters history.
   */
  resolveInvocation?: (
    turn: ChannelInboundTurn,
  ) => ChannelInvocationResolution | Promise<ChannelInvocationResolution>;
  resolveExternalUserId?: (
    turn: ChannelInboundTurn,
  ) => string | Promise<string>;
  resolveMetadata?: (
    turn: ChannelInboundTurn,
  ) => Record<string, string> | Promise<Record<string, string>>;
  resolveSessionId?: (
    turn: ChannelInboundTurn,
    scope?: ToolInvocationScope,
  ) => Promise<string | null>;
}

export class ChannelConversationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ChannelConversationError";
  }
}

const DEFAULT_HISTORY_LIMIT = 30;
const DEFAULT_MAX_INLINE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Bind normalized Chat SDK turns to Polpo's canonical conversation runtime.
 * Sessions remain the source of truth; Chat SDK history is transport-only.
 */
export function createConversationChannelTurnHandler(
  deps: CompletionRouteDeps,
  options: ConversationChannelBridgeOptions,
): ChannelTurnHandler {
  const pendingSessions = new Map<string, Promise<string | null>>();
  const executeTurn = options.executeTurn
    ?? ((input) => runConversationTurn(deps, input));

  return async (turn): Promise<ChannelTurnResult> => {
    const latest = turn.messages.at(-1);
    if (!latest) {
      throw new ChannelConversationError(
        "Channel turn contains no messages",
        "channel_turn_empty",
      );
    }
    const invocationResolution = await options.resolveInvocation?.(turn);
    if (invocationResolution?.disposition === "consume") {
      return {
        metadata: { disposition: "consume" },
        ...(invocationResolution.reply?.trim()
          ? { text: invocationResolution.reply.trim() }
          : {}),
      };
    }
    if (
      invocationResolution?.disposition === "dispatch"
      && !invocationResolution.user.trim()
    ) {
      throw new ChannelConversationError(
        "Channel invocation resolver returned an empty user identity",
        "channel_invocation_identity_invalid",
      );
    }
    const trustedInvocation = invocationResolution?.disposition === "dispatch"
      ? createToolInvocationContext({
          requestId: turn.providerEventId,
          runId: turn.providerEventId,
          surface: "channel",
          metadata: invocationResolution.metadata ?? {},
          scope: invocationResolution.scope,
        })
      : undefined;
    const trustedScope = trustedInvocation?.scope;
    const user = invocationResolution?.disposition === "dispatch"
      ? invocationResolution.user.trim()
      : options.resolveExternalUserId
        ? await options.resolveExternalUserId(turn)
        : defaultExternalUserId(turn, latest);
    const agent = typeof options.agent === "function"
      ? await options.agent(turn)
      : options.agent;
    if (!agent.trim()) {
      throw new ChannelConversationError(
        "Channel route did not resolve an agent",
        "channel_agent_not_resolved",
      );
    }
    const metadata = {
      channel_installation_id: turn.installationId,
      channel_provider: turn.provider,
      channel_thread_id: turn.threadId,
      ...(options.resolveMetadata ? await options.resolveMetadata(turn) : {}),
      ...(trustedScope
        ? {
            channel_scope_key: trustedScope.key,
            ...(trustedScope.version
              ? { channel_scope_version: trustedScope.version }
              : {}),
          }
        : {}),
    };
    const sessionId = await resolveSessionOnce(
      pendingSessions,
      sessionIdentity(turn, trustedScope),
      () => resolveOrCreateSession(deps.getSessionStore(), turn, {
        agent,
        metadata,
        options,
        scope: trustedScope,
        title: latest.text.slice(0, 60) || `${turn.provider} conversation`,
        user,
      }),
    );
    if (sessionId) await options.onSessionResolved?.(turn, sessionId, trustedScope);

    const history = await loadHistory(
      deps.getSessionStore(),
      sessionId,
      options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    );
    const content = await channelTurnContent(turn, options);
    const result = await executeTurn({
      body: {
        agent,
        messages: [...history, { content, role: "user" }],
        metadata,
        stream: false,
        user,
      },
      onRunEvent: options.onRunEvent,
      runtime: {
        channelId: turn.installationId,
        requestId: turn.providerEventId,
        source: "channel",
        surface: "channel",
        user,
        ...(trustedInvocation ? { metadata: trustedInvocation.metadata } : {}),
        ...(trustedScope ? { scope: trustedScope } : {}),
      },
      sessionId,
    });

    if (result.error) {
      throw new ChannelConversationError(
        result.error.message,
        result.error.code ?? "channel_model_error",
        result.error,
      );
    }
    return {
      metadata: {
        completionId: result.completionId,
        providerMetadata: result.providerMetadata,
        runStatus: result.runStatus,
        sessionId: result.sessionId,
        usage: result.usage,
      },
      text: result.text,
    };
  };
}

async function resolveSessionOnce(
  pending: Map<string, Promise<string | null>>,
  key: string,
  resolve: () => Promise<string | null>,
): Promise<string | null> {
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = resolve();
  pending.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
  }
}

async function resolveOrCreateSession(
  store: SessionStore | null | undefined,
  turn: ChannelInboundTurn,
  input: {
    agent: string;
    metadata: Record<string, string>;
    options: ConversationChannelBridgeOptions;
    scope?: ToolInvocationScope;
    title: string;
    user: string;
  },
): Promise<string | null> {
  const resolved = await input.options.resolveSessionId?.(turn, input.scope);
  if (resolved) return resolved;

  if (!input.options.resolveSessionId && store) {
    const sessions = await store.listSessions({
      metadata: {
        channel_installation_id: turn.installationId,
        channel_provider: turn.provider,
        channel_thread_id: turn.threadId,
        ...(input.scope
          ? {
              channel_scope_key: input.scope.key,
              ...(input.scope.version
                ? { channel_scope_version: input.scope.version }
                : {}),
            }
          : {}),
      },
      user: input.user,
    });
    const existing = sessions.find((session) => session.agent === input.agent);
    if (existing) return existing.id;
  }

  if (input.options.createSession) {
    return input.options.createSession({
      agent: input.agent,
      metadata: input.metadata,
      scope: input.scope,
      title: input.title,
      user: input.user,
    });
  }
  if (!store) return null;
  return store.create({
    agent: input.agent,
    metadata: input.metadata,
    title: input.title,
    user: input.user,
  });
}

async function loadHistory(
  store: SessionStore | null | undefined,
  sessionId: string | null,
  requestedLimit: number,
): Promise<Array<{
  content: string | ChannelConversationContentPart[];
  role: "assistant" | "user";
}>> {
  if (!store || !sessionId) return [];
  const limit = Math.max(0, Math.min(Math.floor(requestedLimit), 200));
  if (limit === 0) return [];
  const messages = await store.getRecentMessages(sessionId, limit);
  return messages
    .filter((message) => message.role === "assistant" || message.role === "user")
    .map((message) => ({
      content: normalizeStoredContent(message.content),
      role: message.role,
    }));
}

async function channelTurnContent(
  turn: ChannelInboundTurn,
  options: ConversationChannelBridgeOptions,
): Promise<string | ChannelConversationContentPart[]> {
  const parts: ChannelConversationContentPart[] = [];
  for (const [index, message] of turn.messages.entries()) {
    const prefix = turn.messages.length > 1
      ? `[Message ${index + 1} from ${message.author.fullName}]\n`
      : "";
    if (message.text.trim()) {
      parts.push({ type: "text", text: `${prefix}${message.text}` });
    }
    for (const attachment of message.attachments) {
      const resolved = options.resolveAttachment
        ? await options.resolveAttachment(attachment, { message, turn })
        : await defaultAttachmentParts(
            attachment,
            options.maxInlineAttachmentBytes
              ?? DEFAULT_MAX_INLINE_ATTACHMENT_BYTES,
          );
      if (Array.isArray(resolved)) parts.push(...resolved);
      else if (resolved) parts.push(resolved);
    }
  }
  if (parts.length === 0) {
    throw new ChannelConversationError(
      "Channel turn has no usable text or attachments",
      "channel_content_empty",
    );
  }
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

async function defaultAttachmentParts(
  attachment: ChannelAttachment,
  maxBytes: number,
): Promise<ChannelConversationContentPart> {
  if (attachment.type !== "image") {
    return {
      type: "text",
      text: `[${attachment.type} attachment: ${attachment.name ?? "unnamed"}${
        attachment.mimeType ? `, ${attachment.mimeType}` : ""
      }]`,
    };
  }

  const data = attachment.data ?? await attachment.fetchData?.();
  if (!data) {
    if (attachment.url) {
      return { type: "image_url", image_url: { url: attachment.url } };
    }
    throw new ChannelConversationError(
      `Image attachment ${attachment.name ?? "unnamed"} has no readable data`,
      "channel_attachment_unreadable",
    );
  }
  const bytes = data instanceof Blob
    ? new Uint8Array(await data.arrayBuffer())
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength > maxBytes) {
    throw new ChannelConversationError(
      `Image attachment exceeds the ${maxBytes} byte inline limit`,
      "channel_attachment_too_large",
      { actualBytes: bytes.byteLength, maxBytes },
    );
  }
  const mimeType = attachment.mimeType?.startsWith("image/")
    ? attachment.mimeType
    : "image/jpeg";
  return {
    type: "image_url",
    image_url: { url: `data:${mimeType};base64,${bytesToBase64(bytes)}` },
  };
}

function normalizeStoredContent(
  content: string | SessionContentPart[],
): string | ChannelConversationContentPart[] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type !== "image_url") return part;
    const detail = part.image_url.detail;
    return {
      type: "image_url" as const,
      image_url: {
        url: part.image_url.url,
        ...(detail === "auto" || detail === "low" || detail === "high"
          ? { detail }
          : {}),
      },
    };
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function defaultExternalUserId(
  turn: ChannelInboundTurn,
  latest: ChannelInboundMessage,
): string {
  return `${turn.provider}:${turn.installationId}:${latest.author.userId}`;
}

function sessionIdentity(
  turn: ChannelInboundTurn,
  scope?: ToolInvocationScope,
): string {
  return JSON.stringify([
    turn.provider,
    turn.installationId,
    turn.threadId,
    scope?.key ?? "",
    scope?.version ?? "",
  ]);
}
