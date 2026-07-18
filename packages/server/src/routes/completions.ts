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
 *
 * This file owns request handling only (auth, mode resolution, session
 * persistence, dispatch). The moving parts live in ./completions/:
 * - schemas.ts            — Zod schemas + OpenAPI route definition
 * - message-mapping.ts    — OpenAI ⇄ AI SDK message conversion
 * - sse.ts                — SSE chunks, error envelopes, response shapes
 * - tool-mapping.ts       — Polpo → AI SDK tool mapping, vault redaction
 * - agent-step-runner.ts  — single agent-step execution for loop runtimes
 * - project-loop-runner.ts — deterministic project loop runtime + resume
 * - chat-handler.ts       — streaming/non-streaming multi-turn chat loop
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type LoopRunStore,
  type ProjectLoopConfig,
} from "@polpo-ai/core";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { ChatSessionInjection } from "@polpo-ai/core";
import { chatCompletionsRoute } from "./completions/schemas.js";
import type {
  CompletionResolvedModelInfo,
  ResolvedModelInfo,
} from "./completions/agent-step-runner.js";
import { handleProjectLoopCompletion } from "./completions/project-loop-runner.js";
import {
  runNonStreamingChatCompletion,
  streamChatCompletion,
} from "./completions/chat-handler.js";
import { streamChatViaRun, runNonStreamingChatViaRun } from "./completions/chat-via-run-handler.js";
import { prepareChatCompletionExecution } from "./completions/conversation-turn.js";

export { resumeProjectLoopRun } from "./completions/project-loop-runner.js";
export {
  buildChatRunInjection,
  runChatTurnViaRun,
  type ChatViaRunTurnResult,
} from "./completions/chat-via-run-handler.js";
export {
  prepareChatCompletionExecution,
  runConversationTurn,
  type ConversationTurnResult,
  type PreparedConversationTurn,
} from "./completions/conversation-turn.js";

// ── Route factory ──────────────────────────────────────────────────────

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
  /**
   * Optionally assemble the complete host-specific runtime prompt. Hosts use
   * this to inject shared memory, agent memory, skills, workspace policy, and
   * tagged caller/loop context consistently across chat and loop execution.
   * When omitted, the server preserves the legacy buildAgentPrompt fallback.
   */
  buildRuntimePrompt?: (
    agentConfig: any,
    options: {
      mode: "chat" | "loop-step";
      extraSystemParts: string[];
      loopContextPart?: string;
      includeAgentMemory: boolean;
    },
  ) => string | Promise<string>;
  /** Create tools + executor for the agent. Return empty arrays for chat-only.
   *  Optional `cleanup` is invoked once the response finishes — used to close
   *  long-lived resources like MCP transports.
   *
   *  `extraAiTools` is an escape hatch for tools already in AI SDK shape that
   *  should be merged into the LLM's tool palette as-is (no Polpo conversion,
   *  no manual execution). Used by cloud to inject Vercel Gateway provider
   *  tools (e.g. `gateway.tools.perplexitySearch`) which are server-executed
   *  by the gateway during `generateText` — Polpo never sees the tool-call.
   *  The keys here MUST NOT collide with names in `tools`. */
  resolveAgentTools: (agentConfig: any) => Promise<{
    tools: any[];
    executor: (name: string, args: Record<string, unknown>) => Promise<string>;
    cleanup?: () => Promise<void>;
    extraAiTools?: Record<string, any>;
  }>;
  /** Optional project-level loop loader. When provided, assigned/default agent loops can run as deterministic graphs. */
  getProjectLoop?: (name: string) => Promise<ProjectLoopConfig | null>;
  /** Optional durable store for agentic loop runtime traces. */
  getLoopRunStore?: () => LoopRunStore | undefined;
  /** Optional approval store used when loop policies require human approval. */
  getApprovalStore?: () => ApprovalStore | undefined;
  /** Called after each completion finishes (streaming or non-streaming). Receives usage, model info, and provider metadata. Fire-and-forget — errors are silently ignored. */
  onCompletionFinished?: (info: {
    usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    model: string;
    resolvedModel?: CompletionResolvedModelInfo;
    agent?: string;
    sessionId?: string;
    /** OpenAI-compat opaque end-user id from the request, when set. Lets the
     *  cloud meter attribute the usage row to the dev's authenticated user. */
    user?: string;
    providerMetadata?: Record<string, unknown>;
  }) => void;
  /** Run a chat completion through the shared executeRun lifecycle +
   *  loop-engine (node-provided). With settings.chatExecution:"run", this
   *  routes chat through the same runtime used by tasks. `onEvent` receives the
   *  run's live event stream (text-delta / reasoning-delta / tool_use /
   *  tool_result / usage / …). */
  runChatViaRun?: (
    inject: ChatSessionInjection,
    hooks: { onEvent: (e: Record<string, unknown>) => void; signal?: AbortSignal },
  ) => Promise<{ status: string; result: { exitCode: number; stdout: string; stderr: string } }>;
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
    const rawSessionHeader = c.req.header("x-session-id") ?? null;
    const prepared = await prepareChatCompletionExecution(deps, body, {
      sessionId: rawSessionHeader === "new" ? null : rawSessionHeader,
      setHeader: (name, value) => c.header(name, value),
    });

    if (prepared.kind === "error") {
      return c.json(prepared.body, prepared.status as any);
    }

    // Expose session ID to the client so it can track which session is active
    const sessionId = prepared.kind === "project-loop"
      ? prepared.sessionId
      : prepared.execution.sessionId;
    if (sessionId) {
      c.header("x-session-id", sessionId);
    }

    if (prepared.kind === "project-loop") {
      return await handleProjectLoopCompletion(c, {
        deps: prepared.deps,
        body: prepared.body,
        completionId: prepared.completionId,
        agentConfig: prepared.agentConfig,
        projectLoop: prepared.projectLoop,
        aiMessages: prepared.aiMessages,
        extraSystemParts: prepared.extraSystemParts,
        sessionStore: prepared.sessionStore,
        sessionId: prepared.sessionId,
      }) as any;
    }

    const { execution, viaRun } = prepared;
    if (viaRun) {
      return (body.stream
        ? await streamChatViaRun(c, execution)
        : await runNonStreamingChatViaRun(c, execution)) as any;
    }

    if (body.stream) {
      // ── Streaming mode ──
      return streamChatCompletion(c, execution) as any;
    }
    // ── Non-streaming mode ──
    return await runNonStreamingChatCompletion(c, execution) as any;
  });

  return app;
}
