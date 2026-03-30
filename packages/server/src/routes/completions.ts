/**
 * OpenAI-compatible chat completions endpoint.
 *
 * POST /v1/chat/completions
 *
 * This is Polpo's primary conversational interface. It accepts OpenAI-format
 * messages, runs the full agentic tool loop internally, and returns
 * responses in OpenAI-compatible format — both streaming (SSE) and non-streaming.
 *
 * Supports two modes:
 * - **Orchestrator mode** (default): The caller talks to Polpo. Polpo has 100+
 *   orchestration tools (tasks, missions, agents, vault, etc.).
 * - **Agent-direct mode** (`agent` field): The caller talks directly to a
 *   specific agent. The agent uses its own model, system prompt, and coding
 *   tools — bypassing the orchestrator entirely.
 *
 * LLM calls use Vercel AI SDK's streamText/generateText directly.
 * Tools are passed WITHOUT execute functions — execution is manual via
 * the effectiveToolExecutor callback from deps.
 */

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import { agentMemoryScope, compactIfNeeded, type SummarizeFn, type CompactionEvent } from "@polpo-ai/core";
import { streamText, generateText, jsonSchema, type LanguageModel, type LanguageModelUsage } from "ai";

const MAX_TURNS = 20;

/** Tools that write/modify files — emit file:changed after successful execution */
const FILE_WRITE_TOOLS: Record<string, "created" | "modified"> = {
  write_file: "created",
  edit_file: "modified",
};

/** Emit file:changed if a file-writing tool succeeded */
function emitFileChanged(
  toolName: string,
  args: Record<string, unknown>,
  result: string,
  emit: (event: string, data: any) => void,
): void {
  const action = FILE_WRITE_TOOLS[toolName];
  if (!action || result.startsWith("Error:")) return;
  const path = args.path as string | undefined;
  if (!path) return;
  const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
  emit("file:changed", { path, dir, action, source: "chat" });
}

/**
 * Redact sensitive credential values from vault tool call arguments before persistence.
 * Returns a sanitized copy — original is NOT mutated.
 */
function redactVaultToolCalls(toolCalls: any[]): any[] {
  // @ts-ignore — ToolCallInfo shape preserved via duck typing
  return toolCalls.map(tc => {
    if ((tc.name !== "set_vault_entry" && tc.name !== "update_vault_credentials") || !tc.arguments) return tc;
    const args = { ...tc.arguments };
    if (args.credentials && typeof args.credentials === "object") {
      // Replace each credential value with a redacted marker, preserve keys for display
      const redacted: Record<string, string> = {};
      for (const key of Object.keys(args.credentials as Record<string, string>)) {
        redacted[key] = "[REDACTED]";
      }
      args.credentials = redacted;
    }
    return { ...tc, arguments: args };
  });
}

// ── Zod Schemas ────────────────────────────────────────────────────────

/** OpenAI-compatible content part (text, image_url, or file reference). */
const contentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image_url"),
    image_url: z.object({
      url: z.string().openapi({ description: "Data URL (data:image/…;base64,…) or HTTPS URL" }),
      detail: z.enum(["auto", "low", "high"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("file"),
    file_id: z.string().openapi({ description: "Attachment ID from a previous upload" }),
  }),
]);

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]).openapi({
    description: "Message role. System messages are appended as additional context. Tool messages carry results of client-side tool calls.",
  }),
  content: z.union([
    z.string(),
    z.array(contentPartSchema),
  ]).openapi({ description: "Message content — plain string or array of content parts (text / image_url)" }),
  tool_call_id: z.string().optional().openapi({
    description: "ID of the tool call this message responds to (required for role=tool)",
  }),
  name: z.string().optional().openapi({
    description: "Tool name (for role=tool messages)",
  }),
});

const completionRequestSchema = z.object({
  messages: z.array(messageSchema).min(1).openapi({
    description: "Conversation messages in OpenAI format",
  }),
  stream: z.boolean().optional().default(false).openapi({
    description: "If true, returns an SSE stream of OpenAI-format chunks. If false, returns a complete response.",
  }),
  model: z.string().optional().openapi({
    description: "Ignored. Polpo uses its configured orchestrator model (or the agent's model in agent-direct mode).",
  }),
  temperature: z.number().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  max_tokens: z.number().int().optional().openapi({
    description: "Ignored. Reserved for future use.",
  }),
  agent: z.string().optional().openapi({
    description: "Target a specific agent by name for direct conversation. Uses the agent's own model, system prompt, and coding tools instead of the orchestrator. Omit to talk to the orchestrator (default).",
  }),
  project: z.string().optional().openapi({
    description: "Deprecated. Ignored.",
  }),
});

const completionResponseSchema = z.object({
  id: z.string().openapi({ description: "Unique completion ID (chatcmpl-...)" }),
  object: z.literal("chat.completion"),
  created: z.number().int().openapi({ description: "Unix timestamp" }),
  model: z.literal("polpo"),
  choices: z.array(z.object({
    index: z.number().int(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
    }),
    finish_reason: z.enum(["stop", "length", "ask_user", "mission_preview", "vault_preview"]),
  })),
  usage: z.object({
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
  }),
});

const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string().optional(),
  }),
});

// ── Route definition ───────────────────────────────────────────────────

const chatCompletionsRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["Chat Completions"],
  summary: "Chat completions",
  description: "Polpo's primary conversational interface. Send messages in OpenAI format, receive responses in OpenAI format. Polpo runs its full 37-tool agentic loop internally — you describe what you need, Polpo handles the rest. Supports streaming (SSE) and non-streaming modes.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: completionRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: completionResponseSchema,
        },
      },
      description: "Chat completion response (non-streaming). When stream=true, returns text/event-stream with OpenAI-format chunks ending with data: [DONE].",
    },
    400: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid request (missing messages or no project available)",
    },
    401: {
      content: {
        "application/json": {
          schema: errorResponseSchema,
        },
      },
      description: "Invalid API key",
    },
  },
});

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract plain text from a content field (string or content-part array). */
function extractText(content: z.infer<typeof messageSchema>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/** Resolve file content parts → text references the agent can act on with its tools. */
function resolveFileContentParts(
  content: z.infer<typeof messageSchema>["content"],
): z.infer<typeof messageSchema>["content"] {
  if (typeof content === "string" || !content.some((p) => p.type === "file")) return content;

  const resolved: z.infer<typeof contentPartSchema>[] = [];
  for (const part of content) {
    if (part.type !== "file") {
      resolved.push(part);
      continue;
    }
    // file_id is a workspace-relative path — just pass it as a text reference.
    // The agent has read_file / list_files tools to access the actual content.
    resolved.push({
      type: "text",
      text: `[Attached file: ${part.file_id}]`,
    });
  }
  return resolved;
}

/**
 * Convert OpenAI-format content to AI SDK UserContent.
 *
 * AI SDK ImagePart: { type: "image", image: DataContent | URL, mediaType?: string }
 * AI SDK TextPart:  { type: "text", text: string }
 */
function toAIContent(content: z.infer<typeof messageSchema>["content"]): string | ({ type: "text"; text: string } | { type: "image"; image: string; mediaType?: string })[] {
  if (typeof content === "string") return content;

  // Check if there are any image parts
  const hasImages = content.some((p) => p.type === "image_url");
  if (!hasImages) {
    // Text-only array → flatten to plain string
    return content.map((p) => (p as { type: "text"; text: string }).text).join("\n");
  }

  // Mixed content → convert to AI SDK TextPart | ImagePart array
  return content.map((p) => {
    if (p.type === "text") {
      return { type: "text" as const, text: p.text };
    }
    if (p.type === "image_url") {
      const url = p.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { type: "image" as const, image: match[2], mediaType: match[1] };
      }
      return { type: "image" as const, image: url, mediaType: "image/png" };
    }
    // file parts should have been resolved by resolveFileContentParts already
    return { type: "text" as const, text: "" };
  }).filter((p) => p.type !== "text" || p.text !== "");
}

/**
 * Convert OpenAI-format messages from the request into AI SDK ModelMessage format.
 *
 * - System messages → extracted as extra context (appended to system prompt)
 * - User messages → { role: "user", content } with AI SDK content parts
 * - Assistant messages → { role: "assistant", content: string }
 */
function convertMessages(
  messages: z.infer<typeof messageSchema>[],
): { aiMessages: any[]; extraSystemParts: string[] } {
  const aiMessages: any[] = [];
  const extraSystemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      extraSystemParts.push(extractText(msg.content));
    } else if (msg.role === "user") {
      // Resolve file content parts → text references (only in the AI SDK message, not persisted)
      const resolvedContent = resolveFileContentParts(msg.content);
      aiMessages.push({ role: "user", content: toAIContent(resolvedContent) });
    } else if (msg.role === "assistant") {
      aiMessages.push({ role: "assistant", content: extractText(msg.content) });
    } else if (msg.role === "tool" && msg.tool_call_id) {
      // Client-side tool result — convert to AI SDK tool-result format
      aiMessages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id,
          toolName: msg.name ?? "unknown",
          output: { type: "text" as const, value: extractText(msg.content) },
        }],
      });
    }
  }

  return { aiMessages, extraSystemParts };
}

function sseChunk(
  id: string,
  delta: { content?: string; role?: string },
  finishReason: string | null = null,
  extra?: Record<string, unknown>,
): string {
  return JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "polpo",
    choices: [{
      index: 0,
      delta,
      finish_reason: finishReason,
      ...extra,
    }],
  });
}

/**
 * Build a SummarizeFn using AI SDK's generateText.
 * Used by context compaction to summarize conversation history.
 */
function buildSummarizeFn(
  m: ResolvedModelInfo,
  providerOptions?: Record<string, any>,
): SummarizeFn {
  return async (msgs: any[], prompt: string): Promise<string> => {
    const result = await generateText({
      model: m.aiModel,
      system: prompt,
      messages: msgs,
      providerOptions,
    });
    return result.text.trim();
  };
}

function completionResponse(id: string, content: string, usage: LanguageModelUsage) {
  return {
    id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model: "polpo" as const,
    choices: [{
      index: 0,
      message: { role: "assistant" as const, content },
      finish_reason: "stop" as const,
    }],
    usage: {
      prompt_tokens: usage.inputTokens ?? 0,
      completion_tokens: usage.outputTokens ?? 0,
      total_tokens: usage.totalTokens ?? 0,
    },
  };
}

/**
 * Convert Polpo tools to AI SDK tool format (without execute functions).
 *
 * AI SDK tools: Record<string, { description, inputSchema }>
 * Tools without execute are "manual" — tool calls are returned but not auto-executed.
 */
function toAITools(tools: any[]): Record<string, { description?: string; inputSchema: any }> {
  if (!tools.length) return {};
  return Object.fromEntries(
    tools.map(t => [t.name, {
      description: t.description,
      inputSchema: jsonSchema(t.parameters),
    }]),
  );
}

// ── Client-side tools ────────────────────────────────────────────────────
// These tools have NO server-side execute. When the LLM calls them, the
// server stops the tool loop and returns the tool call to the client via
// standard OpenAI finish_reason: "tool_calls". The client handles them
// (shows UI, collects input) and sends the result back as a tool message.

const CLIENT_SIDE_TOOLS: Record<string, { description: string; inputSchema: any }> = {
  ask_user_question: {
    description: [
      "Ask the user clarifying questions before proceeding.",
      "Use when the request is ambiguous or has multiple valid interpretations.",
      "Each question has pre-populated selectable options the user can pick from.",
      "Do NOT ask for information you can infer from context or memory.",
      "Do NOT ask obvious questions — if there's one clear interpretation, just do it.",
      "Pre-populate options with the most likely choices. Be concise (1-5 words per label).",
      "If you recommend one option, put it first and add '(Recommended)' to its label.",
      "After receiving answers, proceed immediately — don't summarize the answers back.",
      "Max 5 questions per call. Prefer fewer, more focused questions.",
    ].join(" "),
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "List of questions to ask the user",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique question key for matching answers (e.g. 'auth-method')" },
              question: { type: "string", description: "The question text" },
              header: { type: "string", description: "Short label for compact display (max 30 chars)" },
              options: {
                type: "array",
                description: "Pre-populated selectable options",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Option label (1-5 words)" },
                    description: { type: "string", description: "Optional longer description" },
                  },
                  required: ["label"],
                },
              },
              multiple: { type: "boolean", description: "Allow selecting multiple options (default: false)" },
              custom: { type: "boolean", description: "Show a 'Type your own answer' input (default: true)" },
            },
            required: ["id", "question", "options"],
          },
        },
      },
      required: ["questions"],
    }),
  },
};

/** Set of tool names that are client-side (no server execute). */
const CLIENT_SIDE_TOOL_NAMES = new Set(Object.keys(CLIENT_SIDE_TOOLS));

// ── Route factory ──────────────────────────────────────────────────────

/**
 * Minimal model info needed by the completions route.
 * Matches the shape returned by resolveAgentModel.
 */
interface ResolvedModelInfo {
  aiModel: LanguageModel;
  provider: string;
  contextWindow: number;
  maxTokens: number;
}

/**
 * Completion route dependencies.
 *
 * The consumer provides LLM resolution and tool creation — this allows
 * the route to run on any runtime (Node.js with full tools, or edge with no tools).
 *
 * LLM streaming is handled directly via AI SDK streamText/generateText.
 */
export interface CompletionRouteDeps {
  getAgents: () => Promise<any[]>;
  getConfig: () => any;
  getMemoryStore: () => any;
  getSessionStore: () => any;
  getStore: () => any;
  emit: (event: string, data: any) => void;
  /** Resolve agent model. Must return an object with aiModel (LanguageModel), provider, contextWindow, maxTokens, and providerOptions. */
  resolveAgentModel: (agentConfig: any, settingsReasoning?: string) => Promise<{
    model: ResolvedModelInfo;
    providerOptions?: Record<string, any>;
  }>;
  /** Build agent system prompt for conversational mode. */
  buildAgentPrompt: (agentConfig: any) => string | Promise<string>;
  /** Create tools + executor for the agent. Return empty arrays for chat-only. */
  resolveAgentTools: (agentConfig: any) => Promise<{
    tools: any[];
    executor: (name: string, args: Record<string, unknown>) => Promise<string>;
  }>;
  /** Orchestrator mode support (optional — returns 501 if not provided). */
  resolveOrchestratorContext?: () => Promise<{
    systemPrompt: string;
    model: ResolvedModelInfo;
    providerOptions?: Record<string, any>;
    tools: any[];
    executor: (name: string, args: Record<string, unknown>) => Promise<string>;
    isInteractive: (name: string) => boolean;
  }>;
}

export function completionRoutes(getDeps: () => CompletionRouteDeps, apiKeys?: string[]): OpenAPIHono {
  const app = new OpenAPIHono();

  app.openapi(chatCompletionsRoute, async (c) => {
    const deps = getDeps();

    // ── Auth ──
    if (apiKeys && apiKeys.length > 0) {
      const auth = c.req.header("Authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (!token || !apiKeys.includes(token)) {
        return c.json({ error: { message: "Invalid API key", type: "invalid_request_error", code: "invalid_api_key" } }, 401);
      }
    }

    // ── Parse body ──
    const body = c.req.valid("json");
    const agentMode = !!body.agent;

    // ── Resolve effective context (orchestrator vs agent-direct) ──
    let fullSystemPrompt: string;
    let m: ResolvedModelInfo;
    let providerOpts: Record<string, any> | undefined;
    let effectiveTools: any[];
    let effectiveToolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
    let isInteractiveFn: ((name: string) => boolean) | undefined;

    const { aiMessages, extraSystemParts } = convertMessages(body.messages);

    if (agentMode) {
      // ── Agent-direct mode ──
      const agents = await deps.getAgents();
      const agentConfig = agents.find((a: any) => a.name === body.agent);
      if (!agentConfig) {
        return c.json({ error: { message: `Agent "${body.agent}" not found`, type: "invalid_request_error", code: "agent_not_found" } }, 404);
      }

      // Build system prompt via dep
      const agentSystemPrompt = await deps.buildAgentPrompt(agentConfig);
      const conversationalPreamble = [
        "You are now in interactive conversation mode with the user.",
        "Unlike task execution, you should engage in dialogue: ask clarifying questions,",
        "explain your reasoning, and wait for user input when needed.",
        "You still have access to all your coding tools to help the user.",
      ].join("\n");

      const basePrompt = `${conversationalPreamble}\n\n${agentSystemPrompt}`;
      fullSystemPrompt = extraSystemParts.length > 0
        ? `${basePrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
        : basePrompt;

      // Inject agent memory
      const memoryStore = deps.getMemoryStore();
      const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
      if (agentMemory) {
        fullSystemPrompt += `\n\n## Your persistent memory\n\n${agentMemory}`;
      }

      // Resolve model via dep
      const reasoning = agentConfig.reasoning ?? deps.getConfig()?.settings?.reasoning;
      let resolved;
      try {
        resolved = await deps.resolveAgentModel(agentConfig, reasoning);
      } catch (modelErr) {
        const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
        return c.json({ error: { message: msg, type: "invalid_request_error" } }, 400 as any);
      }
      m = resolved.model;
      providerOpts = resolved.providerOptions;

      // Resolve tools via dep
      const { tools, executor } = await deps.resolveAgentTools(agentConfig);
      effectiveTools = tools;
      effectiveToolExecutor = executor;
    } else {
      // ── Orchestrator mode (default) ──
      if (!deps.resolveOrchestratorContext) {
        return c.json({
          error: { message: "Orchestrator mode is not available. Use agent-direct mode by specifying the 'agent' field.", type: "invalid_request_error", code: "orchestrator_unavailable" },
        }, 501 as any);
      }

      const ctx = await deps.resolveOrchestratorContext();
      fullSystemPrompt = extraSystemParts.length > 0
        ? `${ctx.systemPrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
        : ctx.systemPrompt;
      m = ctx.model;
      providerOpts = ctx.providerOptions;
      effectiveTools = ctx.tools;
      effectiveToolExecutor = ctx.executor;
      isInteractiveFn = ctx.isInteractive;
    }

    const completionId = `chatcmpl-${nanoid(24)}`;

    // ── Session persistence ──
    const sessionStore = deps.getSessionStore();
    const rawSessionHeader = c.req.header("x-session-id") ?? null;
    let sessionId: string | null = rawSessionHeader === "new" ? null : rawSessionHeader;
    if (sessionStore) {
      if (!sessionId) {
        const firstUserMsg = body.messages.find(m => m.role === "user");
        const sessionTitle = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 60) : undefined;
        // Agent scope: orchestrator sessions use null, agent sessions use the agent name
        const agentScope = agentMode ? body.agent! : null;

        // No session ID provided — always create a new session.
        // Clients that want to continue a conversation must pass x-session-id explicitly.
        sessionId = await sessionStore.create(sessionTitle, agentScope ?? undefined);
      }
      // Persist user message (only the last one — earlier messages are already persisted)
      const lastUserMsg = [...body.messages].reverse().find(m => m.role === "user");
      if (lastUserMsg && sessionId) {
        await sessionStore.addMessage(sessionId, "user", lastUserMsg.content);
      }
    }

    // Expose session ID to the client so it can track which session is active
    if (sessionId) {
      c.header("x-session-id", sessionId);
    }

    // Convert Polpo tools to AI SDK format (no execute — manual execution)
    // Client-side tools (ask_user_question, etc.) are added on top — they stop
    // the server loop and return to the client as standard tool_calls.
    const aiTools = { ...toAITools(effectiveTools), ...CLIENT_SIDE_TOOLS };

    if (body.stream) {
      // ── Streaming mode ──
      return streamSSE(c, async (stream) => {
        // Abort controller: cancelled when the client disconnects (closes SSE)
        const abortController = new AbortController();
        stream.onAbort(() => { abortController.abort(); });

        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });

        // Reserve a placeholder message in the store BEFORE streaming.
        // This guarantees the assistant message exists even if the client disconnects.
        let assistantMsgId: string | null = null;
        if (sessionStore && sessionId) {
          const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const messages: any[] = [...aiMessages];
        let finalText = "";
        let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
        const toolCallsAccum: any[] = [];

        try {
          for (let turn = 0; turn < MAX_TURNS; turn++) {
            // Bail out early if the client already disconnected
            if (abortController.signal.aborted) break;

            // Compact context if approaching the model's context window limit.
            // Under threshold this is just a cheap token estimation — zero LLM calls.
            const compactionResult = await compactIfNeeded({
              systemPrompt: fullSystemPrompt,
              messages,
              tools: effectiveTools,
              config: {
                contextWindow: m.contextWindow ?? 200_000,
                maxOutputTokens: m.maxTokens ?? 8192,
              },
              summarize: buildSummarizeFn(m, providerOpts),
              mode: "chat",
              onCompaction: async (event: CompactionEvent) => {
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, null, {
                    compaction: {
                      phase: event.phase,
                      tokensBefore: event.tokensBefore,
                      tokensAfter: event.tokensAfter,
                      tokensReclaimed: event.tokensReclaimed,
                      messagesBefore: event.messagesBefore,
                      messagesAfter: event.messagesAfter,
                    },
                  }),
                });
              },
            });
            if (compactionResult.compacted) {
              messages.splice(0, messages.length, ...compactionResult.messages);
            }

            const result = streamText({
              model: m.aiModel,
              system: fullSystemPrompt,
              messages,
              tools: aiTools,
              maxOutputTokens: m.maxTokens,
              providerOptions: providerOpts,
              abortSignal: abortController.signal,
            });

            let turnText = "";
            let streamError: string | undefined;

            for await (const part of result.fullStream) {
              if (abortController.signal.aborted) break;
              if (part.type === "reasoning-delta") {
                await stream.writeSSE({ data: sseChunk(completionId, {}, null, { thinking: part.text }) });
              } else if (part.type === "text-delta") {
                turnText += part.text;
                await stream.writeSSE({ data: sseChunk(completionId, { content: part.text }) });
              } else if (part.type === "tool-input-start") {
                // Emit early "preparing" signal — the LLM has started generating a tool call
                // but arguments are not yet complete. Lets the UI show immediate feedback.
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, null, {
                    tool_call: { id: part.id, name: part.toolName, state: "preparing" },
                  }),
                });
              } else if (part.type === "finish") {
                // Capture error from finish reason if applicable
                if (part.finishReason === "error") {
                  streamError = "Model returned an error";
                }
              }
            }

            // If aborted, stop the loop — skip error/tool processing
            if (abortController.signal.aborted) {
              finalText += turnText;
              break;
            }

            if (streamError) {
              finalText += `\n\nError: ${streamError}`;
              await stream.writeSSE({ data: sseChunk(completionId, { content: `\n\nError: ${streamError}` }) });
              break;
            }

            // Get tool calls and usage after stream completes
            const toolCalls = await result.toolCalls;
            const usage = await result.usage;
            totalUsage = {
              inputTokens: (totalUsage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
              outputTokens: (totalUsage.outputTokens ?? 0) + (usage.outputTokens ?? 0),
              totalTokens: (totalUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0),
            } as LanguageModelUsage;

            // Push assistant response message into conversation history
            // AI SDK format: assistant message with text + tool calls
            const assistantContent: any[] = [];
            if (turnText) {
              assistantContent.push({ type: "text", text: turnText });
            }
            for (const tc of toolCalls) {
              assistantContent.push({
                type: "tool-call",
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input,
              });
            }
            messages.push({
              role: "assistant",
              content: assistantContent.length === 1 && assistantContent[0].type === "text"
                ? turnText
                : assistantContent,
            });

            finalText += turnText;

            if (toolCalls.length === 0) break;

            // ── Client-side tools — return to client as standard tool_calls ──
            const clientSideCall = toolCalls.find((tc: any) => CLIENT_SIDE_TOOL_NAMES.has(tc.toolName));
            if (clientSideCall) {
              // Persist for session history
              toolCallsAccum.push({
                id: clientSideCall.toolCallId,
                name: clientSideCall.toolName,
                arguments: clientSideCall.input,
                state: "interrupted",
              });
              // Send as standard OpenAI tool_calls finish reason
              await stream.writeSSE({
                data: JSON.stringify({
                  id: completionId,
                  object: "chat.completion.chunk",
                  choices: [{
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [{
                        index: 0,
                        id: clientSideCall.toolCallId,
                        type: "function",
                        function: {
                          name: clientSideCall.toolName,
                          arguments: JSON.stringify(clientSideCall.input),
                        },
                      }],
                    },
                    finish_reason: "tool_calls",
                  }],
                }),
              });
              await stream.writeSSE({ data: "[DONE]" });
              return;
            }

            // Check for interactive tools — only in orchestrator mode (agents don't have interactive tools)
            const interactiveCall = agentMode ? undefined : toolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
            if (interactiveCall) {
              // Persist the interactive tool call so it survives session reload
              toolCallsAccum.push({
                id: interactiveCall.toolCallId,
                name: interactiveCall.toolName,
                arguments: interactiveCall.input,
                state: "interrupted",
              });

              if (interactiveCall.toolName === "ask_user") {
                const questions = (interactiveCall.input as any)?.questions as any[] ?? [];
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "ask_user", { ask_user: { questions } }),
                });
              } else if (interactiveCall.toolName === "create_mission") {
                const args = interactiveCall.input as Record<string, unknown>;
                let missionData: unknown;
                try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "mission_preview", {
                    mission_preview: {
                      name: args.name as string,
                      data: missionData,
                      prompt: args.prompt as string | undefined,
                    },
                  }),
                });
              } else if (interactiveCall.toolName === "set_vault_entry") {
                const args = interactiveCall.input as Record<string, unknown>;
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "vault_preview", {
                    vault_preview: {
                      agent: args.agent as string,
                      service: args.service as string,
                      type: args.type as string,
                      label: args.label as string | undefined,
                      credentials: args.credentials as Record<string, string>,
                    },
                  }),
                });
              } else if (interactiveCall.toolName === "open_file") {
                const args = interactiveCall.input as Record<string, unknown>;
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "open_file", {
                    open_file: {
                      path: args.path as string,
                    },
                  }),
                });
              } else if (interactiveCall.toolName === "navigate_to") {
                const args = interactiveCall.input as Record<string, unknown>;
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "navigate_to", {
                    navigate_to: {
                      target: args.target as string,
                      id: args.id as string | undefined,
                      name: args.name as string | undefined,
                      path: args.path as string | undefined,
                      highlight: args.highlight as string | undefined,
                    },
                  }),
                });
              } else if (interactiveCall.toolName === "open_tab") {
                const args = interactiveCall.input as Record<string, unknown>;
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, "open_tab", {
                    open_tab: {
                      url: args.url as string,
                      label: args.label as string | undefined,
                    },
                  }),
                });
              }
              await stream.writeSSE({ data: "[DONE]" });
              return; // finally block will persist whatever finalText we have
            }

            for (const call of toolCalls) {
              // Stop executing tools if client disconnected
              if (abortController.signal.aborted) break;

              const callArgs = call.input as Record<string, unknown>;

              // Notify client that a tool is being called
              await stream.writeSSE({
                data: sseChunk(completionId, {}, null, {
                  tool_call: { id: call.toolCallId, name: call.toolName, arguments: callArgs, state: "calling" },
                }),
              });

              const result = await effectiveToolExecutor(call.toolName, callArgs);
              const isError = result.startsWith("Error:");
              emitFileChanged(call.toolName, callArgs, result, deps.emit);

              // Accumulate for persistence
              toolCallsAccum.push({
                id: call.toolCallId,
                name: call.toolName,
                arguments: callArgs,
                result,
                state: isError ? "error" : "completed",
              });

              // Notify client with tool result (skip if aborted mid-tool)
              if (!abortController.signal.aborted) {
                await stream.writeSSE({
                  data: sseChunk(completionId, {}, null, {
                    tool_call: { id: call.toolCallId, name: call.toolName, result, state: isError ? "error" : "completed" },
                  }),
                });
              }

              // Push tool result message in AI SDK format
              messages.push({
                role: "tool",
                content: [{
                  type: "tool-result",
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                  output: isError
                    ? { type: "error-text" as const, value: result }
                    : { type: "text" as const, value: result },
                }],
              });
            }
          }

          if (!abortController.signal.aborted) {
            await stream.writeSSE({ data: sseChunk(completionId, {}, "stop") });
            await stream.writeSSE({ data: "[DONE]" });
          }
        } catch (err) {
          // Suppress AbortError — expected when client disconnects
          if (!(err instanceof DOMException && err.name === "AbortError") && !abortController.signal.aborted) {
            throw err;
          }
        } finally {
          // Always persist the assistant response — even on disconnect.
          // SECURITY: Redact vault credentials before persisting to SQLite
          const safeToolCalls = redactVaultToolCalls(toolCallsAccum);
          if (sessionStore && sessionId && assistantMsgId) {
            if (finalText.trim()) {
              await sessionStore.updateMessage(sessionId, assistantMsgId, finalText.trim(), safeToolCalls);
            }
            // If finalText is empty (LLM never responded), remove the empty placeholder
            // by setting content to a marker that indicates an interrupted response
            else {
              await sessionStore.updateMessage(sessionId, assistantMsgId, "[Response interrupted]", safeToolCalls);
            }
          }
        }
      }) as any;
    } else {
      // ── Non-streaming mode ──
      // Reserve placeholder so the message is visible even if the request is interrupted
      let assistantMsgId: string | null = null;
      if (sessionStore && sessionId) {
        const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
        assistantMsgId = placeholder.id;
      }

      const messages: any[] = [...aiMessages];
      let finalText = "";
      let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
      const toolCallsAccum: any[] = [];

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          // Compact context if approaching the model's context window limit.
          // Under threshold this is just a cheap token estimation — zero LLM calls.
          const compactionResult = await compactIfNeeded({
            systemPrompt: fullSystemPrompt,
            messages,
            tools: effectiveTools,
            config: {
              contextWindow: m.contextWindow ?? 200_000,
              maxOutputTokens: m.maxTokens ?? 8192,
            },
            summarize: buildSummarizeFn(m, providerOpts),
            mode: "chat",
            // Non-streaming: no SSE to write to, compaction is silent
          });
          if (compactionResult.compacted) {
            messages.splice(0, messages.length, ...compactionResult.messages);
          }

          const genResult = await generateText({
            model: m.aiModel,
            system: fullSystemPrompt,
            messages,
            tools: aiTools,
            maxOutputTokens: m.maxTokens,
            providerOptions: providerOpts,
          });

          const turnText = genResult.text;
          const usage = genResult.usage;
          totalUsage = {
            inputTokens: (totalUsage.inputTokens ?? 0) + (usage.inputTokens ?? 0),
            outputTokens: (totalUsage.outputTokens ?? 0) + (usage.outputTokens ?? 0),
            totalTokens: (totalUsage.totalTokens ?? 0) + (usage.totalTokens ?? 0),
          } as LanguageModelUsage;

          // Push assistant response message into conversation history
          const assistantContent: any[] = [];
          if (turnText) {
            assistantContent.push({ type: "text", text: turnText });
          }
          for (const tc of genResult.toolCalls) {
            assistantContent.push({
              type: "tool-call",
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
            });
          }
          messages.push({
            role: "assistant",
            content: assistantContent.length === 1 && assistantContent[0].type === "text"
              ? turnText
              : assistantContent,
          });

          finalText += turnText;

          const toolCalls = genResult.toolCalls;
          if (toolCalls.length === 0) break;

          // ── Client-side tools — return to client as standard tool_calls ──
          const clientSideCall = toolCalls.find((tc: any) => CLIENT_SIDE_TOOL_NAMES.has(tc.toolName));
          if (clientSideCall) {
            toolCallsAccum.push({
              id: clientSideCall.toolCallId,
              name: clientSideCall.toolName,
              arguments: clientSideCall.input,
              state: "interrupted",
            });
            // Persist before returning
            if (sessionStore && sessionId) {
              const assistantMsg = finalText + (turnText ? "" : "");
              if (assistantMsg) {
                await sessionStore.addMessage(sessionId, "assistant", assistantMsg, toolCallsAccum);
              }
            }
            return c.json({
              id: completionId,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "polpo",
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: finalText || null,
                  tool_calls: [{
                    id: clientSideCall.toolCallId,
                    type: "function",
                    function: {
                      name: clientSideCall.toolName,
                      arguments: JSON.stringify(clientSideCall.input),
                    },
                  }],
                },
                finish_reason: "tool_calls",
              }],
              usage: {
                prompt_tokens: totalUsage.inputTokens ?? 0,
                completion_tokens: totalUsage.outputTokens ?? 0,
                total_tokens: totalUsage.totalTokens ?? 0,
              },
            });
          }

          // Check for interactive tools — only in orchestrator mode (agents don't have interactive tools)
          const interactiveCall = agentMode ? undefined : toolCalls.find((tc: any) => isInteractiveFn?.(tc.toolName));
          if (interactiveCall) {
            // Persist the interactive tool call so it survives session reload
            toolCallsAccum.push({
              id: interactiveCall.toolCallId,
              name: interactiveCall.toolName,
              arguments: interactiveCall.input,
              state: "interrupted",
            });

            const baseResponse = {
              id: completionId,
              object: "chat.completion" as const,
              created: Math.floor(Date.now() / 1000),
              model: "polpo" as const,
              usage: {
                prompt_tokens: totalUsage.inputTokens ?? 0,
                completion_tokens: totalUsage.outputTokens ?? 0,
                total_tokens: totalUsage.totalTokens ?? 0,
              },
            };

            if (interactiveCall.toolName === "ask_user") {
              const questions = (interactiveCall.input as any)?.questions as any[] ?? [];
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "ask_user" as const,
                  ask_user: { questions },
                }],
              });
            }

            if (interactiveCall.toolName === "create_mission") {
              const args = interactiveCall.input as Record<string, unknown>;
              let missionData: unknown;
              try { missionData = JSON.parse(args.data as string); } catch { missionData = args.data; }
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "mission_preview" as const,
                  mission_preview: {
                    name: args.name as string,
                    data: missionData,
                    prompt: args.prompt as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.toolName === "set_vault_entry") {
              const args = interactiveCall.input as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "vault_preview" as const,
                  vault_preview: {
                    agent: args.agent as string,
                    service: args.service as string,
                    type: args.type as string,
                    label: args.label as string | undefined,
                    credentials: args.credentials as Record<string, string>,
                  },
                }],
              });
            }

            if (interactiveCall.toolName === "open_file") {
              const args = interactiveCall.input as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "open_file" as const,
                  open_file: {
                    path: args.path as string,
                  },
                }],
              });
            }

            if (interactiveCall.toolName === "navigate_to") {
              const args = interactiveCall.input as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "navigate_to" as const,
                  navigate_to: {
                    target: args.target as string,
                    id: args.id as string | undefined,
                    name: args.name as string | undefined,
                    path: args.path as string | undefined,
                    highlight: args.highlight as string | undefined,
                  },
                }],
              });
            }

            if (interactiveCall.toolName === "open_tab") {
              const args = interactiveCall.input as Record<string, unknown>;
              return c.json({
                ...baseResponse,
                choices: [{
                  index: 0,
                  message: { role: "assistant" as const, content: finalText },
                  finish_reason: "open_tab" as const,
                  open_tab: {
                    url: args.url as string,
                    label: args.label as string | undefined,
                  },
                }],
              });
            }
            // Note: finally block persists finalText + toolCallsAccum
          }

          for (const call of toolCalls) {
            const callArgs = call.input as Record<string, unknown>;
            const result = await effectiveToolExecutor(call.toolName, callArgs);
            const isError = result.startsWith("Error:");
            emitFileChanged(call.toolName, callArgs, result, deps.emit);

            // Accumulate for persistence
            toolCallsAccum.push({
              id: call.toolCallId,
              name: call.toolName,
              arguments: callArgs,
              result,
              state: isError ? "error" : "completed",
            });

            // Push tool result message in AI SDK format
            messages.push({
              role: "tool",
              content: [{
                type: "tool-result",
                toolCallId: call.toolCallId,
                toolName: call.toolName,
                output: isError
                  ? { type: "error-text" as const, value: result }
                  : { type: "text" as const, value: result },
              }],
            });
          }
        }

        return c.json(completionResponse(completionId, finalText, totalUsage));
      } finally {
        // Always persist the final text + tool calls — even on early return (ask_user) or error
        // SECURITY: Redact vault credentials before persisting to SQLite
        const safeToolCalls = redactVaultToolCalls(toolCallsAccum);
        if (sessionStore && sessionId && assistantMsgId) {
          if (finalText.trim()) {
            await sessionStore.updateMessage(sessionId, assistantMsgId, finalText.trim(), safeToolCalls);
          } else {
            await sessionStore.updateMessage(sessionId, assistantMsgId, "[Response interrupted]", safeToolCalls);
          }
        }
      }
    }
  });

  return app;
}
