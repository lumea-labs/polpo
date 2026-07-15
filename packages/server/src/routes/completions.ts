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
import { nanoid } from "nanoid";
import {
  agentMemoryScope,
  resolveLoopSelection,
  type LoopRunStore,
  type ProjectLoopConfig,
} from "@polpo-ai/core";
import type { ApprovalStore } from "@polpo-ai/core/approval-store";
import type { ChatSessionInjection } from "@polpo-ai/core";
import { chatCompletionsRoute } from "./completions/schemas.js";
import { convertMessages, extractText } from "./completions/message-mapping.js";
import { toAIToolChoice } from "./completions/tool-mapping.js";
import type {
  CompletionResolvedModelInfo,
  ResolvedModelInfo,
} from "./completions/agent-step-runner.js";
import { handleProjectLoopCompletion } from "./completions/project-loop-runner.js";
import {
  runNonStreamingChatCompletion,
  streamChatCompletion,
  type ChatCompletionExecution,
} from "./completions/chat-handler.js";
import { streamChatViaRun, runNonStreamingChatViaRun } from "./completions/chat-via-run-handler.js";

export { resumeProjectLoopRun } from "./completions/project-loop-runner.js";

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
    const agentMode = !!body.agent;

    // ── Resolve effective context (orchestrator vs agent-direct) ──
    let fullSystemPrompt: string;
    let m: ResolvedModelInfo;
    let providerOpts: Record<string, any> | undefined;
    let modelToolChoice: unknown | undefined;
    let effectiveTools: any[];
    let effectiveToolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
    /**
     * Provider-executed tools the host wants merged into the AI SDK tool
     * palette as-is. Polpo never invokes these — they're handled inside
     * `generateText` by the SDK / model provider (Vercel Gateway today).
     * Keys here MUST be skipped by the manual tool-call dispatcher.
     */
    let extraAiTools: Record<string, any> | undefined;
    let isInteractiveFn: ((name: string) => boolean) | undefined;
    let projectLoopRuntime: { agentConfig: any; projectLoop: ProjectLoopConfig } | undefined;
    /**
     * Resource cleanup hook — set when an agent's tool resolver opens
     * long-lived connections (today: MCP transports). Invoked exactly
     * once after the response finishes, regardless of streaming/non-
     * streaming/error path. Wrapped in try/catch by the caller so a
     * misbehaving cleanup can't leak the request itself.
     */
    let onResponseFinished: (() => Promise<void>) | undefined;
    // Resolved agent config captured for the execution object (F1c needs it to
    // build the RunnerConfig for chat-via-executeRun). Undefined in orchestrator mode.
    let resolvedAgentConfig: any;

    const { aiMessages, extraSystemParts } = convertMessages(body.messages);

    if (agentMode) {
      // ── Agent-direct mode ──
      const agents = await deps.getAgents();
      let agentConfig = agents.find((a: any) => a.name === body.agent);
      if (!agentConfig) {
        return c.json({ error: { message: `Agent "${body.agent}" not found`, type: "invalid_request_error", code: "agent_not_found" } }, 404);
      }
      try {
        const selection = resolveLoopSelection(agentConfig, body.loop);
        if (selection) {
          agentConfig = selection.agent;
          c.header("x-loop", selection.name);
          const assignedLoops = Array.isArray(agentConfig.assignedLoops) ? agentConfig.assignedLoops : [];
          if (assignedLoops.includes(selection.name) && deps.getProjectLoop) {
            const projectLoop = await deps.getProjectLoop(selection.name);
            if (!projectLoop) throw new Error(`Assigned project loop "${selection.name}" was not found`);
            projectLoopRuntime = { agentConfig, projectLoop };
          }
        }
        // No loop selected → agent runs as-is (no overlay, no x-loop header).
        resolvedAgentConfig = agentConfig;
        modelToolChoice = toAIToolChoice(agentConfig.toolChoice);
      } catch (loopErr) {
        const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        return c.json({ error: { message: msg, type: "invalid_request_error", code: "loop_not_found" } }, 400 as any);
      }

      if (projectLoopRuntime) {
        // The project loop runtime resolves model/tools per step after session setup.
        fullSystemPrompt = "";
        m = { provider: "polpo", contextWindow: 200_000, maxTokens: 8192, aiModel: undefined as any };
        effectiveTools = [];
        effectiveToolExecutor = async () => "Error: Project loop runtime has not resolved tools";
      } else {
      if (deps.buildRuntimePrompt) {
        fullSystemPrompt = await deps.buildRuntimePrompt(agentConfig, {
          mode: "chat",
          extraSystemParts,
          includeAgentMemory: true,
        });
      } else {
        // Build system prompt via the backwards-compatible generic fallback.
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

        const memoryStore = deps.getMemoryStore();
        const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
        if (agentMemory) {
          fullSystemPrompt += `\n\n## Your persistent memory\n\n${agentMemory}`;
        }
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
      const resolvedTools = await deps.resolveAgentTools(agentConfig);
      effectiveTools = resolvedTools.tools;
      effectiveToolExecutor = resolvedTools.executor;
      onResponseFinished = resolvedTools.cleanup;
      extraAiTools = resolvedTools.extraAiTools;
      }
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
        sessionId = await sessionStore.create({
          title: sessionTitle,
          agent: agentScope ?? undefined,
          user: body.user,
          metadata: body.metadata,
        });
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

    if (projectLoopRuntime) {
      return await handleProjectLoopCompletion(c, {
        deps,
        body,
        completionId,
        agentConfig: projectLoopRuntime.agentConfig,
        projectLoop: projectLoopRuntime.projectLoop,
        aiMessages,
        extraSystemParts,
        sessionStore,
        sessionId,
      }) as any;
    }

    const execution: ChatCompletionExecution = {
      deps,
      body,
      completionId,
      agentConfig: resolvedAgentConfig,
      agentMode,
      fullSystemPrompt,
      m,
      providerOpts,
      modelToolChoice,
      effectiveTools,
      effectiveToolExecutor,
      extraAiTools,
      isInteractiveFn,
      aiMessages,
      sessionStore,
      sessionId,
      onResponseFinished,
    };

    // Route agent chat through the shared executeRun lifecycle + loop-engine
    // when enabled and the host provides the driver. Project-loop runs already
    // returned above because they use their own deterministic loop runtime.
    const viaRun =
      deps.getConfig()?.settings?.chatExecution === "run" &&
      !!deps.runChatViaRun &&
      agentMode &&
      !projectLoopRuntime;
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
