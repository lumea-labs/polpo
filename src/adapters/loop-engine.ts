/**
 * Loop-engine — the task runtime driven by the core loop system.
 *
 * Same external contract as spawnEngine (AgentHandle in, TaskResult out),
 * but the agentic loop is @polpo-ai/core's LoopRunner instead of a manual
 * for-loop: the model callback does one streamText step (with compaction),
 * and tool execution is dispatched by the LoopRunner through its
 * tool:before/tool:after hook points — which is what makes per-tool
 * gating, tracing, and (later) pipelines available to tasks.
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

import type { AgentConfig, Task, TaskResult } from "../core/types.js";
import type { AgentHandle, SpawnContext } from "../core/adapter.js";
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
  compactIfNeeded,
  type SummarizeFn,
  type CompactionEvent,
  type LoopModelResult,
  type PolpoTool,
  type ToolResult,
} from "@polpo-ai/core";
import type { LoopToolCall } from "@polpo-ai/core";
import {
  createActivity,
  prepareSpawn,
  buildAgentTools,
  buildPrompt,
  collectOutcome,
} from "./engine.js";

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

  const prep = prepareSpawn(agentConfig, cwd, ctx);
  const { model, systemPrompt, providerOptions, hasExtendedTools, maxTurns } = prep;

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

  handle.done = (async (): Promise<TaskResult> => {
    try {
      const allPolpoTools = await buildAgentTools(agentConfig, cwd, prep, ctx);
      const toolByName = new Map(allPolpoTools.map((t) => [t.name, t]));
      const toolSet = toToolDeclarations(allPolpoTools);
      const toolDescriptions = allPolpoTools.map((t) => ({ description: t.description ?? "" }));

      // Conversation state owned by the host, exactly like the legacy loop.
      let messages: ModelMessage[] = [{ role: "user", content: buildPrompt(task) }];
      let lastStepText = "";

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
          tools: toolDescriptions,
          config: {
            contextWindow: model.contextWindow ?? 200_000,
            maxOutputTokens: model.maxTokens ?? 8192,
          },
          summarize,
          mode: "task",
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
            case "text-delta": {
              stepText += part.text;
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

        return { text: stepText, toolCalls, usage: stepUsage };
      };

      // ── LoopRunner tool executor: dispatch + activity + history ──
      const executeTool = async (toolCall: LoopToolCall): Promise<string> => {
        const pt = toolByName.get(toolCall.name);
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

      const runner = new LoopRunner();
      await runner.run({
        agent: agentConfig,
        loop: { name: "default", maxTurns },
        maxTurns,
        model: modelStep,
        executeTool,
      });

      alive = false;
      return {
        exitCode: 0,
        stdout: lastStepText,
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
      // Close agent-browser session (profile data auto-persisted by --profile)
      if (hasExtendedTools) {
        await cleanupAgentBrowserSession(agentConfig.name).catch(() => {});
      }
    }
  })();

  return handle;
}
