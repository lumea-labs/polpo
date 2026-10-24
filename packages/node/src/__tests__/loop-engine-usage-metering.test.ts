import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonSchema } from "ai";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { AgentConfig, Task } from "@polpo-ai/core/types";
import { spawnLoopEngine } from "../adapters/loop-engine.js";

let root: string;
let cwd: string;
let polpoDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "polpo-usage-metering-"));
  cwd = join(root, "work");
  polpoDir = join(root, ".polpo");
  await mkdir(cwd, { recursive: true });
  await mkdir(polpoDir, { recursive: true });
});

afterAll(async () => { await rm(root, { recursive: true, force: true }); });

const usage = {
  inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: undefined, reasoning: undefined },
};

function gateway(generationId: string) {
  return { gateway: { generationId, marketCost: "0.01" } };
}

function agent(): AgentConfig { return { name: "metered", role: "assistant", maxTurns: 5 }; }
function task(): Task {
  const now = new Date().toISOString();
  return {
    id: "metered-task", title: "Metered", description: "Look it up", state: "in_progress",
    expectations: [], createdAt: now, updatedAt: now, assignedTo: "metered",
  } as Task;
}

describe("loop-engine usage metering", () => {
  test("run-backed chat reports one usage entry per billed provider call", async () => {
    let turn = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        turn += 1;
        const generationId = `gen_${turn}`;
        if (turn < 3) {
          return { stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call_${turn}`, toolName: "lookup", input: JSON.stringify({ q: generationId }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage, providerMetadata: gateway(generationId) },
          ] as any[]) };
        }
        return { stream: convertArrayToReadableStream([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "done" },
          { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage, providerMetadata: gateway(generationId) },
        ] as any[]) };
      },
    });
    const transcript: Record<string, any>[] = [];

    const result = await spawnLoopEngine(agent(), task(), cwd, {
      polpoDir,
      onTranscript: (entry) => transcript.push(entry as Record<string, any>),
      inject: {
        agent: agent(),
        model: { aiModel: model, contextWindow: 200_000, maxTokens: 8192 } as any,
        systemPrompt: "Use lookup twice, then answer.",
        maxTurns: 5,
        seedMessages: [{ role: "user", content: "Look it up" }],
        toolSet: {
          lookup: {
            description: "Look something up",
            inputSchema: jsonSchema({ type: "object", properties: { q: { type: "string" } }, required: ["q"] }),
          },
        },
        executor: vi.fn(async () => "found"),
        clientSideToolNames: new Set(),
        providerToolNames: new Set(),
        compactionTools: [],
        compactionMode: "chat",
      },
    }).done;

    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const usageEntries = transcript.filter((entry) => entry.type === "usage");
    expect(usageEntries.map((entry) => [entry.phase, entry.status, entry.providerMetadata?.gateway?.generationId])).toEqual([
      ["operational", undefined, "gen_1"],
      ["operational", undefined, "gen_2"],
      ["operational", undefined, "gen_3"],
    ]);
    const cents = usageEntries.reduce((sum, entry) => sum + Math.round(Number(entry.providerMetadata.gateway.marketCost) * 100), 0);
    expect(cents / 100).toBe(0.03);
  });
});
