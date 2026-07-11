import {
  streamText,
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
  | { type: "tool-call"; id: string; name: string; args: unknown; providerExecuted?: boolean; dynamic?: boolean }
  | { type: "tool-result"; id: string; name: string; output: unknown }
  | { type: "tool-error"; id: string; name: string; error: unknown }
  | { type: "finish"; finishReason: FinishReason; rawFinishReason?: string; totalUsage?: LanguageModelUsage }
  | { type: "error"; error: unknown };

export type ModelTurnResult<TOOLS extends ToolSet = ToolSet> = {
  text: string;
  toolCalls: TypedToolCall<TOOLS>[];
  toolResults: TypedToolResult<TOOLS>[];
  usage: LanguageModelUsage;
  totalUsage: LanguageModelUsage;
  finishReason: FinishReason;
  rawFinishReason?: string;
  providerMetadata?: ProviderMetadata;
  responseMessages: unknown[];
  response: Awaited<StreamTextResult<TOOLS, any>["response"]>;
};

export type StreamModelTurnInput<TOOLS extends ToolSet = ToolSet> = {
  model: LanguageModel;
  system?: string;
  messages: ModelMessage[];
  tools?: TOOLS;
  toolChoice?: ToolChoice<TOOLS>;
  maxOutputTokens?: number;
  providerOptions?: Record<string, unknown>;
  abortSignal?: AbortSignal;
};

export async function streamModelTurn<TOOLS extends ToolSet = ToolSet>(
  input: StreamModelTurnInput<TOOLS>,
  onEvent?: (event: ModelTurnEvent<TOOLS>) => void | Promise<void>,
): Promise<ModelTurnResult<TOOLS>> {
  const result = streamText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
    ...(input.maxOutputTokens ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.providerOptions ? { providerOptions: input.providerOptions as any } : {}),
    ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
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

  const [toolCalls, toolResults, usage, totalUsage, finishReason, rawFinishReason, response, providerMetadata] =
    await Promise.all([
      result.toolCalls,
      result.toolResults,
      result.usage,
      result.totalUsage,
      result.finishReason,
      result.rawFinishReason,
      result.response,
      result.providerMetadata,
    ]);

  return {
    text,
    toolCalls,
    toolResults,
    usage,
    totalUsage,
    finishReason,
    rawFinishReason,
    providerMetadata,
    responseMessages: response.messages,
    response,
  };
}
