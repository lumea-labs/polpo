import { nanoid } from "nanoid";
import {
  agentMemoryScope,
  createRuntimePlanResolvedEvent,
  normalizeRuntimePlan,
  renderRuntimeContextPrompt,
  resolveRuntimeContext,
  resolveLoopSelection,
  type ModelSelection,
  type ProjectLoopConfig,
  type RuntimeContextResolution,
  type RuntimePlan,
} from "@polpo-ai/core";
import type {
  CompletionRouteDeps,
  CompletionRuntimeInvocation,
  CompletionRuntimePlanInput,
} from "../completions.js";
import type { CompletionRequestBody } from "./schemas.js";
import { convertMessages, extractText } from "./message-mapping.js";
import { toAIToolChoice } from "./tool-mapping.js";
import type { ChatCompletionExecution } from "./chat-handler.js";
import {
  agentConfigForModelPrimary,
  modelSelectionForAgent,
  modelSelectionForResolvedModel,
  type ResolvedModelInfo,
} from "./agent-step-runner.js";
import {
  runChatTurnViaRun,
  type ChatViaRunTurnResult,
} from "./chat-via-run-handler.js";

type PreparedError = {
  kind: "error";
  status: number;
  body: { error: { message: string; type: string; code?: string } };
};

type PreparedProjectLoop = {
  kind: "project-loop";
  deps: CompletionRouteDeps;
  body: CompletionRequestBody;
  completionId: string;
  agentConfig: any;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  sessionStore: any;
  sessionId: string | null;
  runtimePlan?: RuntimePlan;
  runtimeContext?: RuntimeContextResolution;
  runtimeInvocation?: CompletionRuntimeInvocation;
};

type PreparedChat = {
  kind: "chat";
  execution: ChatCompletionExecution;
  viaRun: boolean;
};

export type PreparedConversationTurn = PreparedError | PreparedProjectLoop | PreparedChat;

export interface PrepareConversationTurnOptions {
  sessionId?: string | null;
  completionId?: string;
  setHeader?: (name: string, value: string) => void;
  /** Trusted surface identity. Omit for ordinary HTTP/API agent calls. */
  runtime?: CompletionRuntimeInvocation;
  signal?: AbortSignal;
}

export interface RunConversationTurnInput extends PrepareConversationTurnOptions {
  body: CompletionRequestBody;
  onRunEvent?: (event: Record<string, unknown>) => void;
  signal?: AbortSignal;
}

export type ConversationTurnResult = ChatViaRunTurnResult & {
  sessionId: string | null;
  completionId: string;
};

function completionError(
  message: string,
  status: number,
  code?: string,
  type = "invalid_request_error",
): PreparedError {
  return {
    kind: "error",
    status,
    body: {
      error: {
        message,
        type,
        ...(code ? { code } : {}),
      },
    },
  };
}

function freezePlanningInput<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezePlanningInput(nested);
  }
  return Object.freeze(value);
}

function cloneModelSelection(selection: ModelSelection | undefined): ModelSelection | undefined {
  if (!selection || typeof selection === "string") return selection;
  return {
    ...(selection.primary !== undefined ? { primary: selection.primary } : {}),
    ...(selection.fallbacks !== undefined ? { fallbacks: [...selection.fallbacks] } : {}),
  };
}

async function resolveCompletionRuntimePlan(
  deps: CompletionRouteDeps,
  body: CompletionRequestBody,
  invocation: CompletionRuntimeInvocation | undefined,
  agentConfig: any | undefined,
  loopName?: string,
): Promise<RuntimePlan | undefined> {
  if (!deps.resolveRuntimePlan) return undefined;

  const { surface, source } = invocation ?? {
    surface: "agent",
    source: "request",
  } as const;
  const input: CompletionRuntimePlanInput = freezePlanningInput({
    surface,
    source,
    execution: {
      mode: loopName ? "loop" : "direct",
      ...(loopName ? { loop: loopName } : {}),
      source: loopName ? "request" : "default",
    },
    request: {
      ...(body.agent ? { agent: body.agent } : {}),
      ...(body.loop ? { loop: body.loop } : {}),
      sandbox: body.sandbox,
    },
    ...(agentConfig
      ? {
          agent: {
            name: agentConfig.name,
            model: cloneModelSelection(agentConfig.model),
            sandbox: agentConfig.sandbox
              ? { isolation: agentConfig.sandbox.isolation }
              : undefined,
            allowedTools: Array.isArray(agentConfig.allowedTools)
              ? [...agentConfig.allowedTools]
              : undefined,
          },
        }
      : {}),
  });

  const plan = normalizeRuntimePlan(await deps.resolveRuntimePlan(input));
  deps.emit("runtime:plan", createRuntimePlanResolvedEvent(plan));
  return plan;
}

export async function prepareChatCompletionExecution(
  deps: CompletionRouteDeps,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions = {},
): Promise<PreparedConversationTurn> {
  const agentMode = !!body.agent;
  let fullSystemPrompt: string;
  let m: ResolvedModelInfo;
  let providerOpts: Record<string, any> | undefined;
  let modelSelection: ModelSelection | undefined;
  let modelToolChoice: unknown | undefined;
  let effectiveTools: any[];
  let effectiveToolExecutor: (name: string, args: Record<string, unknown>) => Promise<string>;
  let extraAiTools: Record<string, any> | undefined;
  let isInteractiveFn: ((name: string) => boolean) | undefined;
  let projectLoopRuntime: { agentConfig: any; projectLoop: ProjectLoopConfig } | undefined;
  let onResponseFinished: (() => Promise<void>) | undefined;
  let resolvedAgentConfig: any;
  let runtimePlan: RuntimePlan | undefined;
  let runtimeContext: RuntimeContextResolution | undefined;

  const { aiMessages, extraSystemParts } = convertMessages(body.messages);

  if (agentMode) {
    const agents = await deps.getAgents();
    let agentConfig = agents.find((a: any) => a.name === body.agent);
    if (!agentConfig) {
      return completionError(`Agent "${body.agent}" not found`, 404, "agent_not_found");
    }

    try {
      const selection = resolveLoopSelection(agentConfig, body.loop);
      if (selection) {
        agentConfig = selection.agent;
        options.setHeader?.("x-loop", selection.name);
        const assignedLoops = Array.isArray(agentConfig.assignedLoops) ? agentConfig.assignedLoops : [];
        if (assignedLoops.includes(selection.name) && deps.getProjectLoop) {
          const projectLoop = await deps.getProjectLoop(selection.name);
          if (!projectLoop) throw new Error(`Assigned project loop "${selection.name}" was not found`);
          projectLoopRuntime = { agentConfig, projectLoop };
        }
      }
      resolvedAgentConfig = agentConfig;
      modelToolChoice = toAIToolChoice(agentConfig.toolChoice);
    } catch (loopErr) {
      const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
      return completionError(msg, 400, "loop_not_found");
    }

    try {
      runtimePlan = await resolveCompletionRuntimePlan(
        deps,
        body,
        options.runtime,
        resolvedAgentConfig,
        body.loop,
      );
    } catch {
      return completionError(
        "Runtime planning failed",
        500,
        "runtime_planning_failed",
        "server_error",
      );
    }

    const lastUserMessage = [...body.messages]
      .reverse()
      .find((message) => message.role === "user");
    const retrievalQuery = lastUserMessage
      ? extractText(lastUserMessage.content).trim()
      : "";
    if (retrievalQuery && deps.runtimeContext) {
      try {
        runtimeContext = await resolveRuntimeContext(deps.runtimeContext, {
          agentName: resolvedAgentConfig.name,
          query: retrievalQuery,
          surface: options.runtime?.surface ?? "agent",
          source: options.runtime?.source ?? "request",
          ...(body.user ? { externalUserId: body.user } : {}),
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.runtime?.channelId
            ? { channelId: options.runtime.channelId }
            : {}),
          ...(options.runtime?.requestId
            ? { requestId: options.runtime.requestId }
            : {}),
          ...(options.runtime?.runId ? { runId: options.runtime.runId } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (
          (error instanceof DOMException && error.name === "AbortError")
          || (error instanceof Error && error.name === "AbortError")
        ) {
          throw error;
        }
        return completionError(
          "Runtime context retrieval failed",
          500,
          "runtime_context_failed",
          "server_error",
        );
      }
    }

    if (projectLoopRuntime) {
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
      const runtimeContextPrompt = renderRuntimeContextPrompt(runtimeContext);
      if (runtimeContextPrompt) {
        fullSystemPrompt += `\n\n${runtimeContextPrompt}`;
      }

      const reasoning = agentConfig.reasoning ?? deps.getConfig()?.settings?.reasoning;
      let resolved;
      try {
        resolved = await deps.resolveAgentModel(agentConfigForModelPrimary(agentConfig), reasoning);
      } catch (modelErr) {
        const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
        return completionError(msg, 400);
      }
      m = resolved.model;
      providerOpts = resolved.providerOptions;
      modelSelection = modelSelectionForAgent(agentConfig, modelSelectionForResolvedModel(m));

      const resolvedTools = await deps.resolveAgentTools(agentConfig);
      effectiveTools = resolvedTools.tools;
      effectiveToolExecutor = resolvedTools.executor;
      onResponseFinished = resolvedTools.cleanup;
      extraAiTools = resolvedTools.extraAiTools;
    }
  } else {
    if (!deps.resolveOrchestratorContext) {
      return completionError(
        "Orchestrator mode is not available. Use agent-direct mode by specifying the 'agent' field.",
        501,
        "orchestrator_unavailable",
      );
    }

    try {
      runtimePlan = await resolveCompletionRuntimePlan(
        deps,
        body,
        options.runtime,
        undefined,
      );
    } catch {
      return completionError(
        "Runtime planning failed",
        500,
        "runtime_planning_failed",
        "server_error",
      );
    }

    const ctx = await deps.resolveOrchestratorContext();
    fullSystemPrompt = extraSystemParts.length > 0
      ? `${ctx.systemPrompt}\n\n## Additional context from caller\n\n${extraSystemParts.join("\n\n")}`
      : ctx.systemPrompt;
    m = ctx.model;
    providerOpts = ctx.providerOptions;
    modelSelection = modelSelectionForResolvedModel(m);
    effectiveTools = ctx.tools;
    effectiveToolExecutor = ctx.executor;
    isInteractiveFn = ctx.isInteractive;
  }

  const completionId = options.completionId ?? `chatcmpl-${nanoid(24)}`;
  const sessionStore = deps.getSessionStore();
  let sessionId = options.sessionId ?? null;

  if (sessionStore) {
    if (!sessionId) {
      const firstUserMsg = body.messages.find((message) => message.role === "user");
      const sessionTitle = firstUserMsg ? extractText(firstUserMsg.content).slice(0, 60) : undefined;
      const agentScope = agentMode ? body.agent! : null;

      sessionId = await sessionStore.create({
        title: sessionTitle,
        agent: agentScope ?? undefined,
        user: body.user,
        metadata: body.metadata,
      });
    }

    const lastUserMsg = [...body.messages].reverse().find((message) => message.role === "user");
    if (lastUserMsg && sessionId) {
      await sessionStore.addMessage(sessionId, "user", lastUserMsg.content);
    }
  }

  if (projectLoopRuntime) {
    return {
      kind: "project-loop",
      deps,
      body,
      completionId,
      agentConfig: projectLoopRuntime.agentConfig,
      projectLoop: projectLoopRuntime.projectLoop,
      aiMessages,
      extraSystemParts,
      sessionStore,
      sessionId,
      runtimePlan,
      runtimeContext,
      runtimeInvocation: options.runtime,
    };
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
    modelSelection,
    modelToolChoice,
    effectiveTools,
    effectiveToolExecutor,
    extraAiTools,
    isInteractiveFn,
    aiMessages,
    sessionStore,
    sessionId,
    onResponseFinished,
    runtimePlan,
    runtimeContext,
  };

  const viaRun =
    deps.getConfig()?.settings?.chatExecution === "run" &&
    !!deps.runChatViaRun &&
    agentMode &&
    !projectLoopRuntime;

  return { kind: "chat", execution, viaRun };
}

export async function runConversationTurn(
  deps: CompletionRouteDeps,
  input: RunConversationTurnInput,
): Promise<ConversationTurnResult> {
  const prepared = await prepareChatCompletionExecution(deps, input.body, {
    sessionId: input.sessionId,
    completionId: input.completionId,
    setHeader: input.setHeader,
    runtime: input.runtime,
    signal: input.signal,
  });

  if (prepared.kind === "error") {
    throw new Error(prepared.body.error.message);
  }
  if (prepared.kind === "project-loop") {
    throw new Error("Project loop conversations are not available through runConversationTurn yet");
  }
  if (!prepared.execution.agentMode) {
    throw new Error("runConversationTurn requires agent-direct mode");
  }

  const result = await runChatTurnViaRun(prepared.execution, {
    onRunEvent: input.onRunEvent,
    signal: input.signal,
  });
  return {
    ...result,
    sessionId: prepared.execution.sessionId,
    completionId: prepared.execution.completionId,
  };
}
