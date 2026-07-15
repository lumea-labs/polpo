/**
 * Project loop runtime for the chat completions endpoint.
 *
 * Runs an assigned/default project loop as a deterministic pipeline
 * (PipelineExecutor) with agent steps delegated to the agent-step runner.
 * Also owns loop-run persistence (traces, approvals, resume checkpoints)
 * and the HTTP wiring for loop-mode requests (streaming + non-streaming).
 */

import { streamSSE } from "hono/streaming";
import { nanoid } from "nanoid";
import {
  PipelineExecutor,
  LoopApprovalRequiredError,
  LoopPermissionApprovalRequiredError,
  buildLoopStepAgent,
  maybeParseJson,
  normalizeProjectLoop,
  normalizeToolInput,
  stringifyLoopContext,
  type ContextBag,
  type LoopApprovedGate,
  type LoopRunRecord,
  type LoopResumeState,
  type LoopTraceEvent,
  type ProjectLoopConfig,
} from "@polpo-ai/core";
import type { LanguageModelUsage } from "ai";
import type { CompletionRouteDeps } from "../completions.js";
import {
  addUsage,
  runAgentStepCompletion,
  type CompletionResolvedModelInfo,
} from "./agent-step-runner.js";
import { completionResponse, loopRuntimeErrorEnvelope, modelNotFoundEnvelope, sseChunk } from "./sse.js";
import { emitFileChanged, persistAssistantMessage, type LoopRuntimeToolCall } from "./tool-mapping.js";

export interface ProjectLoopRunResult {
  text: string;
  usage: LanguageModelUsage;
  model: string;
  resolvedModel?: CompletionResolvedModelInfo;
  providerMetadata?: Record<string, unknown>;
  toolCalls: any[];
  context: ContextBag;
  trace: LoopTraceEvent[];
  loopRunId?: string;
}

export async function runProjectLoopCompletion(options: {
  deps: CompletionRouteDeps;
  agentConfig: any;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  sessionId?: string | null;
  user?: string;
  onToolCall?: (toolCall: LoopRuntimeToolCall) => Promise<void>;
  onTrace?: (event: LoopTraceEvent) => Promise<void>;
  resumeRun?: LoopRunRecord;
}): Promise<ProjectLoopRunResult> {
  const { deps, agentConfig, projectLoop, aiMessages, extraSystemParts, sessionId, user, onToolCall, onTrace, resumeRun } = options;
  const normalized = normalizeProjectLoop(projectLoop);
  if (!normalized.pipeline) throw new Error(`Loop "${projectLoop.name}" does not define a pipeline`);

  const rootTools = await deps.resolveAgentTools(agentConfig);
  const loopRunStore = deps.getLoopRunStore?.();
  const resumeState = resumeRun?.resume;
  const loopRunId = resumeRun?.id ?? (loopRunStore ? `looprun-${nanoid(16)}` : undefined);
  if (loopRunStore && loopRunId && resumeRun) {
    await loopRunStore.updateRun(loopRunId, {
      status: "resuming",
      error: undefined,
      completedAt: undefined,
      metadata: {
        ...resumeRun.metadata,
        resumedAt: new Date().toISOString(),
        resumeAttempts: (resumeState?.attempts ?? 0) + 1,
      },
      resume: resumeState ? {
        ...resumeState,
        attempts: (resumeState.attempts ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      } : undefined,
    });
  } else if (loopRunStore && loopRunId) {
    await loopRunStore.createRun({
      id: loopRunId,
      loop: projectLoop,
      agentName: agentConfig.name,
      sessionId: sessionId ?? undefined,
      user,
      metadata: {
        runtime: "chat.completions",
        loopVersion: projectLoop.version ?? "1",
      },
    });
  }
  const executor = new PipelineExecutor();
  let finalText = "";
  let totalUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let lastModel = agentConfig.model ?? "polpo";
  let lastResolvedModel: CompletionResolvedModelInfo | undefined;
  let lastProviderMetadata: Record<string, unknown> | undefined;
  const toolCallsAccum: any[] = [];
  const events: LoopTraceEvent[] = [];

  const emitTrace = async (event: LoopTraceEvent) => {
    events.push(event);
    if (loopRunStore && loopRunId) {
      try {
        await loopRunStore.appendTrace(loopRunId, event);
      } catch (err) {
        deps.emit("loop_run:trace_persist_failed", {
          loopRunId,
          loop: projectLoop.name,
          eventType: event.type,
          error: (err as Error).message,
        });
      }
    }
    try {
      await onTrace?.(event);
    } catch (err) {
      deps.emit("loop_run:trace_delivery_failed", {
        loopRunId,
        loop: projectLoop.name,
        eventType: event.type,
        error: (err as Error).message,
      });
    }
  };

  try {
    const result = await executor.execute({
      name: projectLoop.name,
      pipeline: resumeState ? { ...normalized.pipeline, steps: resumeState.steps } : normalized.pipeline,
      loops: normalized.loops,
      context: resumeState?.context ?? {},
      projectHooks: projectLoop.hooks,
      projectPermissions: projectLoop.permissions,
      projectPolicies: projectLoop.policies,
      resume: resumeState ? {
        previousNode: resumeState.previousNode,
        approvedGates: resumeState.approvedGates,
      } : undefined,
      onTrace: async (event) => {
        await emitTrace(event);
      },
      runTool: async (name, input) => {
        const args = normalizeToolInput(input);
        const id = `loop-tool-${nanoid(12)}`;
        await onToolCall?.({
          id,
          name,
          arguments: args,
          state: "calling",
        });
        const output = await rootTools.executor(name, args);
        const isError = output.startsWith("Error:");
        emitFileChanged(name, args, output, deps.emit);
        const event = {
          id,
          name,
          arguments: args,
          result: output,
          state: isError ? "error" as const : "completed" as const,
        };
        toolCallsAccum.push(event);
        await onToolCall?.(event);
        if (isError) throw new Error(output);
        return { output: maybeParseJson(output) };
      },
      runLoop: async (name, loop, context) => {
        const id = `loop-step-${nanoid(12)}`;
        await onToolCall?.({
          id,
          name: `loop:${name}`,
          arguments: { loop: projectLoop.name, step: name },
          state: "calling",
        });
        const stepAgent = buildLoopStepAgent(agentConfig, name, loop);
        const stepResult = await runAgentStepCompletion({
          deps,
          agentConfig: stepAgent,
          aiMessages,
          extraSystemParts,
          context,
          stepName: name,
          onToolCall,
        });
        finalText = stepResult.text || finalText;
        totalUsage = addUsage(totalUsage, stepResult.usage);
        lastModel = stepResult.model;
        lastResolvedModel = stepResult.resolvedModel;
        lastProviderMetadata = stepResult.providerMetadata;
        toolCallsAccum.push(...stepResult.toolCalls);
        const output = stringifyLoopContext({ [name]: stepResult.output });
        const event = {
          id,
          name: `loop:${name}`,
          arguments: { loop: projectLoop.name, step: name },
          result: output,
          state: "completed" as const,
        };
        toolCallsAccum.push(event);
        await onToolCall?.(event);
        return { output: stepResult.output };
      },
      handleHuman: async (name) => {
        throw new Error(`Loop human step "${name}" cannot run inside chat completions yet`);
      },
    });

    if (!finalText) finalText = JSON.stringify(result.context, null, 2);
    if (loopRunStore && loopRunId) {
      await loopRunStore.updateRun(loopRunId, {
        status: "completed",
        context: result.context,
        trace: resumeRun ? [...resumeRun.trace, ...result.events] : result.events,
        resume: undefined,
        approval: resumeRun?.approval ? { ...resumeRun.approval, status: "approved" } : undefined,
        completedAt: new Date().toISOString(),
      });
    }
    return {
      text: finalText,
      usage: totalUsage,
      model: lastModel,
      resolvedModel: lastResolvedModel,
      providerMetadata: lastProviderMetadata,
      toolCalls: toolCallsAccum,
      context: result.context,
      trace: result.events,
      loopRunId,
    };
  } catch (err) {
    if (loopRunStore && loopRunId) {
      (err as any).loopRunId = loopRunId;
      if (err instanceof LoopApprovalRequiredError || err instanceof LoopPermissionApprovalRequiredError) {
        const approvalStore = deps.getApprovalStore?.();
        let approvalRequestId: string | undefined;
        const gateId = err instanceof LoopPermissionApprovalRequiredError
          ? err.permission.id ?? `loop-permission-${nanoid(8)}`
          : err.policy.id ?? `loop-policy-${nanoid(8)}`;
        const gateName = err instanceof LoopPermissionApprovalRequiredError
          ? err.permission.description ?? err.permission.id ?? "Loop permission approval"
          : err.policy.description ?? err.policy.id ?? "Loop policy approval";
        const approvalType = err instanceof LoopPermissionApprovalRequiredError ? "permission" : "policy";
        if (approvalStore) {
          approvalRequestId = `approval-${nanoid(16)}`;
          await approvalStore.upsert({
            id: approvalRequestId,
            gateId,
            gateName,
            status: "pending",
            payload: {
              type: "loop_approval",
              approvalType,
              loopRunId,
              loopName: projectLoop.name,
              agentName: agentConfig.name,
              hook: err.hook,
              ...(err instanceof LoopPermissionApprovalRequiredError ? { permission: err.permission } : { policy: err.policy }),
              payload: err.payload,
              context: err.context,
              trace: events,
            },
            requestedAt: new Date().toISOString(),
          });
          (err as any).approvalRequestId = approvalRequestId;
        }
        await loopRunStore.updateRun(loopRunId, {
          status: "awaiting_approval",
          context: err.context,
          trace: resumeRun ? [...resumeRun.trace, ...events] : events,
          approvalRequestId,
          approval: {
            type: approvalType,
            policyId: err instanceof LoopPermissionApprovalRequiredError ? "permission" : err.policy.id ?? "anonymous",
            permissionId: err instanceof LoopPermissionApprovalRequiredError ? err.permission.id ?? "anonymous" : undefined,
            hook: err.hook,
            message: err instanceof LoopPermissionApprovalRequiredError ? err.permission.message : err.policy.message,
            payload: err.payload,
            context: err.context,
            status: "pending",
          },
          resume: buildLoopResumeState(err.resume, aiMessages, extraSystemParts, resumeRun?.resume?.approvedGates),
          error: err.message,
        });
      } else {
        await loopRunStore.updateRun(loopRunId, {
          status: "failed",
          trace: resumeRun ? [...resumeRun.trace, ...events] : events,
          error: err instanceof Error ? err.message : String(err),
          completedAt: new Date().toISOString(),
        });
      }
    }
    throw err;
  } finally {
    if (rootTools.cleanup) {
      rootTools.cleanup().catch(() => {});
    }
  }
}

export function buildLoopResumeState(
  continuation: { context: ContextBag; steps: any[]; previousNode?: string } | undefined,
  aiMessages: any[],
  extraSystemParts: string[],
  approvedGates: LoopApprovedGate[] | undefined,
): LoopResumeState | undefined {
  if (!continuation) return undefined;
  return {
    context: continuation.context,
    steps: continuation.steps,
    previousNode: continuation.previousNode,
    approvedGates: approvedGates ?? [],
    runtime: {
      aiMessages,
      extraSystemParts,
    },
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
}

export async function resumeProjectLoopRun(options: {
  deps: CompletionRouteDeps;
  runId: string;
  resolvedBy?: string;
}): Promise<LoopRunRecord> {
  const loopRunStore = options.deps.getLoopRunStore?.();
  if (!loopRunStore) throw new Error("Loop run store is not configured");

  const run = await loopRunStore.getRun(options.runId);
  if (!run) throw new Error(`Loop run "${options.runId}" not found`);
  if (run.status !== "approval_approved") {
    throw new Error(`Loop run "${options.runId}" is ${run.status}, not approval_approved`);
  }
  if (!run.resume || run.resume.steps.length === 0) {
    throw new Error(`Loop run "${options.runId}" has no resume checkpoint`);
  }

  const agents = await options.deps.getAgents();
  const agentConfig = agents.find((agent: any) => agent.name === run.agentName);
  if (!agentConfig) throw new Error(`Agent "${run.agentName ?? "unknown"}" not found for loop run "${run.id}"`);
  if (!options.deps.getProjectLoop) throw new Error("Project loop resolver is not configured");
  const projectLoop = await options.deps.getProjectLoop(run.loopName);
  if (!projectLoop) throw new Error(`Project loop "${run.loopName}" not found`);

  const aiMessages = Array.isArray(run.resume.runtime?.aiMessages) ? run.resume.runtime.aiMessages : [];
  const extraSystemParts = Array.isArray(run.resume.runtime?.extraSystemParts)
    ? run.resume.runtime.extraSystemParts as string[]
    : [];

  await runProjectLoopCompletion({
    deps: options.deps,
    agentConfig,
    projectLoop,
    aiMessages,
    extraSystemParts,
    sessionId: run.sessionId,
    user: run.user,
    resumeRun: run,
  });

  const updated = await loopRunStore.getRun(run.id);
  if (!updated) throw new Error(`Loop run "${run.id}" disappeared after resume`);
  return updated;
}

/**
 * HTTP wiring for loop-mode completion requests: runs the project loop
 * pipeline and adapts it to the OpenAI response surface (SSE stream with
 * tool_call / loop_trace chunks, or a single JSON body).
 */
export async function handleProjectLoopCompletion(c: any, options: {
  deps: CompletionRouteDeps;
  body: { stream?: boolean; agent?: string; user?: string };
  completionId: string;
  agentConfig: any;
  projectLoop: ProjectLoopConfig;
  aiMessages: any[];
  extraSystemParts: string[];
  sessionStore: any;
  sessionId: string | null;
}): Promise<any> {
  const { deps, body, completionId, agentConfig, projectLoop, aiMessages, extraSystemParts, sessionStore, sessionId } = options;

  if (body.stream) {
    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();
      stream.onAbort(() => { abortController.abort(); });
      const heartbeatInterval = setInterval(() => {
        if (abortController.signal.aborted) {
          clearInterval(heartbeatInterval);
          return;
        }
        stream.write(": ping\n\n").catch(() => {
          clearInterval(heartbeatInterval);
        });
      }, 20_000);

      let assistantMsgId: string | null = null;
      let finalText = "";
      let runUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
      let runModel = agentConfig.model ?? "polpo";
      let resolvedModel: CompletionResolvedModelInfo | undefined;
      let providerMetadata: Record<string, unknown> | undefined;
      let toolCalls: any[] = [];

      try {
        await stream.writeSSE({ data: sseChunk(completionId, { role: "assistant" }) });
        if (sessionStore && sessionId) {
          const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
          assistantMsgId = placeholder.id;
        }

        const run = await runProjectLoopCompletion({
          deps,
          agentConfig,
          projectLoop,
          aiMessages,
          extraSystemParts,
          sessionId,
          user: body.user,
          onToolCall: async (toolCall) => {
            if (abortController.signal.aborted) return;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, { tool_call: toolCall }),
            });
          },
          onTrace: async (event) => {
            if (abortController.signal.aborted) return;
            await stream.writeSSE({
              data: sseChunk(completionId, {}, null, { loop_trace: event }),
            });
          },
        });
        finalText = run.text;
        runUsage = run.usage;
        runModel = run.model;
        resolvedModel = run.resolvedModel;
        providerMetadata = run.providerMetadata;
        toolCalls = run.toolCalls;

        if (!abortController.signal.aborted && finalText) {
          await stream.writeSSE({ data: sseChunk(completionId, { content: finalText }) });
        }
        if (!abortController.signal.aborted) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { loop_run_id: run.loopRunId }) });
          await stream.writeSSE({ data: "[DONE]" });
        }
      } catch (err) {
        if ((err instanceof DOMException && err.name === "AbortError") || abortController.signal.aborted) {
          return;
        }
        const notFound = modelNotFoundEnvelope(err, runModel, body.agent);
        if (notFound) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: notFound }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        const loopError = loopRuntimeErrorEnvelope(err);
        if (loopError) {
          await stream.writeSSE({ data: sseChunk(completionId, {}, "stop", { error: loopError }) });
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        throw err;
      } finally {
        clearInterval(heartbeatInterval);
        await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls);
        try {
          deps.onCompletionFinished?.({
            usage: runUsage,
            model: runModel,
            resolvedModel,
            agent: body.agent,
            sessionId: sessionId ?? undefined,
            user: body.user,
            providerMetadata,
          });
        } catch { /* never fail on callback */ }
      }
    }) as any;
  }

  let assistantMsgId: string | null = null;
  let runUsage: LanguageModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as LanguageModelUsage;
  let runModel = agentConfig.model ?? "polpo";
  let resolvedModel: CompletionResolvedModelInfo | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  let toolCalls: any[] = [];
  let finalText = "";
  try {
    if (sessionStore && sessionId) {
      const placeholder = await sessionStore.addMessage(sessionId, "assistant", "");
      assistantMsgId = placeholder.id;
    }
    const run = await runProjectLoopCompletion({
      deps,
      agentConfig,
      projectLoop,
      aiMessages,
      extraSystemParts,
      sessionId,
      user: body.user,
    });
    finalText = run.text;
    runUsage = run.usage;
    runModel = run.model;
    resolvedModel = run.resolvedModel;
    providerMetadata = run.providerMetadata;
    toolCalls = run.toolCalls;
    return c.json(completionResponse(completionId, finalText, runUsage, { loop_trace: run.trace, loop_run_id: run.loopRunId }));
  } catch (err) {
    const notFound = modelNotFoundEnvelope(err, runModel, body.agent);
    if (notFound) {
      return c.json({ error: notFound }, 400 as any);
    }
    const loopError = loopRuntimeErrorEnvelope(err);
    if (loopError) {
      return c.json({ error: loopError }, 403 as any);
    }
    throw err;
  } finally {
    await persistAssistantMessage(sessionStore, sessionId, assistantMsgId, finalText, toolCalls);
    try {
      deps.onCompletionFinished?.({
        usage: runUsage,
        model: runModel,
        resolvedModel,
        agent: body.agent,
        sessionId: sessionId ?? undefined,
        user: body.user,
        providerMetadata,
      });
    } catch { /* never fail on callback */ }
  }
}
