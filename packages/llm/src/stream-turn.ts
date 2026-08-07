import {
  streamText,
  Output,
  type FinishReason,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderMetadata,
  type StreamTextResult,
  type ToolChoice,
  type ToolSet,
  type TypedToolCall,
  type TypedToolError,
  type TypedToolResult,
} from "ai";

export type ModelTurnEvent<TOOLS extends ToolSet = ToolSet> =
  | { type: "reasoning-delta"; id: string; text: string }
  | { type: "text-delta"; id: string; text: string }
  | { type: "tool-input-start"; id: string; name: string; providerExecuted?: boolean; dynamic?: boolean; title?: string }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      args: unknown;
      providerExecuted?: boolean;
      dynamic?: boolean;
      invalid?: boolean;
      error?: unknown;
    }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "tool-error"; id: string; name: string; error: unknown }
  | { type: "finish"; finishReason: FinishReason; rawFinishReason?: string; totalUsage?: LanguageModelUsage }
  | { type: "error"; error: unknown };

export type ModelTurnResult<TOOLS extends ToolSet = ToolSet> = {
  text: string;
  /** Complete parsed output when a structured output specification was used. */
  output?: unknown;
  toolCalls: TypedToolCall<TOOLS>[];
  toolResults: TypedToolResult<TOOLS>[];
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  finishReason: FinishReason;
  rawFinishReason?: string;
  providerMetadata?: ProviderMetadata;
  responseMessages: unknown[];
  response?: Awaited<StreamTextResult<TOOLS, any>["response"]>;
};

export type StreamModelTurnInput<TOOLS extends ToolSet = ToolSet> = {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: TOOLS;
  activeTools?: Array<keyof TOOLS>;
  toolChoice?: ToolChoice<TOOLS>;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  output?: Output.Output<unknown, unknown, unknown>;
};

type ModelTransportIdentity = {
  provider?: unknown;
  modelId?: unknown;
};

const MISSING_TOOL_RESULT_MESSAGE =
  "Tool result unavailable: the prior execution did not return a result.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && value.trim().length > 0,
  )?.trim();
}

function parseObjectInputCandidate(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseObjectInput(...values: unknown[]): Record<string, unknown> {
  for (const value of values) {
    const parsed = parseObjectInputCandidate(value);
    if (parsed) return parsed;
  }
  return {};
}

function canonicalToolCallPart(part: Record<string, unknown>): Record<string, unknown> {
  const fn = isRecord(part.function) ? part.function : undefined;
  const toolCallId = nonEmptyString(part.toolCallId, part.id, part.tool_call_id);
  const toolName = nonEmptyString(part.toolName, part.name, fn?.name);

  return {
    ...part,
    type: "tool-call",
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    input: parseObjectInput(part.input, part.args, part.arguments, fn?.arguments),
  };
}

function normalizeToolResultOutput(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    if (
      value.type === "text"
      || value.type === "json"
      || value.type === "error-text"
      || value.type === "error-json"
      || value.type === "content"
      || value.type === "execution-denied"
    ) {
      return value;
    }
    return { type: "json", value };
  }
  if (typeof value === "string") return { type: "text", value };
  if (value === undefined) return { type: "text", value: "(empty tool result)" };
  return { type: "json", value };
}

function canonicalToolResultPart(
  part: Record<string, unknown>,
  fallbackName?: string,
): Record<string, unknown> {
  const toolCallId = nonEmptyString(part.toolCallId, part.id, part.tool_call_id);
  // The matching call is authoritative. OpenAI-compatible tool result
  // messages commonly omit the name, and legacy callers sometimes persisted
  // a placeholder such as "unknown".
  const toolName = nonEmptyString(fallbackName, part.toolName, part.name);
  const outputSource = Object.prototype.hasOwnProperty.call(part, "output")
    ? part.output
    : part.result;
  return {
    ...part,
    type: "tool-result",
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
    output: normalizeToolResultOutput(outputSource),
  };
}

export function normalizeResponseMessagesForHistory(responseMessages: unknown): ModelMessage[] {
  if (!Array.isArray(responseMessages)) return [];

  return responseMessages.map((message) => {
    if (!message || typeof message !== "object") return message as ModelMessage;

    const record = message as Record<string, unknown>;
    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      const content = Array.isArray(record.content)
        ? [...record.content]
        : typeof record.content === "string" && record.content.trim() !== ""
          ? [{ type: "text", text: record.content }]
          : [];
      for (const toolCall of record.tool_calls) {
        if (isRecord(toolCall)) content.push(canonicalToolCallPart(toolCall));
      }
      const { tool_calls: _toolCalls, ...rest } = record;
      return { ...rest, content } as ModelMessage;
    }
    if (
      record.role === "tool"
      && !Array.isArray(record.content)
      && nonEmptyString(record.tool_call_id, record.toolCallId)
    ) {
      const { tool_call_id: _toolCallId, name: _name, ...rest } = record;
      return {
        ...rest,
        role: "tool",
        content: [canonicalToolResultPart({
          toolCallId: nonEmptyString(record.tool_call_id, record.toolCallId),
          toolName: nonEmptyString(record.name),
          output: record.content,
        })],
      } as ModelMessage;
    }
    if (!Array.isArray(record.content)) return message as ModelMessage;

    let changed = false;
    const normalizedContent = record.content.map((part) => {
      if (!part || typeof part !== "object") return part;

      const partRecord = part as Record<string, unknown>;
      if (partRecord.type !== "tool-call" && partRecord.type !== "tool_call") return part;

      const normalized = canonicalToolCallPart(partRecord);
      if (
        partRecord.type !== "tool-call"
        || !isRecord(partRecord.input)
        || partRecord.toolCallId !== normalized.toolCallId
        || partRecord.toolName !== normalized.toolName
      ) {
        changed = true;
      }
      return normalized;
    });

    return changed
      ? ({ ...(message as Record<string, unknown>), content: normalizedContent } as ModelMessage)
      : (message as ModelMessage);
  });
}

/**
 * Canonicalize persisted/provider history before every model request.
 *
 * AI SDK and provider APIs require each non-provider tool call to have an
 * object input and a matching result before another conversational message.
 * Histories can violate that contract after partial streams, interrupted
 * client-side tools, legacy persistence, or malformed provider output. This
 * boundary repairs recoverable history and records an explicit failed result
 * instead of forwarding an invalid prompt to the model gateway.
 */
export function prepareModelMessagesForProvider(messages: unknown): ModelMessage[] {
  const normalized = normalizeResponseMessagesForHistory(messages);
  const output: ModelMessage[] = [];
  const pending = new Map<string, string>();
  const approvalCalls = new Map<string, string>();
  const seenToolCallIds = new Set<string>();

  const flushMissingResults = () => {
    if (pending.size === 0) return;
    output.push({
      role: "tool",
      content: [...pending.entries()].map(([toolCallId, toolName]) => ({
        type: "tool-result" as const,
        toolCallId,
        toolName,
        output: {
          type: "error-text" as const,
          value: MISSING_TOOL_RESULT_MESSAGE,
        },
      })),
    });
    pending.clear();
  };

  for (const message of normalized) {
    if (!isRecord(message)) continue;
    const role = message.role;

    if (role !== "tool") flushMissingResults();

    if (role === "assistant" && Array.isArray(message.content)) {
      const content: unknown[] = [];
      for (const rawPart of message.content) {
        if (!isRecord(rawPart)) continue;
        const partRecord = rawPart as Record<string, unknown>;

        if (partRecord.type === "tool-call" || partRecord.type === "tool_call") {
          const part = canonicalToolCallPart(partRecord);
          const toolCallId = nonEmptyString(part.toolCallId);
          const toolName = nonEmptyString(part.toolName);
          if (!toolCallId || !toolName || seenToolCallIds.has(toolCallId)) continue;
          seenToolCallIds.add(toolCallId);
          content.push(part);
          if (part.providerExecuted !== true) pending.set(toolCallId, toolName);
          continue;
        }

        if (partRecord.type === "tool-result") {
          const toolCallId = nonEmptyString(partRecord.toolCallId, partRecord.id, partRecord.tool_call_id);
          if (!toolCallId && partRecord.providerExecuted !== true) continue;
          content.push(canonicalToolResultPart(partRecord));
          if (toolCallId) pending.delete(toolCallId);
          continue;
        }

        if (partRecord.type === "tool-approval-request") {
          const approvalId = nonEmptyString(partRecord.approvalId);
          const approvalToolCall = isRecord(partRecord.toolCall) ? partRecord.toolCall : undefined;
          const toolCallId = nonEmptyString(partRecord.toolCallId, approvalToolCall?.toolCallId);
          if (approvalId && toolCallId) approvalCalls.set(approvalId, toolCallId);
        }

        content.push(rawPart);
      }
      if (content.length > 0) {
        output.push({ ...message, content } as ModelMessage);
      }
      continue;
    }

    if (role === "tool" && Array.isArray(message.content)) {
      const content: unknown[] = [];
      for (const rawPart of message.content) {
        if (!isRecord(rawPart)) continue;
        const partRecord = rawPart as Record<string, unknown>;
        if (partRecord.type === "tool-approval-response") {
          const approvalId = nonEmptyString(partRecord.approvalId);
          const toolCallId = approvalId ? approvalCalls.get(approvalId) : undefined;
          if (toolCallId) pending.delete(toolCallId);
          content.push(rawPart);
          continue;
        }
        if (partRecord.type !== "tool-result") {
          content.push(rawPart);
          continue;
        }

        const toolCallId = nonEmptyString(partRecord.toolCallId, partRecord.id, partRecord.tool_call_id);
        if (!toolCallId) continue;
        const toolName = pending.get(toolCallId);
        if (!toolName) continue;
        content.push(canonicalToolResultPart(partRecord, toolName));
        pending.delete(toolCallId);
      }
      if (content.length > 0) {
        output.push({ ...message, content } as ModelMessage);
      }
      continue;
    }

    if ((role === "assistant" || role === "user") && message.content == null) {
      continue;
    }

    output.push(message);
  }

  flushMissingResults();
  return output;
}

const OPENAI_RESERVED_FUNCTION_NAMES = new Set(["tool_search"]);

function usesOpenAIResponsesTransport(model: ModelTransportIdentity | string): boolean {
  if (!isRecord(model)) return false;
  const provider = String(model.provider ?? "").toLowerCase();
  const modelId = String(model.modelId ?? "").toLowerCase();
  return provider === "openai"
    || provider.endsWith(".responses")
    || (provider === "gateway" && modelId.startsWith("openai/"));
}

function serializeToolTranscriptValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify("(unserializable value)");
  }
}

function toolTranscriptText(
  kind: "call" | "result",
  entries: Array<Record<string, unknown>>,
): string {
  return [
    `[Polpo tool ${kind}${entries.length === 1 ? "" : "s"}]`,
    serializeToolTranscriptValue(entries),
  ].join("\n");
}

/**
 * Work around provider-defined tool name collisions in OpenAI Responses.
 *
 * OpenAI currently reserves `tool_search`. Its Responses history converter
 * can replay an ordinary function with that name as a native tool-search item,
 * dropping `arguments` and rejecting the next request. Keep every unrelated
 * tool structurally typed, but render colliding historical call/result pairs
 * as an explicit transcript so legacy sessions remain usable.
 */
function flattenReservedOpenAIToolHistory(messages: ModelMessage[]): ModelMessage[] {
  const collidingCalls = new Map<string, { id: string; name: string; input: unknown }>();
  const pendingTranscriptResults: Array<Record<string, unknown>> = [];
  const output: ModelMessage[] = [];

  const flushTranscriptResults = () => {
    if (pendingTranscriptResults.length === 0) return;
    output.push({
      role: "user",
      content: toolTranscriptText("result", pendingTranscriptResults.splice(0)),
    });
  };

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      flushTranscriptResults();
      output.push(message);
      continue;
    }

    // Keep all ordinary parallel tool results adjacent to their calls. The
    // transcript for a colliding result is inserted only after the complete
    // consecutive tool-result group has been processed.
    if (message.role !== "tool") flushTranscriptResults();

    if (message.role === "assistant") {
      const content: unknown[] = [];
      const calls: Array<Record<string, unknown>> = [];
      let collided = false;

      for (const rawPart of message.content) {
        if (!isRecord(rawPart)) continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type === "tool-call") {
          const id = nonEmptyString(part.toolCallId);
          const name = nonEmptyString(part.toolName);
          if (
            id
            && name
            && part.providerExecuted !== true
            && OPENAI_RESERVED_FUNCTION_NAMES.has(name)
          ) {
            const call = { id, name, input: parseObjectInput(part.input) };
            collidingCalls.set(id, call);
            calls.push({ id, name, arguments: call.input });
            collided = true;
            continue;
          }
        }

        // OpenAI reasoning item ids belong to the response item sequence that
        // contained the colliding native-looking call. Do not replay them after
        // replacing that call with transport-neutral text.
        if (collided && part.type === "reasoning") continue;
        content.push(part);
      }

      if (calls.length > 0) {
        const withoutReasoning = content.filter((part) =>
          !isRecord(part) || part.type !== "reasoning",
        );
        withoutReasoning.push({ type: "text", text: toolTranscriptText("call", calls) });
        const { providerOptions: _providerOptions, ...rest } = message;
        output.push({ ...rest, content: withoutReasoning } as ModelMessage);
      } else {
        output.push(message);
      }
      continue;
    }

    if (message.role === "tool") {
      const structuralResults: unknown[] = [];
      const transcriptResults: Array<Record<string, unknown>> = [];

      for (const rawPart of message.content) {
        const part = rawPart as unknown as Record<string, unknown>;
        if (!isRecord(rawPart) || part.type !== "tool-result") {
          structuralResults.push(rawPart);
          continue;
        }
        const id = nonEmptyString(part.toolCallId);
        const call = id ? collidingCalls.get(id) : undefined;
        if (!id || !call) {
          structuralResults.push(rawPart);
          continue;
        }
        transcriptResults.push({
          id,
          name: call.name,
          output: part.output,
        });
        collidingCalls.delete(id);
      }

      if (structuralResults.length > 0) {
        output.push({ ...message, content: structuralResults } as ModelMessage);
      }
      if (transcriptResults.length > 0) {
        pendingTranscriptResults.push(...transcriptResults);
      }
      continue;
    }

    output.push(message);
  }

  flushTranscriptResults();
  return output;
}

/** Prepare valid history and apply transport-specific compatibility rules. */
export function prepareModelMessagesForTransport(
  messages: unknown,
  model: ModelTransportIdentity | string,
): ModelMessage[] {
  const prepared = prepareModelMessagesForProvider(messages);
  return usesOpenAIResponsesTransport(model)
    ? flattenReservedOpenAIToolHistory(prepared)
    : prepared;
}

function normalizeToolCallInput<TOOLS extends ToolSet>(toolCall: TypedToolCall<TOOLS>): TypedToolCall<TOOLS> {
  if ("input" in toolCall && toolCall.input != null) return toolCall;
  return { ...toolCall, input: {} } as TypedToolCall<TOOLS>;
}

export async function streamModelTurn<TOOLS extends ToolSet = ToolSet>(
  input: StreamModelTurnInput<TOOLS>,
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
): Promise<ModelTurnResult<TOOLS>> {
  const result = streamText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: prepareModelMessagesForTransport(input.messages, input.model),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.activeTools ? { activeTools: input.activeTools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions as any } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
    ...(input.output ? { output: input.output } : {}),
  });

  let text = "";

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "reasoning-delta":
        await onEvent?.({ type: "reasoning-delta", id: part.id, text: part.text });
        break;
      case "text-delta":
        text += part.text;
        await onEvent?.({ type: "text-delta", id: part.id, text: part.text });
        break;
      case "tool-input-start":
        await onEvent?.({
          type: "tool-input-start",
          id: part.id,
          name: part.toolName,
          providerExecuted: part.providerExecuted,
          dynamic: part.dynamic,
          title: part.title,
        });
        break;
      case "tool-input-delta":
        await onEvent?.({ type: "tool-input-delta", id: part.id, delta: part.delta });
        break;
      case "tool-input-end":
        await onEvent?.({ type: "tool-input-end", id: part.id });
        break;
      case "tool-call":
        await onEvent?.({
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          args: part.input,
          providerExecuted: part.providerExecuted,
          dynamic: part.dynamic,
          invalid: part.invalid,
          error: part.error,
        });
        break;
      case "tool-result":
        await onEvent?.({
          type: "tool-result",
          id: part.toolCallId,
          name: part.toolName,
          output: (part as TypedToolResult<TOOLS>).output,
        });
        break;
      case "tool-error":
        await onEvent?.({
          type: "tool-error",
          id: part.toolCallId,
          name: part.toolName,
          error: (part as TypedToolError<TOOLS>).error,
        });
        break;
      case "finish":
        await onEvent?.({
          type: "finish",
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
          totalUsage: part.totalUsage,
        });
        break;
      case "error":
        await onEvent?.({ type: "error", error: part.error });
        break;
    }
  }

  const responsePromise = Promise.resolve()
    .then(() => result.response)
    .catch(() => undefined);
  const providerMetadataPromise = Promise.resolve()
    .then(() => result.providerMetadata)
    .catch(() => undefined);
  const toolResultsPromise = Promise.resolve()
    .then(() => result.toolResults)
    .catch(() => [] as TypedToolResult<TOOLS>[]);

  const [toolCalls, toolResults, usage, totalUsage, finishReason, rawFinishReason, response, providerMetadata] =
    await Promise.all([
      result.toolCalls,
      toolResultsPromise,
      result.usage,
      result.totalUsage,
      result.finishReason,
      result.rawFinishReason,
      responsePromise,
      providerMetadataPromise,
    ]);
  const output = input.output && toolCalls.length === 0
    ? await result.output
    : undefined;

  return {
    text,
    ...(output !== undefined ? { output } : {}),
    toolCalls: toolCalls.map(normalizeToolCallInput),
    toolResults,
    usage,
    totalUsage,
    finishReason,
    rawFinishReason,
    providerMetadata,
    responseMessages: normalizeResponseMessagesForHistory(response?.messages ?? []),
    response,
  };
}
