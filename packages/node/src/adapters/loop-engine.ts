/**
 * Loop-engine — the task runtime driven by the core loop system.
 *
 * Same external contract as spawnEngine (AgentHandle in, TaskResult out),
 * but the agentic loop is @polpo-ai/core's LoopRunner instead of a manual
 * for-loop, and agents with configured loops get the full graph runtime:
 *
 * - No loop config on the agent  → one implicit "default" loop, behavior
 *   identical to the legacy engine (proven by the parity suite).
 * - defaultLoop/loops on the agent → the selected loop's overlays apply
 *   (tools subset, systemPrompt, model, maxTurns), same merge semantics
 *   as chat completions (buildLoopStepAgent).
 * - assignedLoops + project loop graph (.polpo/loops/<name>.json) → the
 *   PipelineExecutor drives the step graph: agent steps are independent
 *   LLM sessions communicating through the context bag, tool steps run
 *   deterministically without an LLM turn.
 *
 * Setup semantics (model resolution, sandbox paths, system prompt, tool
 * building) are shared with the legacy engine via prepareSpawn/
 * buildAgentTools so the two stay byte-identical during the migration.
 *
 * Known deliberate differences from the legacy engine:
 * - In a turn with MULTIPLE tool calls, transcript order is
 *   use,use,...,result,result (the model step completes before execution)
 *   instead of use,result interleaved. Single-call turns are identical.
 */

import { join } from "node:path";
import type { AgentConfig, Task, TaskResult } from "@polpo-ai/core/types";
import type { AgentHandle, SpawnContext } from "@polpo-ai/core/adapter";
import {
  streamText,
  generateText,
  jsonSchema,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { cleanupAgentBrowserSession } from "@polpo-ai/tools";
import {
  LoopRunner,
  PipelineExecutor,
  buildLoopStepAgent,
  loopContextPrompt,
  maybeParseJson,
  normalizeProjectLoop,
  normalizeToolInput,
  resolveLoopSelection,
  compactIfNeeded,
  type SummarizeFn,
  type CompactionEvent,
  type LoopModelResult,
  type PolpoTool,
  type ToolResult,
} from "@polpo-ai/core";
import type { LoopToolCall, LoopConfig, LoopResumeState, ProjectLoopConfig } from "@polpo-ai/core";
import { projectLoopConfigSchema } from "@polpo-ai/core/schemas";
import type { FileSystem } from "@polpo-ai/core/filesystem";
import { NodeFileSystem } from "./node-filesystem.js";
import {
  createActivity,
  prepareSpawn,
  buildAgentTools,
  buildPrompt,
  collectOutcome,
  type SpawnPrep,
} from "./spawn-helpers.js";

// ─── Helpers (task-flavored ports of the completions loop runtime) ─────

/** Convert PolpoTool[] to a declaration-only AI SDK ToolSet (no execute —
 *  execution is owned by the LoopRunner, not the model stream). */
function toToolDeclarations(polpoTools: PolpoTool[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const pt of polpoTools) {
    toolSet[pt.name] = aiTool({
      description: pt.description,
      inputSchema: jsonSchema(pt.parameters as any),
    });
  }
  return toolSet;
}

async function loadProjectLoop(fs: FileSystem, polpoDir: string, name: string): Promise<ProjectLoopConfig> {
  const path = join(polpoDir, "loops", `${name}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch {
    throw new Error(`Assigned project loop "${name}" was not found at ${path}`);
  }
  return projectLoopConfigSchema.parse(JSON.parse(raw)) as ProjectLoopConfig;
}

/** An agent with no loop configuration at all runs the implicit default
 *  loop — byte-identical to the legacy engine (no overlay, no step header
 *  in the system prompt). */
function isImplicitDefault(agent: AgentConfig, selectionName: string): boolean {
  return selectionName === "default" && !agent.defaultLoop && !agent.loops?.default;
}

// ─── Durable turns ─────────────────────────────────────

/**
 * Serialized-history cap for a single checkpoint write. Post-compaction
 * histories sit well under this; anything larger (e.g. multi-MB tool-call
 * args) is skipped and the previous checkpoint stays the resume point —
 * losing one turn of resumability is better than multi-MB writes per turn.
 */
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;

/**
 * Validate a resume checkpoint against the session about to start. A
 * checkpoint only applies to the same loop session and must carry actual
 * history and a completed-turn index; anything else falls back to a fresh
 * start (never fails the run). Pipeline checkpoints (pipelineName set)
 * never seed a single-session run — their loopName is a pipeline STEP.
 */
function usableResumeState(resume: LoopResumeState | undefined, loopName: string): LoopResumeState | undefined {
  if (!resume) return undefined;
  if (resume.pipelineName) return undefined;
  if (resume.loopName !== loopName) return undefined;
  if (typeof resume.turn !== "number" || resume.turn < 0) return undefined;
  if (!Array.isArray(resume.history) || resume.history.length === 0) return undefined;
  return resume;
}

/**
 * Validate a resume checkpoint against the pipeline about to start: it must
 * belong to the SAME project loop and carry a remaining-steps continuation.
 * Single-session checkpoints (no pipelineName) and human-gate resume states
 * from the completions path are ignored — fresh start, never a failure.
 */
function usablePipelineResumeState(resume: LoopResumeState | undefined, pipelineName: string): LoopResumeState | undefined {
  if (!resume) return undefined;
  if (resume.pipelineName !== pipelineName) return undefined;
  if (!Array.isArray(resume.steps)) return undefined;
  return resume;
}

// ─── Engine ────────────────────────────────────────────

/**
 * Spawn an agent on the loop runtime.
 *
 * Drop-in replacement for spawnEngine: same signature, same AgentHandle
 * contract, same activity/transcript/outcome semantics.
 */
export function spawnLoopEngine(agentConfig: AgentConfig, task: Task, cwd: string, ctx?: SpawnContext): AgentHandle {
  const activity = createActivity();
  const start = Date.now();
  let alive = true;

  const abortController = new AbortController();

  const handle: AgentHandle = {
    agentName: agentConfig.name,
    taskId: task.id,
    startedAt: new Date().toISOString(),
    pid: 0, // No OS process — runs in-process
    activity,
    done: null as any, // set below
    isAlive: () => alive,
    kill: () => {
      abortController.abort();
      alive = false;
    },
  };

  /**
   * Execute one tool call: dispatch, activity tracking, outcome collection,
   * toolUsage harvesting, transcript. Shared by LLM-session tool execution
   * and deterministic pipeline tool steps.
   */
  async function performToolCall(
    pt: PolpoTool | undefined,
    toolCall: LoopToolCall,
  ): Promise<{ llmText: string; isError: boolean }> {
    let result: ToolResult;
    let isError = false;

    if (!pt) {
      isError = true;
      result = {
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        details: {},
      };
    } else {
      try {
        result = await pt.execute(toolCall.id, toolCall.args, abortController.signal);
      } catch (err) {
        isError = true;
        result = {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          details: {},
        };
      }
    }

    activity.lastUpdate = new Date().toISOString();

    // Track file operations from tool details
    const details = result.details;
    if (details?.path) {
      const filePath = details.path as string;
      activity.lastFile = filePath;
      if (toolCall.name === "write" && !activity.filesCreated.includes(filePath)) {
        activity.filesCreated.push(filePath);
      }
      if (toolCall.name === "edit" && !activity.filesEdited.includes(filePath)) {
        activity.filesEdited.push(filePath);
      }
    }

    // Collect outcomes from explicit register_outcome calls
    if (!isError && details) {
      const outcome = collectOutcome(toolCall.name, details);
      if (outcome) {
        if (!handle.outcomes) handle.outcomes = [];
        handle.outcomes.push(outcome);
      }
    }

    // Harvest billable per-tool inference cost (managed image/video via
    // the gateway). Rides back in `details.usage`; the cloud data plane
    // reads activity.toolUsage after the run → Autumn + usage_logs.
    if (!isError && details?.usage && typeof details.usage === "object") {
      const u = details.usage as Record<string, unknown>;
      if (u.generationId || typeof u.marketCostUsd === "number") {
        (activity.toolUsage ??= []).push({
          toolName: toolCall.name,
          generationId: u.generationId as string | undefined,
          marketCostUsd: u.marketCostUsd as number | undefined,
          actualCostUsd: u.actualCostUsd as number | undefined,
          resolvedModel: u.resolvedModel as string | undefined,
          finalProvider: u.finalProvider as string | undefined,
          credentialType: u.credentialType as string | undefined,
        });
      }
    }

    // Emit tool result transcript
    const resultText = result.content
      .map((c: any) => c.text ?? "")
      .join("");
    handle.onTranscript?.({
      type: "tool_result",
      toolId: toolCall.id,
      tool: toolCall.name,
      content: resultText.slice(0, 2000),
      isError,
    });

    // Text returned to the LLM — same rendering as the legacy engine.
    const llmText = result.content
      .map((c) => c.type === "text" ? c.text : `[image: ${c.mimeType}]`)
      .join("\n");

    return { llmText, isError };
  }

  /**
   * Run one LLM loop session (an implicit default loop, a selected agent
   * loop, or one pipeline agent step): fresh conversation seeded with the
   * task prompt, LoopRunner-driven turns, tool execution through
   * performToolCall, history owned here.
   */
  async function runLoopSession(options: {
    sessionAgent: AgentConfig;
    loopName: string;
    loop: LoopConfig;
    contextPrompt?: string;
    /** Durable-turns checkpoint to resume from (single-session paths only). */
    resume?: LoopResumeState;
    /** Durable-turns checkpoint sink — wired to RunStore.updateResumeState by the runner. */
    onCheckpoint?: (state: LoopResumeState) => void | Promise<void>;
  }): Promise<{ lastText: string; accumText: string }> {
    const { sessionAgent, loopName, loop, contextPrompt } = options;
    const resume = usableResumeState(options.resume, loopName);
    const inject = ctx?.inject;

    // Inject path (chat-via-executeRun, F1c): use the completions route's
    // already-resolved model/prompt/tools/messages instead of re-resolving from
    // the AgentConfig — parity by construction. Every branch below is
    // inject-gated so the task path stays byte-identical.
    let model: SpawnPrep["model"];
    let providerOptions: SpawnPrep["providerOptions"];
    let systemPrompt: string;
    let maxTurns: number;
    let toolSet: ToolSet;
    let toolByName = new Map<string, PolpoTool>();
    // Tools value handed to compaction's token estimator (JSON.stringify'd); MUST
    // match the chat path's shape so the compaction trigger point is identical.
    let compactionTools: unknown[];
    const compactionMode: "chat" | "task" = inject?.compactionMode ?? "task";
    if (inject) {
      model = inject.model as unknown as SpawnPrep["model"];
      providerOptions = inject.providerOptions as SpawnPrep["providerOptions"];
      systemPrompt = inject.systemPrompt;
      maxTurns = inject.maxTurns;
      toolSet = inject.toolSet as ToolSet;
      compactionTools = inject.compactionTools;
    } else {
      const prep = prepareSpawn(sessionAgent, cwd, ctx);
      model = prep.model;
      providerOptions = prep.providerOptions;
      systemPrompt = contextPrompt
        ? `${prep.systemPrompt}\n\n${contextPrompt}`
        : prep.systemPrompt;
      maxTurns = loop.maxTurns ?? prep.maxTurns;
      const allPolpoTools = await buildAgentTools(sessionAgent, cwd, prep, ctx);
      toolByName = new Map(allPolpoTools.map((t) => [t.name, t]));
      toolSet = toToolDeclarations(allPolpoTools);
      compactionTools = allPolpoTools.map((t) => ({ description: t.description ?? "" }));
    }

    // Conversation state owned by the host, exactly like the legacy loop.
    // On resume the recorded history (already containing tool-call and
    // tool-result pairs from completed turns) replaces the fresh prompt —
    // side-effects replay from recorded results, they never re-execute.
    let messages: ModelMessage[] = inject
      ? [...(inject.seedMessages as ModelMessage[])]
      : resume
        ? [...(resume.history as ModelMessage[])]
        : [{ role: "user", content: buildPrompt(task) }];
    let lastStepText = "";
    let accumText = resume?.accumText ?? "";

    const summarize: SummarizeFn = async (msgs, compactionPrompt) => {
      const response = await generateText({
        model: model.aiModel,
        system: compactionPrompt,
        messages: msgs as ModelMessage[],
        maxOutputTokens: model.maxTokens,
        abortSignal: abortController.signal,
        providerOptions,
      });
      return response.text;
    };

    // ── LoopRunner model callback: one streamText step per turn ──
    const modelStep = async (): Promise<LoopModelResult> => {
      // Abort between turns mirrors the legacy `if (aborted) break`:
      // report no tool calls so the runner stops cleanly (exit 0).
      if (abortController.signal.aborted) {
        return { text: "", toolCalls: [] };
      }

      // Context compaction — same call, same config, same quirks as the
      // legacy engine (see engine-behavior characterization tests).
      const compactionResult = await compactIfNeeded({
        systemPrompt,
        messages,
        tools: compactionTools as { description: string }[],
        config: {
          contextWindow: model.contextWindow ?? 200_000,
          maxOutputTokens: model.maxTokens ?? 8192,
        },
        summarize,
        mode: compactionMode,
        onCompaction: (event: CompactionEvent) => {
          handle.onTranscript?.({
            type: "compaction",
            phase: event.phase,
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
            tokensReclaimed: event.tokensReclaimed,
            messagesBefore: event.messagesBefore,
            messagesAfter: event.messagesAfter,
            toolOutputsPruned: event.toolOutputsPruned,
            summary: event.summary,
          });
        },
      });
      if (compactionResult.compacted) {
        messages = compactionResult.messages as ModelMessage[];
      }

      let stepUsage: unknown;
      const stream = streamText({
        model: model.aiModel,
        system: systemPrompt,
        messages,
        tools: toolSet,
        ...(inject?.toolChoice ? { toolChoice: inject.toolChoice as any } : {}),
        maxOutputTokens: model.maxTokens,
        abortSignal: abortController.signal,
        providerOptions,
        onStepFinish: async ({ usage }) => {
          if (usage) {
            activity.totalTokens += (usage.totalTokens ?? 0);
            stepUsage = usage;
          }
          activity.lastUpdate = new Date().toISOString();
        },
      });

      let stepText = "";
      const toolCalls: LoopToolCall[] = [];
      for await (const part of stream.fullStream) {
        switch (part.type) {
          case "reasoning-delta": {
            // Chat parity (F1c): surface model reasoning as a thinking delta.
            if (inject) { try { ctx?.onDelta?.({ text: part.text, kind: "reasoning" }); } catch { /* subscriber can't sink the run */ } }
            break;
          }
          case "text-delta": {
            stepText += part.text;
            // F1b: token-level streaming sink (separate from onTranscript, which
            // stays turn-granularity for persistence). Best-effort.
            try { ctx?.onDelta?.({ text: part.text }); } catch { /* a delta subscriber can't sink the run */ }
            break;
          }
          case "tool-input-start": {
            // Chat parity (F1c): "preparing" tool state before args stream in.
            if (inject) handle.onTranscript?.({ type: "tool_input_start", toolId: part.id, tool: part.toolName });
            break;
          }
          case "tool-call": {
            activity.toolCalls++;
            activity.lastTool = part.toolName;
            activity.lastUpdate = new Date().toISOString();
            handle.onTranscript?.({
              type: "tool_use",
              tool: part.toolName,
              toolId: part.toolCallId,
              input: part.input,
            });
            // Chat parity (F1c): a client-side tool ends the server loop and is
            // returned to the caller to execute — never dispatched here. Not
            // pushing it to toolCalls ⇒ the turn ends with no executable tools.
            if (inject && inject.clientSideToolNames.has(part.toolName)) {
              handle.onTranscript?.({
                type: "client_tool_call",
                toolId: part.toolCallId,
                tool: part.toolName,
                input: part.input,
              });
              break;
            }
            toolCalls.push({
              id: part.toolCallId,
              name: part.toolName,
              args: (part.input ?? {}) as Record<string, unknown>,
            });
            break;
          }
          case "error": {
            handle.onTranscript?.({
              type: "error",
              message: part.error instanceof Error ? part.error.message : String(part.error),
            });
            break;
          }
        }
      }

      if (stepText) {
        activity.summary = stepText.slice(0, 200);
        handle.onTranscript?.({ type: "assistant", text: stepText });
        accumText += stepText;
      }
      lastStepText = stepText;

      // On stream errors, `stream.text` throws the AI SDK "No output
      // generated" error — awaiting it here preserves the legacy error
      // path (exitCode 1 + that message in stderr).
      if (toolCalls.length === 0) {
        lastStepText = await stream.text;
      }

      // Append the assistant message (with its tool-call parts) to history.
      const responseMessages = (await stream.response).messages;
      messages.push(...responseMessages);

      // Chat parity (F1c): surface per-turn usage + provider metadata so the
      // driver can accumulate them for onCompletionFinished, matching chat.
      if (inject) {
        handle.onTranscript?.({
          type: "usage",
          usage: stepUsage,
          providerMetadata: await Promise.resolve(stream.providerMetadata).catch(() => undefined),
        });
      }

      return { text: stepText, toolCalls, usage: stepUsage };
    };

    // ── LoopRunner tool executor: dispatch + history append ──
    const executeTool = async (toolCall: LoopToolCall): Promise<string> => {
      let llmText: string;
      let isError: boolean;
      if (inject) {
        // Chat parity (F1c): dispatch via the route's own executor and emit the
        // FULL result (no 2000-char task truncation). Provider-executed tools
        // are recorded upstream (tool_use) and skipped here — their result is
        // already in the stream's response messages.
        if (inject.providerToolNames.has(toolCall.name)) return "";
        llmText = await inject.executor(toolCall.name, toolCall.args);
        isError = llmText.startsWith("Error:");
        handle.onTranscript?.({ type: "tool_result", toolId: toolCall.id, tool: toolCall.name, content: llmText, isError });
      } else {
        ({ llmText, isError } = await performToolCall(toolByName.get(toolCall.name), toolCall));
      }

      // Append the tool result to conversation history so the next model
      // step sees it (the model stream no longer auto-executes tools).
      messages.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          output: isError
            ? { type: "error-text" as const, value: llmText }
            : { type: "text" as const, value: llmText },
        }],
      });

      return llmText;
    };

    // ── Durable turns: one checkpoint write per completed turn ──
    // Emitted at end-of-turn, so `messages` is post-tool-execution and
    // post-compaction by construction (compaction rewrites `messages` at
    // the START of a model step). The JSON round-trip here pins store
    // fidelity: what a resumed run sees is exactly what survives JSON.
    const checkpointCreatedAt = resume?.createdAt ?? new Date().toISOString();
    const onTurnCheckpoint = options.onCheckpoint
      ? async ({ turn }: { turn: number }) => {
          const serialized = JSON.stringify(messages);
          if (serialized.length > MAX_CHECKPOINT_BYTES) return; // keep the previous checkpoint
          await options.onCheckpoint!({
            context: {},
            steps: [],
            loopName,
            turn,
            history: JSON.parse(serialized) as unknown[],
            accumText,
            createdAt: checkpointCreatedAt,
            updatedAt: new Date().toISOString(),
          });
        }
      : undefined;

    const runner = new LoopRunner();
    await runner.run({
      agent: sessionAgent,
      loop: { ...loop, name: loopName },
      maxTurns,
      startTurn: resume ? resume.turn! + 1 : 0,
      model: modelStep,
      executeTool,
      onTurnCheckpoint,
    });

    return { lastText: lastStepText, accumText };
  }

  /**
   * Run a project loop graph (.polpo/loops/<name>.json) through the
   * PipelineExecutor: agent steps are independent LLM sessions that share
   * the context bag; tool steps execute deterministically with no LLM turn.
   *
   * Durable pipelines (Phase B): checkpoints at two granularities, one
   * resume slot, one unified format (LoopResumeState, additive):
   * (a) at every completed step boundary the executor emits the composed
   *     remaining-steps continuation + context bag (steps already done are
   *     NOT in it — their outputs replay from the bag, Temporal semantics);
   * (b) inside an in-flight agent step, the Phase A per-turn checkpoints
   *     are wrapped with the pipeline position (steps[0] = the step itself)
   *     so a crash at turn K resumes the SAME step at turn K+1.
   * switch choices are pinned at selection (never re-evaluated on resume),
   * while continuations carry completedIterations (absolute budget).
   * Deliberate v1 cut: no checkpoints inside parallel branches — a crash
   * mid-parallel resumes from before the block and re-executes every branch.
   */
  async function runPipeline(projectLoop: ProjectLoopConfig): Promise<string> {
    const normalized = normalizeProjectLoop(projectLoop);
    if (!normalized.pipeline) {
      throw new Error(`Loop "${projectLoop.name}" does not define a pipeline`);
    }

    // Tool steps execute against the BASE agent's tool set.
    let baseToolsPromise: Promise<Map<string, PolpoTool>> | undefined;
    const getBaseTools = () => {
      baseToolsPromise ??= (async () => {
        const prep = prepareSpawn(agentConfig, cwd, ctx);
        const tools = await buildAgentTools(agentConfig, cwd, prep, ctx);
        return new Map(tools.map((t) => [t.name, t]));
      })();
      return baseToolsPromise;
    };

    // A usable checkpoint replaces the pipeline's step list with the
    // recorded continuation; anything else (absent, other pipeline, old
    // gate/session formats) starts fresh.
    const resume = usablePipelineResumeState(ctx?.resumeState, projectLoop.name);
    // One-shot in-flight session resume: only the FIRST agent step the
    // resumed pipeline reaches may consume the turn-level fields (it is
    // steps[0] of the recorded continuation); runLoopSession re-validates
    // the loop name before seeding history.
    let pendingSessionResume: LoopResumeState | undefined =
      resume && typeof resume.turn === "number" && Array.isArray(resume.history) && resume.history.length > 0
        ? { ...resume, pipelineName: undefined }
        : undefined;

    // Composed checkpoint sink → ctx.onTurnCheckpoint (the runner wires it
    // to RunStore.updateResumeState). Same cap and JSON round-trip rules as
    // the single-session path: an oversized state keeps the previous
    // checkpoint, a JSON pass pins store fidelity.
    const checkpointCreatedAt = resume?.createdAt ?? new Date().toISOString();
    const sink = ctx?.onTurnCheckpoint;
    const writeCheckpoint = sink
      ? async (state: LoopResumeState): Promise<void> => {
          const serialized = JSON.stringify(state);
          if (serialized.length > MAX_CHECKPOINT_BYTES) return; // keep the previous checkpoint
          await sink(JSON.parse(serialized) as LoopResumeState);
        }
      : undefined;
    /** Fields every composed checkpoint carries, boundary or in-flight. */
    const composedBase = () => ({
      pipelineName: projectLoop.name,
      approvedGates: resume?.approvedGates,
      createdAt: checkpointCreatedAt,
      updatedAt: new Date().toISOString(),
    });

    let finalText = "";
    let toolStepSeq = 0;
    const executor = new PipelineExecutor();

    const result = await executor.execute({
      name: projectLoop.name,
      pipeline: resume ? { ...normalized.pipeline, steps: resume.steps } : normalized.pipeline,
      loops: normalized.loops,
      context: resume ? { ...resume.context } : {},
      projectHooks: projectLoop.hooks,
      projectPermissions: projectLoop.permissions,
      projectPolicies: projectLoop.policies,
      resume: resume
        ? { previousNode: resume.previousNode, approvedGates: resume.approvedGates }
        : undefined,
      // (a) Step-boundary checkpoint: pure pipeline position, no session.
      onCheckpoint: writeCheckpoint
        ? async (checkpoint) => {
            await writeCheckpoint({
              context: checkpoint.context,
              steps: checkpoint.steps,
              previousNode: checkpoint.previousNode,
              ...composedBase(),
            });
          }
        : undefined,
      onTrace: async (event) => {
        handle.onTranscript?.({ type: "loop_trace", trace: event });
      },
      runLoop: async (name, loop, context, position) => {
        const sessionResume = pendingSessionResume;
        pendingSessionResume = undefined;
        const stepAgent = buildLoopStepAgent(agentConfig, name, loop);
        const session = await runLoopSession({
          sessionAgent: stepAgent,
          loopName: name,
          loop,
          contextPrompt: loopContextPrompt(name, context),
          resume: sessionResume,
          // (b) Per-turn checkpoint INSIDE this agent step: the session
          // state wrapped with the pipeline position. No position = the
          // step runs inside a parallel branch, checkpointing suppressed.
          onCheckpoint: writeCheckpoint && position
            ? async (state) => {
                await writeCheckpoint({
                  ...state,
                  context: { ...context },
                  steps: position.steps,
                  previousNode: position.previousNode,
                  ...composedBase(),
                });
              }
            : undefined,
        });
        if (session.lastText) finalText = session.lastText;
        return { output: maybeParseJson(session.accumText || session.lastText) };
      },
      runTool: async (name, input) => {
        const tools = await getBaseTools();
        const args = normalizeToolInput(input);
        const toolCall: LoopToolCall = { id: `loop-tool-${task.id}-${toolStepSeq++}`, name, args };
        handle.onTranscript?.({ type: "tool_use", tool: name, toolId: toolCall.id, input: args });
        activity.toolCalls++;
        activity.lastTool = name;
        const { llmText, isError } = await performToolCall(tools.get(name), toolCall);
        if (isError) throw new Error(llmText);
        return { output: maybeParseJson(llmText) };
      },
      handleHuman: async (name) => {
        throw new Error(`Loop human step "${name}" cannot run inside task runs yet`);
      },
    });

    return finalText || JSON.stringify(result.context, null, 2);
  }

  handle.done = (async (): Promise<TaskResult> => {
    // Extended-tool detection for browser session cleanup in `finally` —
    // mirrors prepareSpawn's category detection without requiring prep to
    // have succeeded.
    const hasExtendedTools = agentConfig.allowedTools?.some((t) => {
      const lc = t.toLowerCase();
      return lc.startsWith("browser_") || lc.startsWith("email_")
        || lc.startsWith("image_") || lc.startsWith("video_") || lc.startsWith("audio_")
        || lc.startsWith("excel_") || lc.startsWith("pdf_") || lc.startsWith("docx_")
        || lc.startsWith("search_");
    }) ?? false;

    try {
      // Chat-via-executeRun (F1c): a chat run has no loop selection/graph — it
      // is a single default turn-loop over the injected conversation. Short-
      // circuit the loop-selection machinery entirely.
      if (ctx?.inject) {
        const session = await runLoopSession({
          sessionAgent: agentConfig,
          loopName: "default",
          loop: { maxTurns: ctx.inject.maxTurns },
        });
        alive = false;
        return { exitCode: 0, stdout: session.lastText, stderr: "", duration: Date.now() - start };
      }
      const selection = resolveLoopSelection(agentConfig);
      const assigned = agentConfig.assignedLoops ?? [];

      let stdout: string;
      if (assigned.includes(selection.name)) {
        // Project loop graph mode — polpoDir/fs come straight from ctx
        // (the base agent's model may never be used; steps resolve their own).
        if (!ctx?.polpoDir) {
          throw new Error("spawnEngine: ctx.polpoDir is required (cannot derive .polpo from cwd when settings.workDir is set)");
        }
        const fs = ctx.fs ?? new NodeFileSystem();
        const projectLoop = await loadProjectLoop(fs, ctx.polpoDir, selection.name);
        stdout = await runPipeline(projectLoop);
      } else if (isImplicitDefault(agentConfig, selection.name)) {
        // Parity path: agents without loop config behave exactly like the
        // legacy engine (no overlay, no step header).
        const session = await runLoopSession({
          sessionAgent: agentConfig,
          loopName: "default",
          loop: { maxTurns: agentConfig.maxTurns },
          resume: ctx?.resumeState,
          onCheckpoint: ctx?.onTurnCheckpoint,
        });
        stdout = session.lastText;
      } else {
        // Selected single loop (defaultLoop or inline loops.default):
        // apply the loop's overlays, same semantics as completions.
        const stepAgent = buildLoopStepAgent(agentConfig, selection.name, selection.loop);
        const session = await runLoopSession({
          sessionAgent: stepAgent,
          loopName: selection.name,
          loop: selection.loop,
          resume: ctx?.resumeState,
          onCheckpoint: ctx?.onTurnCheckpoint,
        });
        stdout = session.lastText;
      }

      alive = false;
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        duration: Date.now() - start,
      };
    } catch (err) {
      alive = false;
      const msg = err instanceof Error ? err.message : String(err);
      handle.onTranscript?.({ type: "error", message: msg });
      return {
        exitCode: 1,
        stdout: "",
        stderr: msg,
        duration: Date.now() - start,
      };
    } finally {
      // Close agent-browser session (profile data auto-persisted by --profile).
      // Chat (inject) keeps its session — the server driver owns cleanup via
      // onResponseFinished, matching the inline chat handler.
      if (hasExtendedTools && !ctx?.inject) {
        await cleanupAgentBrowserSession(agentConfig.name).catch(() => {});
      }
    }
  })();

  return handle;
}
