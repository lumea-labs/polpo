import type {
  ChannelAttachment,
  ChannelInboundMessage,
  ChannelInboundTurn,
  ChannelTurnHandler,
  ChannelTurnResult,
} from "@polpo-ai/channels";
import { createHash } from "node:crypto";
import type { SessionContentPart, SessionStore } from "@polpo-ai/core/session-store";
import {
  createToolInvocationContext,
  prepareProjectLoopResult,
  type ToolInvocationContext,
  type ToolInvocationJsonValue,
  type ToolInvocationScope,
} from "@polpo-ai/core";
import type { CompletionRouteDeps } from "../routes/completions.js";
import { continuationFingerprint } from "../routes/completions/continuation.js";
import {
  runConversationTurn,
  type ConversationTurnResult,
  type RunConversationTurnInput,
} from "../routes/completions/conversation-turn.js";

export type ChannelAttachmentResolutionContext = {
  /** Trusted resolver output for server-side attachment ingestion. */
  invocation?: ToolInvocationContext;
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

export type ChannelClientToolExecution = {
  result: ToolInvocationJsonValue;
  /** Immediate provider-neutral response delivered before a Loop continuation. */
  acknowledgement?: ChannelTurnResult;
  loop?: string;
  /** Trusted continuation restriction. It can only narrow configured tools. */
  allowedTools?: readonly string[];
  /** Host-trusted context for the continuation. Never persisted as tool output. */
  trustedMetadata?: Readonly<Record<string, ToolInvocationJsonValue>>;
};

export type ChannelClientToolDefinition = Readonly<{
  type: "function";
  function: Readonly<{
    name: string;
    description?: string;
    parameters?: Readonly<Record<string, unknown>>;
    strict?: boolean;
  }>;
}>;

export type ChannelClientToolExecutionInput = {
  idempotencyKey: string;
  invocation?: ToolInvocationContext;
  sessionId: string;
  sessionVersion: number;
  toolCall: Readonly<{ id: string; name: string; arguments: unknown }>;
  turn: ChannelInboundTurn;
};

export type ChannelClientToolExecutor = (
  input: ChannelClientToolExecutionInput,
) => Promise<ChannelClientToolExecution>;

export type ChannelConsumePresentation = Readonly<
  Pick<ChannelTurnResult, "actions" | "text">
>;

export type ChannelInvocationResolution =
  | {
      disposition: "dispatch";
      user: string;
      metadata?: Record<string, ToolInvocationJsonValue>;
      scope?: ToolInvocationScope;
      /** Trusted grant restriction for this identity and turn. */
      allowedTools?: readonly string[];
    }
  | {
      disposition: "consume";
      reply?: string;
      /** Trusted provider-neutral response delivered without creating runtime state. */
      presentation?: ChannelConsumePresentation;
    };

export interface ConversationChannelBridgeOptions {
  agent: string | ((turn: ChannelInboundTurn) => string | Promise<string>);
  /** OpenAI-compatible tools executed by executeClientTool, not by Polpo. */
  clientTools?: readonly ChannelClientToolDefinition[];
  /** Channel Route restriction for the active Channel turn only. */
  allowedTools?: readonly string[] | (
    (turn: ChannelInboundTurn) =>
      | readonly string[]
      | undefined
      | Promise<readonly string[] | undefined>
  );
  createSession?: (input: {
    agent: string;
    metadata: Record<string, string>;
    scope?: ToolInvocationScope;
    title?: string;
    user: string;
  }) => Promise<string>;
  executeTurn?: ChannelConversationTurnExecutor;
  executeClientTool?: ChannelClientToolExecutor;
  historyLimit?: number;
  maxClientToolContinuations?: number;
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
  /** Resolve run-aware policy after the canonical Session is known, before model work. */
  resolveSessionDisposition?: (
    turn: ChannelInboundTurn,
    sessionId: string,
    scope?: ToolInvocationScope,
  ) =>
    | { disposition: "dispatch" }
    | { disposition: "consume"; reply: string }
    | Promise<{ disposition: "dispatch" } | { disposition: "consume"; reply: string }>;
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
const DEFAULT_MAX_CLIENT_TOOL_CONTINUATIONS = 4;

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

  return async (turn, executionContext): Promise<ChannelTurnResult> => {
    const latest = turn.messages.at(-1);
    if (!latest) {
      throw new ChannelConversationError(
        "Channel turn contains no messages",
        "channel_turn_empty",
      );
    }
    const invocationResolution = await options.resolveInvocation?.(turn);
    if (invocationResolution?.disposition === "consume") {
      if (invocationResolution.reply !== undefined && invocationResolution.presentation !== undefined) {
        throw new ChannelConversationError(
          "A consumed Channel turn cannot define both reply and presentation",
          "channel_invocation_presentation_invalid",
        );
      }
      const presentation = invocationResolution.presentation === undefined
        ? invocationResolution.reply?.trim()
          ? { text: invocationResolution.reply.trim() }
          : {}
        : prepareChannelPresentation(invocationResolution.presentation, {
            code: "channel_invocation_presentation_invalid",
            label: "Channel consume presentation",
          });
      return {
        ...presentation,
        metadata: { disposition: "consume" },
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
    let trustedInvocation = invocationResolution?.disposition === "dispatch"
      ? createToolInvocationContext({
          requestId: turn.providerEventId,
          runId: turn.providerEventId,
          surface: "channel",
          user: invocationResolution.user.trim(),
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
    const content = await channelTurnContent(turn, options, trustedInvocation);
    const agent = typeof options.agent === "function"
      ? await options.agent(turn)
      : options.agent;
    if (!agent.trim()) {
      throw new ChannelConversationError(
        "Channel route did not resolve an agent",
        "channel_agent_not_resolved",
      );
    }
    const routeAllowedTools = typeof options.allowedTools === "function"
      ? await options.allowedTools(turn)
      : options.allowedTools;
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
    if (sessionId && options.resolveSessionDisposition) {
      const disposition = await options.resolveSessionDisposition(
        turn,
        sessionId,
        trustedScope,
      );
      if (disposition.disposition === "consume") {
        const reply = disposition.reply.trim();
        if (!reply) {
          throw new ChannelConversationError(
            "Channel Session disposition returned an empty reply",
            "channel_session_disposition_invalid",
          );
        }
        return {
          metadata: { disposition: "consume", sessionId },
          text: reply,
        };
      }
    }

    const history = await loadHistory(
      deps.getSessionStore(),
      sessionId,
      options.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    );
    if (trustedInvocation && sessionId) {
      trustedInvocation = invocationWithMetadata(
        trustedInvocation,
        trustedInvocation.metadata,
        sessionId,
      );
    }
    let runtime: RunConversationTurnInput["runtime"] = {
      channelId: turn.installationId,
      requestId: turn.providerEventId,
      source: "channel",
      surface: "channel",
      user,
      ...(trustedInvocation ? { metadata: trustedInvocation.metadata } : {}),
      ...(trustedScope ? { scope: trustedScope } : {}),
      ...(
        routeAllowedTools !== undefined
        || (invocationResolution?.disposition === "dispatch"
          && invocationResolution.allowedTools !== undefined)
          ? {
              toolPolicy: {
                ...(routeAllowedTools !== undefined
                  ? { routeAllowedTools: [...routeAllowedTools] }
                  : {}),
                ...(invocationResolution?.disposition === "dispatch"
                  && invocationResolution.allowedTools !== undefined
                  ? { grantAllowedTools: [...invocationResolution.allowedTools] }
                  : {}),
              },
            }
          : {}
      ),
    };
    let result = await executeTurn({
      body: {
        agent,
        messages: [...history, { content, role: "user" }],
        metadata,
        stream: false,
        user,
        ...clientToolRequestFields(options.clientTools),
      },
      onRunEvent: options.onRunEvent,
      runtime,
      sessionId,
    });

    const maxContinuations = options.maxClientToolContinuations
      ?? DEFAULT_MAX_CLIENT_TOOL_CONTINUATIONS;
    let continuationIndex = 0;
    while (result.clientToolCall) {
      if (!options.executeClientTool) {
        throw new ChannelConversationError(
          `Client tool "${result.clientToolCall.name}" requires a Channel client-tool executor`,
          "channel_client_tool_executor_required",
        );
      }
      if (!result.sessionId || result.sessionVersion === undefined) {
        throw new ChannelConversationError(
          "Client-tool continuation requires a persisted Session and version",
          "channel_client_tool_session_required",
        );
      }
      if (continuationIndex >= maxContinuations) {
        throw new ChannelConversationError(
          `Channel client-tool continuation exceeded the limit of ${maxContinuations}`,
          "channel_client_tool_limit_exceeded",
        );
      }
      const toolCall = Object.freeze({ ...result.clientToolCall });
      const idempotencyKey = channelClientToolIdempotencyKey(
        turn,
        continuationIndex,
        toolCall.name,
      );
      const execution = await options.executeClientTool({
        idempotencyKey,
        invocation: trustedInvocation,
        sessionId: result.sessionId,
        sessionVersion: result.sessionVersion,
        toolCall,
        turn,
      });
      const loop = execution.loop?.trim() || undefined;
      if (loop) {
        const acknowledgement = execution.acknowledgement
          ? prepareChannelPresentation(execution.acknowledgement)
          : result.text.trim()
            ? { text: result.text.trim() }
            : undefined;
        if (acknowledgement) {
          if (!executionContext) {
            throw new ChannelConversationError(
              "Channel runtime does not support progress delivery",
              "channel_progress_delivery_unavailable",
            );
          }
          const persistAcknowledgement = Boolean(
            execution.acknowledgement
            && acknowledgement.text !== result.text.trim(),
          );
          const sessionStore = persistAcknowledgement
            ? deps.getSessionStore()
            : undefined;
          if (persistAcknowledgement && !sessionStore) {
            throw new ChannelConversationError(
              "Channel acknowledgement requires canonical Session persistence",
              "channel_progress_persistence_unavailable",
            );
          }
          const delivery = await executionContext.deliverProgress(
            acknowledgement,
            { idempotencyKey: `${idempotencyKey}:ack` },
          );
          if (
            persistAcknowledgement
            && delivery.messages.length > 0
          ) {
            await sessionStore!.addMessage(
              result.sessionId,
              "assistant",
              acknowledgement.text,
            );
            result = {
              ...result,
              sessionVersion: result.sessionVersion + 1,
            };
          }
        }
      }
      if (execution.trustedMetadata !== undefined) {
        const baseInvocation = trustedInvocation ?? createToolInvocationContext({
          requestId: turn.providerEventId,
          runId: turn.providerEventId,
          ...(result.sessionId ? { sessionId: result.sessionId } : {}),
          surface: "channel",
          user,
          metadata: {},
        });
        trustedInvocation = invocationWithMetadata(
          baseInvocation,
          {
            ...baseInvocation.metadata,
            ...execution.trustedMetadata,
          },
          result.sessionId,
        );
        runtime = {
          ...runtime,
          metadata: trustedInvocation.metadata,
        };
      }
      if (execution.allowedTools !== undefined) {
        runtime = {
          ...runtime,
          toolPolicy: {
            ...runtime.toolPolicy,
            executionAllowedTools: [...execution.allowedTools],
          },
        };
      }
      const toolResult = typeof execution.result === "string"
        ? execution.result
        : JSON.stringify(execution.result);
      const continuationSessionId = result.sessionId;
      const continuationSessionVersion = result.sessionVersion;
      if (!continuationSessionId || continuationSessionVersion === undefined) {
        throw new ChannelConversationError(
          "Client-tool acknowledgement invalidated the persisted Session",
          "channel_client_tool_session_required",
        );
      }
      const continuationBody = {
        agent,
        ...(loop ? { loop } : {}),
        messages: [{
          role: "tool" as const,
          tool_call_id: toolCall.id,
          content: toolResult,
        }],
        metadata,
        stream: true,
        user,
        polpo: {
          continuation: {
            type: "client_tool" as const,
            tool_call_id: toolCall.id,
            expected_session_version: continuationSessionVersion,
          },
          delivery: { onDisconnect: "continue" as const },
        },
        ...(!loop ? clientToolRequestFields(options.clientTools) : {}),
      };
      const continuationRuntime = loop
        ? runtimeWithoutRouteToolPolicy(runtime)
        : runtime;
      result = await executeTurn({
        body: continuationBody,
        continuation: {
          idempotencyKey,
          fingerprint: continuationFingerprint({
            sessionId: continuationSessionId,
            agent,
            ...(loop ? { loop } : {}),
            user,
            toolCallId: toolCall.id,
            expectedSessionVersion: continuationSessionVersion,
            result: {
              content: toolResult,
              trustedMetadata: trustedInvocation?.metadata,
              trustedAllowedTools: execution.allowedTools,
            },
          }),
        },
        onRunEvent: options.onRunEvent,
        runtime: continuationRuntime,
        sessionId: continuationSessionId,
      });
      continuationIndex += 1;
    }

    if (result.error) {
      throw new ChannelConversationError(
        result.error.message,
        result.error.code ?? "channel_model_error",
        result.error,
      );
    }
    return {
      ...(result.loopPresentation?.actions?.length
        ? { actions: [...result.loopPresentation.actions] }
        : {}),
      metadata: {
        completionId: result.completionId,
        providerMetadata: result.providerMetadata,
        runStatus: result.runStatus,
        sessionId: result.sessionId,
        usage: result.usage,
      },
      text: result.loopPresentation?.text ?? result.text,
    };
  };
}

function prepareChannelPresentation(
  result: Pick<ChannelTurnResult, "actions" | "text">,
  failure: { code: string; label: string } = {
    code: "channel_acknowledgement_invalid",
    label: "Channel acknowledgement",
  },
): ChannelTurnResult & { text: string } {
  const candidate = result as ChannelTurnResult;
  if (candidate.files?.length || candidate.posts?.length || candidate.stream) {
    throw new ChannelConversationError(
      `${failure.label} supports only text and actions`,
      failure.code,
    );
  }
  try {
    const projected = prepareProjectLoopResult({
      presentation: {
        text: result.text,
        ...(result.actions ? { actions: result.actions } : {}),
      },
    }, {});
    return {
      text: projected.presentation!.text,
      ...(projected.presentation?.actions?.length
        ? { actions: [...projected.presentation.actions] }
        : {}),
    };
  } catch (error) {
    throw new ChannelConversationError(
      error instanceof Error ? error.message : `${failure.label} is invalid`,
      failure.code,
      error,
    );
  }
}

function runtimeWithoutRouteToolPolicy(
  runtime: RunConversationTurnInput["runtime"],
): RunConversationTurnInput["runtime"] {
  if (!runtime?.toolPolicy?.routeAllowedTools) return runtime;
  const {
    routeAllowedTools: _routeAllowedTools,
    ...toolPolicy
  } = runtime.toolPolicy;
  return {
    ...runtime,
    ...(Object.keys(toolPolicy).length > 0 ? { toolPolicy } : { toolPolicy: undefined }),
  };
}

function invocationWithMetadata(
  invocation: ToolInvocationContext,
  metadata: Readonly<Record<string, ToolInvocationJsonValue>>,
  sessionId?: string | null,
): ToolInvocationContext {
  return createToolInvocationContext({
    requestId: invocation.requestId,
    runId: invocation.runId,
    ...(sessionId ? { sessionId } : invocation.sessionId ? { sessionId: invocation.sessionId } : {}),
    ...(invocation.user ? { user: invocation.user } : {}),
    metadata: { ...metadata },
    ...(invocation.scope ? { scope: invocation.scope } : {}),
    surface: invocation.surface,
  });
}

function clientToolRequestFields(
  tools: readonly ChannelClientToolDefinition[] | undefined,
): Pick<RunConversationTurnInput["body"], "parallel_tool_calls" | "tool_choice" | "tools"> | Record<string, never> {
  if (!tools?.length) return {};
  return {
    parallel_tool_calls: false,
    tool_choice: "auto",
    tools: [...tools],
  };
}

function channelClientToolIdempotencyKey(
  turn: ChannelInboundTurn,
  index: number,
  toolName: string,
): string {
  const source = [
    "channel-client-tool",
    turn.provider,
    turn.installationId,
    turn.providerEventId,
    String(index),
    toolName,
  ].join(":");
  return `channel-client-tool:${createHash("sha256").update(source).digest("hex")}`;
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
    .filter((message): message is typeof message & { role: "assistant" | "user" } =>
      message.role === "assistant" || message.role === "user")
    .map((message) => ({
      content: normalizeStoredContent(message.content),
      role: message.role,
    }));
}

async function channelTurnContent(
  turn: ChannelInboundTurn,
  options: ConversationChannelBridgeOptions,
  invocation?: ToolInvocationContext,
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
        ? await options.resolveAttachment(attachment, {
            invocation,
            message,
            turn,
          })
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
