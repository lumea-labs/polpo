import { nanoid } from "nanoid";
import {
  agentMemoryScope,
  createToolInvocationContext,
  createRuntimePromptContextSegment,
  compileExecutionRouteManifest,
  createExecutionRouteResolvedEvent,
  createExplicitExecutionRoute,
  createRuntimePlanResolvedEvent,
  executionRouteRuntimePlanFields,
  normalizeRuntimeContextTrustMode,
  normalizeRuntimePlan,
  renderRuntimePromptContextSegment,
  renderRuntimePromptContextSegments,
  renderRuntimeContextPrompt,
  replacesLegacyAgentMemory,
  replacesLegacySharedMemory,
  resolveRuntimeContext,
  resolveExecutionRoute,
  resolveLoopSelection,
  validateExecutionRouterConfig,
  type ModelSelection,
  type ModelTarget,
  type ProfiledModelSelection,
  type ProjectLoopConfig,
  type RuntimeContextResolution,
  type ResolvedExecutionRoute,
  type RuntimePlan,
  type RuntimeContextTrustMode,
  type ToolInvocationContext,
  type ToolInvocationJsonValue,
} from "@polpo-ai/core";
import {
  normalizeChatInteractionSettings,
  resolveChatInteractionCapabilities,
} from "@polpo-ai/core/chat-interactions";
import type {
  CompletionRouteDeps,
  CompletionRuntimeInvocation,
  CompletionRuntimePlanInput,
} from "../completions.js";
import type { CompletionRequestBody } from "./schemas.js";
import { convertMessages, extractText } from "./message-mapping.js";
import {
  clientSideToolsForCapabilities,
  toAIToolChoice,
} from "./tool-mapping.js";
import {
  createGuardedCompletionToolExecutor,
  type CompletionToolExecutor,
} from "./tool-guardrails.js";
import {
  assertCompletionMessageContent,
  assertModelPreflightValue,
  assertRuntimeContextResolution,
} from "./preflight-validation.js";
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
import { guardrailErrorEnvelope } from "./sse.js";
import {
  MODEL_CONTROLLED_TOOL_PROMPT,
  createModelControlledToolPool,
  forcedModelToolName,
  type ModelControlledToolDisclosureConfig,
} from "./tool-disclosure.js";
import {
  isStructuredResponseFormat,
  modelOutputForResponseFormat,
} from "./structured-output.js";

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
  contextTrust: RuntimeContextTrustMode;
  sessionStore: any;
  sessionId: string | null;
  runtimePlan?: RuntimePlan;
  runtimeContext?: RuntimeContextResolution;
  runtimeInvocation?: CompletionRuntimeInvocation;
  executionRoute?: ResolvedExecutionRoute;
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

function preflightError(error: unknown): PreparedError {
  const guardrail = guardrailErrorEnvelope(error);
  if (guardrail) {
    return completionError(
      guardrail.message,
      guardrail.code === "guardrail_approval_required" ? 409 : 403,
      guardrail.code,
      guardrail.type,
    );
  }
  return completionError(
    "Runtime guardrail preflight failed",
    500,
    "guardrail_preflight_failed",
    "server_error",
  );
}

function guardrailContext(
  options: PrepareConversationTurnOptions,
  agent?: string,
  user?: string,
) {
  return {
    surface: options.runtime?.surface ?? "agent",
    source: options.runtime?.source ?? "request",
    ...(agent ? { agent } : {}),
    ...(options.runtime?.runId ? { runId: options.runtime.runId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(user ? { metadata: { externalUserId: user } } : {}),
  } as const;
}

async function guardLatestUserInput(
  deps: CompletionRouteDeps,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions,
  agent?: string,
): Promise<CompletionRequestBody> {
  if (!deps.runPreflightPolicy) return body;
  let index = -1;
  for (let cursor = body.messages.length - 1; cursor >= 0; cursor--) {
    if (body.messages[cursor]?.role === "user") {
      index = cursor;
      break;
    }
  }
  if (index < 0) return body;
  const message = body.messages[index]!;
  const evaluated = await deps.runPreflightPolicy.evaluate({
    phase: "input",
    value: message.content,
    mode: deps.runPreflightPolicyMode ?? "enforce",
    context: guardrailContext(options, agent, body.user),
    signal: options.signal,
  });
  assertCompletionMessageContent(evaluated.value, evaluated.decisions);
  if (Object.is(evaluated.value, message.content)) return body;
  const messages = [...body.messages];
  messages[index] = { ...message, content: evaluated.value } as typeof message;
  return { ...body, messages };
}

async function guardRuntimeContext(
  deps: CompletionRouteDeps,
  value: RuntimeContextResolution | undefined,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions,
  agent?: string,
): Promise<RuntimeContextResolution | undefined> {
  if (!deps.runPreflightPolicy || !value) return value;
  const evaluated = await deps.runPreflightPolicy.evaluate({
    phase: "context",
    value,
    mode: deps.runPreflightPolicyMode ?? "enforce",
    context: guardrailContext(options, agent, body.user),
    signal: options.signal,
  });
  assertRuntimeContextResolution(evaluated.value, evaluated.decisions);
  return evaluated.value;
}

async function guardModelPreflight<T extends {
  systemPrompt: string;
  messages: any[];
  runtimeContext?: RuntimeContextResolution;
}>(
  deps: CompletionRouteDeps,
  value: T,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions,
  agent?: string,
): Promise<T> {
  if (!deps.runPreflightPolicy) return value;
  const evaluated = await deps.runPreflightPolicy.evaluate({
    phase: "model.preflight",
    value,
    mode: deps.runPreflightPolicyMode ?? "enforce",
    context: guardrailContext(options, agent, body.user),
    signal: options.signal,
  });
  assertModelPreflightValue(evaluated.value, evaluated.decisions);
  return evaluated.value;
}

function freezePlanningInput<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezePlanningInput(nested);
  }
  return Object.freeze(value);
}

function cloneModelSelection(
  selection: ProfiledModelSelection | undefined,
): ProfiledModelSelection | undefined {
  if (!selection || typeof selection === "string") return selection;
  if ("profile" in selection) return { profile: selection.profile };
  const cloneTarget = (target: ModelTarget): ModelTarget =>
    typeof target === "string" ? target : { profile: target.profile };
  return {
    primary: cloneTarget(selection.primary),
    ...(selection.fallbacks !== undefined
      ? { fallbacks: selection.fallbacks.map(cloneTarget) }
      : {}),
  };
}

async function resolveCompletionRuntimePlan(
  deps: CompletionRouteDeps,
  body: CompletionRequestBody,
  invocation: CompletionRuntimeInvocation | undefined,
  agentConfig: any | undefined,
  execution: CompletionRuntimePlanInput["execution"],
): Promise<RuntimePlan | undefined> {
  if (!deps.resolveRuntimePlan) return undefined;

  const { surface, source } = invocation ?? {
    surface: "agent",
    source: "request",
  } as const;
  const input: CompletionRuntimePlanInput = freezePlanningInput({
    surface,
    source,
    execution,
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
              ? {
                  ...(agentConfig.sandbox.isolation
                    ? { isolation: agentConfig.sandbox.isolation }
                    : {}),
                  ...(agentConfig.sandbox.lifecycle
                    ? { lifecycle: { ...agentConfig.sandbox.lifecycle } }
                    : {}),
                }
              : undefined,
            allowedTools: Array.isArray(agentConfig.allowedTools)
              ? [...agentConfig.allowedTools]
              : undefined,
          },
        }
      : {}),
  });

  const plan = normalizeRuntimePlan(await deps.resolveRuntimePlan(input));
  if (
    plan.surface !== surface ||
    plan.source !== source ||
    plan.execution.mode !== execution.mode ||
    plan.execution.loop !== execution.loop ||
    plan.execution.source !== execution.source
  ) {
    throw new Error("Runtime plan contradicted validated execution routing");
  }
  deps.emit("runtime:plan", createRuntimePlanResolvedEvent(plan));
  return plan;
}

function completionInvocation(
  invocation: CompletionRuntimeInvocation | undefined,
): CompletionRuntimeInvocation {
  return invocation ?? { surface: "agent", source: "request" };
}

function toolInvocationSurface(
  invocation: CompletionRuntimeInvocation,
  loop: boolean,
): ToolInvocationContext["surface"] {
  if (invocation.surface === "channel" || invocation.source === "channel") return "channel";
  if (invocation.source === "schedule") return "schedule";
  if (invocation.surface === "task" || invocation.source === "task") return "task";
  if (loop || invocation.source === "loop-step") return "loop";
  return "chat";
}

export function createCompletionToolInvocation(input: {
  body: CompletionRequestBody;
  completionId: string;
  loop?: boolean;
  runtime?: CompletionRuntimeInvocation;
  sessionId?: string | null;
}): ToolInvocationContext {
  const invocation = completionInvocation(input.runtime);
  const user = invocation.user ?? input.body.user;
  return createToolInvocationContext({
    requestId: invocation.requestId ?? input.completionId,
    runId: invocation.runId ?? input.completionId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(user ? { user } : {}),
    metadata: (invocation.metadata ?? input.body.metadata ?? {}) as Record<
      string,
      ToolInvocationJsonValue
    >,
    surface: toolInvocationSurface(invocation, input.loop ?? false),
  });
}

function defaultExecution(): CompletionRuntimePlanInput["execution"] {
  return { mode: "direct", source: "default" };
}

function executionForRoute(
  route: ResolvedExecutionRoute | undefined,
): CompletionRuntimePlanInput["execution"] {
  return route
    ? executionRouteRuntimePlanFields(route).execution
    : defaultExecution();
}

async function resolveAutomaticExecutionRoute(
  deps: CompletionRouteDeps,
  agentConfig: any,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions,
): Promise<{
  route: ResolvedExecutionRoute;
  projectLoops: Map<string, ProjectLoopConfig>;
}> {
  validateExecutionRouterConfig(agentConfig.executionRouter);
  const assignedLoops = Array.isArray(agentConfig.assignedLoops)
    ? agentConfig.assignedLoops
    : [];
  const configuredAllowedLoops = Array.isArray(
    agentConfig.executionRouter?.allowedLoops,
  )
    ? agentConfig.executionRouter.allowedLoops
    : [];
  const allowed = new Set(configuredAllowedLoops);
  const candidateNames = [...new Set(
    assignedLoops.filter((name: unknown) =>
      typeof name === "string" && allowed.has(name)),
  )] as string[];
  const projectLoops = new Map<string, ProjectLoopConfig>();
  if (deps.getProjectLoop) {
    const loaded = await Promise.all(
      candidateNames.map(async (name) => ({
        name,
        loop: await deps.getProjectLoop!(name),
      })),
    );
    for (const { name, loop } of loaded) {
      if (loop) projectLoops.set(name, loop);
    }
  }
  const lastUserMessage = [...body.messages]
    .reverse()
    .find((message) => message.role === "user");
  const invocation = completionInvocation(options.runtime);
  const route = await resolveExecutionRoute({
    surface: invocation.surface,
    source: invocation.source,
    input: lastUserMessage ? extractText(lastUserMessage.content) : "",
    labels: body.routing?.labels,
    manifest: compileExecutionRouteManifest({
      assignedLoops: candidateNames,
      projectLoops: [...projectLoops.values()],
    }),
    config: agentConfig.executionRouter,
  }, {
    resolveClassifier: deps.resolveExecutionRouteClassifier
      ? () => deps.resolveExecutionRouteClassifier!({
          surface: invocation.surface,
          source: invocation.source,
          agentName: agentConfig.name,
          ...(body.user ? { userId: body.user } : {}),
        })
      : undefined,
    signal: options.signal,
  });
  return { route, projectLoops };
}

export async function prepareChatCompletionExecution(
  deps: CompletionRouteDeps,
  body: CompletionRequestBody,
  options: PrepareConversationTurnOptions = {},
): Promise<PreparedConversationTurn> {
  const agentMode = !!body.agent;
  let effectiveBody = body;
  let initialAgentConfig: any;
  if (agentMode) {
    const agents = await deps.getAgents();
    initialAgentConfig = agents.find((agent: any) => agent.name === body.agent);
    if (!initialAgentConfig) {
      return completionError(`Agent "${body.agent}" not found`, 404, "agent_not_found");
    }
  }
  if (body.guardrails) {
    if (!deps.resolveRuntimeGuardrails) {
      return completionError(
        "Per-request guardrail policy is not available on this runtime",
        400,
        "invalid_guardrail_policy",
      );
    }
    try {
      const resolved = await deps.resolveRuntimeGuardrails(body.guardrails);
      if (
        !resolved.runPreflightPolicy
        || !resolved.runToolMiddleware
        || !resolved.runOutputPolicy
      ) {
        throw new Error("Guardrail resolver returned incomplete runtime hooks");
      }
      deps = { ...deps, ...resolved };
    } catch (error) {
      if (error instanceof TypeError) {
        return completionError(
          error.message,
          400,
          "invalid_guardrail_policy",
        );
      }
      return completionError(
        "Runtime guardrail policy resolution failed",
        500,
        "guardrail_resolution_failed",
        "server_error",
      );
    }
  }
  try {
    effectiveBody = await guardLatestUserInput(
      deps,
      body,
      options,
      initialAgentConfig?.name,
    );
  } catch (error) {
    return preflightError(error);
  }
  body = effectiveBody;
  let fullSystemPrompt: string;
  let m: ResolvedModelInfo;
  let providerOpts: Record<string, any> | undefined;
  let modelSelection: ModelSelection | undefined;
  let modelToolChoice: unknown | undefined;
  let effectiveTools: any[];
  let effectiveToolExecutor: CompletionToolExecutor;
  let toolDisclosure: ModelControlledToolDisclosureConfig | undefined;
  let activeToolNames: (() => string[]) | undefined;
  let activeCompactionTools: (() => any[]) | undefined;
  let extraAiTools: Record<string, any> | undefined;
  let isInteractiveFn: ((name: string) => boolean) | undefined;
  let projectLoopRuntime: { agentConfig: any; projectLoop: ProjectLoopConfig } | undefined;
  let onResponseFinished: (() => Promise<void>) | undefined;
  let resolvedAgentConfig: any;
  let runtimePlan: RuntimePlan | undefined;
  let runtimeContext: RuntimeContextResolution | undefined;
  let executionRoute: ResolvedExecutionRoute | undefined;
  let deferredAgentTools = false;
  const completionId = options.completionId ?? `chatcmpl-${nanoid(24)}`;

  const invocation = completionInvocation(options.runtime);
  const interactionSettings = normalizeChatInteractionSettings(
    initialAgentConfig?.chat,
  );
  const interactionCapabilities = resolveChatInteractionCapabilities({
    surface: invocation.surface,
    settings: interactionSettings,
    client: body.polpo?.capabilities,
  });
  const clientSideTools = clientSideToolsForCapabilities(interactionCapabilities);
  const clientSideToolNames = new Set(Object.keys(clientSideTools));

  const contextTrust = normalizeRuntimeContextTrustMode(
    deps.getConfig()?.settings?.contextTrust,
  );
  const converted = convertMessages(body.messages, contextTrust);
  let {
    aiMessages,
    extraSystemParts,
    promptContextSegments,
  } = converted;
  const callerSystemParts = contextTrust === "enforce" && promptContextSegments.length > 0
    ? [renderRuntimePromptContextSegments(promptContextSegments)]
    : extraSystemParts;

  if (agentMode) {
    let agentConfig = initialAgentConfig;

    if (body.loop) {
      try {
        const selection = resolveLoopSelection(agentConfig, body.loop);
        if (!selection) throw new Error(`Loop "${body.loop}" was not resolved`);
        agentConfig = selection.agent;
        options.setHeader?.("x-loop", selection.name);
        const invocation = completionInvocation(options.runtime);
        executionRoute = createExplicitExecutionRoute({
          surface: invocation.surface,
          source: invocation.source,
          loop: selection.name,
        });
        deps.emit(
          "runtime:execution-route",
          createExecutionRouteResolvedEvent(executionRoute),
        );
        const assignedLoops = Array.isArray(agentConfig.assignedLoops)
          ? agentConfig.assignedLoops
          : [];
        if (assignedLoops.includes(selection.name)) {
          if (!deps.getProjectLoop) {
            throw new Error("Project loop resolver is not configured");
          }
          const projectLoop = await deps.getProjectLoop(selection.name);
          if (!projectLoop) {
            throw new Error(
              `Assigned project loop "${selection.name}" was not found`,
            );
          }
          projectLoopRuntime = { agentConfig, projectLoop };
        }
      } catch (loopErr) {
        const msg = loopErr instanceof Error ? loopErr.message : String(loopErr);
        return completionError(msg, 400, "loop_not_found");
      }
    } else if (agentConfig.executionRouter?.mode === "auto") {
      try {
        const routed = await resolveAutomaticExecutionRoute(
          deps,
          agentConfig,
          body,
          options,
        );
        executionRoute = routed.route;
        deps.emit(
          "runtime:execution-route",
          createExecutionRouteResolvedEvent(executionRoute),
        );
        if (executionRoute.mode === "loop") {
          const selection = resolveLoopSelection(
            agentConfig,
            executionRoute.loop,
          );
          if (!selection) {
            throw new Error(
              `Execution router loop "${executionRoute.loop}" was not resolved`,
            );
          }
          const projectLoop = routed.projectLoops.get(selection.name);
          if (!projectLoop) {
            throw new Error(
              `Execution router loop "${selection.name}" was not loaded`,
            );
          }
          agentConfig = selection.agent;
          projectLoopRuntime = { agentConfig, projectLoop };
          options.setHeader?.("x-loop", selection.name);
        }
      } catch {
        return completionError(
          "Runtime execution routing failed",
          500,
          "runtime_execution_routing_failed",
          "server_error",
        );
      }
    }
    resolvedAgentConfig = agentConfig;
    modelToolChoice = toAIToolChoice(agentConfig.toolChoice);

    try {
      runtimePlan = await resolveCompletionRuntimePlan(
        deps,
        body,
        options.runtime,
        resolvedAgentConfig,
        executionForRoute(executionRoute),
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
    try {
      runtimeContext = await guardRuntimeContext(
        deps,
        runtimeContext,
        body,
        options,
        resolvedAgentConfig.name,
      );
    } catch (error) {
      return preflightError(error);
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
          extraSystemParts: callerSystemParts,
          includeAgentMemory: !replacesLegacyAgentMemory(runtimeContext),
          includeSharedMemory: !replacesLegacySharedMemory(runtimeContext),
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
        fullSystemPrompt = callerSystemParts.length > 0
          ? `${basePrompt}\n\n## Additional context from caller\n\n${callerSystemParts.join("\n\n")}`
          : basePrompt;

        if (!replacesLegacyAgentMemory(runtimeContext)) {
          const memoryStore = deps.getMemoryStore();
          const agentMemory = await memoryStore?.get(agentMemoryScope(agentConfig.name));
          if (agentMemory) {
            fullSystemPrompt += contextTrust === "enforce"
              ? `\n\n${renderRuntimePromptContextSegment(createRuntimePromptContextSegment({
                  kind: "memory.agent",
                  sourceId: agentConfig.name,
                  trust: "untrusted",
                  content: agentMemory,
                }))}`
              : `\n\n## Your persistent memory\n\n${agentMemory}`;
          }
        }
      }
      const runtimeContextPrompt = renderRuntimeContextPrompt(runtimeContext);
      if (runtimeContextPrompt) {
        fullSystemPrompt += `\n\n${runtimeContextPrompt}`;
      }

      try {
        const guarded = await guardModelPreflight(
          deps,
          {
            systemPrompt: fullSystemPrompt,
            messages: aiMessages,
            ...(runtimeContext ? { runtimeContext } : {}),
          },
          body,
          options,
          resolvedAgentConfig.name,
        );
        fullSystemPrompt = guarded.systemPrompt;
        aiMessages = guarded.messages;
        runtimeContext = guarded.runtimeContext;
      } catch (error) {
        return preflightError(error);
      }

      const reasoning = agentConfig.reasoning ?? deps.getConfig()?.settings?.reasoning;
      const settings = deps.getConfig()?.settings;
      let resolved;
      try {
        resolved = await deps.resolveAgentModel(
          agentConfigForModelPrimary(agentConfig, settings),
          reasoning,
        );
      } catch (modelErr) {
        const msg = modelErr instanceof Error ? modelErr.message : String(modelErr);
        return completionError(msg, 400);
      }
      m = resolved.model;
      providerOpts = resolved.providerOptions;
      modelSelection = modelSelectionForAgent(
        agentConfig,
        modelSelectionForResolvedModel(m),
        settings,
      );

      effectiveTools = [];
      effectiveToolExecutor = async () => "Error: Agent tools have not been resolved";
      deferredAgentTools = true;
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
        defaultExecution(),
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
    fullSystemPrompt = callerSystemParts.length > 0
      ? `${ctx.systemPrompt}\n\n## Additional context from caller\n\n${callerSystemParts.join("\n\n")}`
      : ctx.systemPrompt;
    try {
      const guarded = await guardModelPreflight(
        deps,
        { systemPrompt: fullSystemPrompt, messages: aiMessages },
        body,
        options,
      );
      fullSystemPrompt = guarded.systemPrompt;
      aiMessages = guarded.messages;
    } catch (error) {
      return preflightError(error);
    }
    m = ctx.model;
    providerOpts = ctx.providerOptions;
    modelSelection = modelSelectionForResolvedModel(m);
    effectiveTools = ctx.tools;
    effectiveToolExecutor = ctx.executor;
    isInteractiveFn = ctx.isInteractive;
  }

  if (projectLoopRuntime && isStructuredResponseFormat(body.response_format)) {
    return completionError(
      "response_format is not supported with project loop execution",
      400,
      "unsupported_response_format",
    );
  }

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

  if (deferredAgentTools) {
    const toolInvocation = createCompletionToolInvocation({
      body,
      completionId,
      runtime: options.runtime,
      sessionId,
    });
    const resolvedTools = await deps.resolveAgentTools(
      resolvedAgentConfig,
      undefined,
      toolInvocation,
    );
    effectiveTools = resolvedTools.tools;
    effectiveToolExecutor = resolvedTools.executor;
    toolDisclosure = resolvedTools.disclosure;
    onResponseFinished = resolvedTools.cleanup;
    extraAiTools = resolvedTools.extraAiTools;
  }

  if (!projectLoopRuntime) {
    effectiveToolExecutor = createGuardedCompletionToolExecutor({
      executor: effectiveToolExecutor,
      tools: effectiveTools,
      middleware: deps.runToolMiddleware,
      context: {
        planId: runtimePlan?.id,
        surface: runtimePlan?.surface,
        source: runtimePlan?.source,
        agent: resolvedAgentConfig?.name,
        sessionId: sessionId ?? undefined,
      },
    });

    if (toolDisclosure?.mode === "model-controlled") {
      const configuredInitial = [...(toolDisclosure.initiallyLoaded ?? [])];
      const forcedTool = forcedModelToolName(modelToolChoice);
      if (forcedTool && effectiveTools.some((tool) => tool?.name === forcedTool)) {
        configuredInitial.push(forcedTool);
      }
      const pool = createModelControlledToolPool({
        tools: effectiveTools,
        executor: effectiveToolExecutor,
        initiallyLoaded: [...new Set(configuredInitial)],
        maxLoadedTools: toolDisclosure.maxLoadedTools,
        maxLoadBatch: toolDisclosure.maxLoadBatch,
        maxSearchResults: toolDisclosure.maxSearchResults,
      });
      const alwaysActive = [
        ...Object.keys(extraAiTools ?? {}),
        ...clientSideToolNames,
      ];
      effectiveTools = pool.tools;
      effectiveToolExecutor = pool.executor;
      fullSystemPrompt = `${fullSystemPrompt}\n\n${MODEL_CONTROLLED_TOOL_PROMPT}`;
      activeToolNames = () => [...new Set([
        ...pool.startModelTurn(),
        ...alwaysActive,
      ])];
      activeCompactionTools = pool.activeTools;
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
      extraSystemParts: callerSystemParts,
      contextTrust,
      sessionStore,
      sessionId,
      runtimePlan,
      runtimeContext,
      runtimeInvocation: options.runtime,
      executionRoute,
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
    modelOutput: modelOutputForResponseFormat(body.response_format),
    effectiveTools,
    effectiveToolExecutor,
    interactionSettings,
    interactionCapabilities,
    clientSideTools,
    clientSideToolNames,
    activeToolNames,
    activeCompactionTools,
    extraAiTools,
    isInteractiveFn,
    aiMessages,
    sessionStore,
    sessionId,
    onResponseFinished,
    runtimePlan,
    contextTrust,
    runtimeContext,
    executionRoute,
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
