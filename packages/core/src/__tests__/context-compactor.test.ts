import { describe, it, expect, vi } from "vitest";
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldCompact,
  pruneToolOutputs,
  compactIfNeeded,
  getCompactionPrompt,
  PRUNE_PROTECT,
  PRUNE_MINIMUM,
  TRIGGER_THRESHOLD,
  TARGET_AFTER,
  type CompactionConfig,
  type CompactionInput,
  type SummarizeFn,
} from "../context-compactor.js";

// ── estimateTokens ──────────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it('estimates "hello" as ~1-2 tokens', () => {
    // "hello" = 5 chars => 5/4 = 1.25 => Math.round => 1
    expect(estimateTokens("hello")).toBe(1);
  });

  it("estimates longer text proportionally", () => {
    const text = "a".repeat(400);
    expect(estimateTokens(text)).toBe(100);
  });
});

// ── estimateMessagesTokens ──────────────────────────────────────────────

describe("estimateMessagesTokens", () => {
  it("estimates string content messages", () => {
    const messages = [
      { role: "user", content: "Hello, how are you?" },
      { role: "assistant", content: "I am fine." },
    ];
    const tokens = estimateMessagesTokens(messages);
    // Each message: 4 (overhead) + text tokens
    // "Hello, how are you?" = 19 chars => ~5 tokens => total 9
    // "I am fine." = 10 chars => ~3 tokens => total 7
    // Sum = 16
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(
      4 + estimateTokens("Hello, how are you?") +
      4 + estimateTokens("I am fine."),
    );
  });

  it("estimates tool call messages", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_1",
            name: "readFile",
            arguments: { path: "/tmp/test.txt" },
          },
        ],
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(4); // more than just overhead
  });

  it("estimates tool result messages", () => {
    const messages = [
      {
        role: "toolResult",
        content: [
          { type: "text", text: "File contents here: hello world" },
        ],
      },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBe(4 + estimateTokens("File contents here: hello world"));
  });

  it("handles empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

// ── shouldCompact ───────────────────────────────────────────────────────

describe("shouldCompact", () => {
  const config: CompactionConfig = {
    contextWindow: 100_000,
    maxOutputTokens: 4_000,
  };

  it("returns false when below threshold", () => {
    // usable = 96000, threshold = 81600 (85%)
    expect(shouldCompact(config, 50_000)).toBe(false);
  });

  it("returns true when above threshold", () => {
    // usable = 96000, threshold = 81600 (85%)
    expect(shouldCompact(config, 85_000)).toBe(true);
  });

  it("returns true at exact threshold", () => {
    const usable = config.contextWindow - config.maxOutputTokens;
    const threshold = usable * TRIGGER_THRESHOLD;
    expect(shouldCompact(config, threshold)).toBe(true);
  });

  it("returns false when disabled", () => {
    expect(shouldCompact({ ...config, disabled: true }, 999_999)).toBe(false);
  });

  it("uses custom triggerThreshold", () => {
    const custom: CompactionConfig = {
      ...config,
      triggerThreshold: 0.5,
    };
    // usable = 96000, threshold = 48000 (50%)
    expect(shouldCompact(custom, 50_000)).toBe(true);
    expect(shouldCompact(custom, 40_000)).toBe(false);
  });
});

// ── pruneToolOutputs ────────────────────────────────────────────────────

describe("pruneToolOutputs", () => {
  const config: CompactionConfig = {
    contextWindow: 200_000,
    maxOutputTokens: 4_000,
  };

  it("returns unchanged messages when no tool outputs", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = pruneToolOutputs(messages, config);
    expect(result).toEqual(messages);
  });

  it("protects recent tool outputs", () => {
    // Create a single tool result that fits within PRUNE_PROTECT
    const smallOutput = "x".repeat(100); // ~25 tokens, well within 40K
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: smallOutput }],
        toolName: "readFile",
      },
    ];
    const result = pruneToolOutputs(messages, config);
    // Should be unchanged since it's within the protected window
    expect(result[0].content[0].text).toBe(smallOutput);
  });

  it("prunes old outputs beyond the protection window", () => {
    // Create outputs that exceed PRUNE_PROTECT + PRUNE_MINIMUM
    const bigOutput = "x".repeat(PRUNE_PROTECT * 4 + PRUNE_MINIMUM * 4 + 100);
    // Oldest message — should be pruned
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: bigOutput }],
        toolName: "oldTool",
      },
      // Recent message — protected
      {
        role: "toolResult",
        content: [{ type: "text", text: "y".repeat(PRUNE_PROTECT * 4) }],
        toolName: "recentTool",
      },
    ];

    const result = pruneToolOutputs(messages, config);
    // Old output should be pruned
    expect(result[0].content[0].text).toContain("[Output pruned");
    expect(result[0].content[0].text).toContain("Tool: oldTool");
    // Recent output should be preserved
    expect(result[1].content[0].text).toBe("y".repeat(PRUNE_PROTECT * 4));
  });

  it("does not prune if total prunable is under minimum", () => {
    // Two small outputs — neither exceeds minimum for pruning
    const smallOutput = "x".repeat(100);
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: smallOutput }],
        toolName: "tool1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: smallOutput }],
        toolName: "tool2",
      },
    ];

    const result = pruneToolOutputs(messages, config);
    // Both should be unchanged
    expect(result[0].content[0].text).toBe(smallOutput);
    expect(result[1].content[0].text).toBe(smallOutput);
  });

  it("does not mutate original messages", () => {
    const bigOutput = "x".repeat((PRUNE_PROTECT + PRUNE_MINIMUM) * 4 + 400);
    const messages = [
      {
        role: "toolResult",
        content: [{ type: "text", text: bigOutput }],
        toolName: "tool1",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "y".repeat(PRUNE_PROTECT * 4) }],
        toolName: "tool2",
      },
    ];

    const originalFirstText = messages[0].content[0].text;
    pruneToolOutputs(messages, config);
    // Original should be untouched
    expect(messages[0].content[0].text).toBe(originalFirstText);
  });
});

// ── compactIfNeeded ─────────────────────────────────────────────────────

describe("compactIfNeeded", () => {
  const smallConfig: CompactionConfig = {
    contextWindow: 1000,
    maxOutputTokens: 100,
    // usable = 900, trigger at 765 (85%), target after = 450 (50%)
  };

  const mockSummarize: SummarizeFn = vi.fn(async () => "Summary of previous context.");

  function makeInput(overrides: Partial<CompactionInput> = {}): CompactionInput {
    return {
      systemPrompt: "You are a helpful assistant.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ],
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
      ...overrides,
    };
  }

  it("returns unchanged when under threshold", async () => {
    const input = makeInput({
      config: {
        contextWindow: 1_000_000,
        maxOutputTokens: 4_000,
      },
    });

    const result = await compactIfNeeded(input);
    expect(result.compacted).toBe(false);
    expect(result.pruned).toBe(false);
    expect(result.messages).toBe(input.messages); // same reference
    expect(result.tokensBefore).toBe(result.tokensAfter);
  });

  it("returns unchanged when disabled", async () => {
    const input = makeInput({
      config: { ...smallConfig, disabled: true },
    });
    // Even with a tiny context window, disabled means no compaction
    const result = await compactIfNeeded(input);
    expect(result.compacted).toBe(false);
  });

  it("prunes sufficiently without calling summarize", async () => {
    const summarize = vi.fn(async () => "summary");

    // Build messages that push over threshold due to large tool outputs,
    // where pruning alone is enough to get under target.
    //
    // The pruning logic walks backwards (most recent first) and protects
    // recent tool outputs up to pruneProtect tokens. Once that budget is
    // filled, everything older is prunable.
    //
    // Config: contextWindow=2000, maxOutputTokens=100 => usable=1900
    // trigger = 1615 (85%), target = 950 (50%)
    const config: CompactionConfig = {
      contextWindow: 2000,
      maxOutputTokens: 100,
      pruneProtect: 200, // protect 200 tokens of recent tool output
      pruneMinimum: 50,  // prune if at least 50 tokens reclaimable
    };

    // System prompt "You are a helpful assistant." = 28 chars = 7 tokens
    // Msg "do something" = 12 chars = 3 + 4 overhead = 7
    // Old tool result "x"*6000 = 6000 chars = 1500 + 4 overhead = 1504 tokens
    // Recent tool result "y"*1000 = 1000 chars = 250 + 4 overhead = 254 tokens
    //   (250 > pruneProtect=200, so this alone fills the protect budget)
    // Msg "done" = 4 chars = 1 + 4 overhead = 5
    // Total = 7 + 7 + 1504 + 254 + 5 = 1777, well over trigger of 1615
    //
    // After pruning: old tool result becomes short placeholder (~15 tokens + overhead)
    // Total after = 7 + 7 + ~19 + 254 + 5 = ~292, under target of 950
    const messages = [
      { role: "user", content: "do something" },
      {
        role: "toolResult",
        content: [{ type: "text", text: "x".repeat(6000) }],
        toolName: "bigTool",
      },
      {
        role: "toolResult",
        content: [{ type: "text", text: "y".repeat(1000) }],
        toolName: "recentTool",
      },
      { role: "assistant", content: "done" },
    ];

    const input = makeInput({ messages, config, summarize });
    const result = await compactIfNeeded(input);

    expect(result.pruned).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // Summarize should NOT have been called since pruning was sufficient
    expect(summarize).not.toHaveBeenCalled();
    // The old tool result should contain the placeholder
    const prunedToolResult = result.messages[1];
    expect(prunedToolResult.content[0].text).toContain("[Output pruned");
  });

  it("calls summarize when pruning is insufficient", async () => {
    const summarize = vi.fn(async () => "Brief summary.");

    // Very small context window forces summarization
    const config: CompactionConfig = {
      contextWindow: 200,
      maxOutputTokens: 10,
      // usable = 190, trigger = 161.5, target = 95
      pruneProtect: 0,
      pruneMinimum: 0,
    };

    // Generate enough text messages to exceed threshold
    // Each message ~4 overhead + text tokens
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "user", content: `Question number ${i}: ${"context ".repeat(10)}` });
      messages.push({ role: "assistant", content: `Answer number ${i}: ${"response ".repeat(10)}` });
    }

    const input = makeInput({ messages, config, summarize });
    const result = await compactIfNeeded(input);

    expect(result.compacted).toBe(true);
    expect(summarize).toHaveBeenCalled();
    expect(result.summary).toBe("Brief summary.");
    // First message should be the summary injection
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[Previous context summary]");
    expect(result.messages[0].content).toContain("Brief summary.");
    expect(result.messages[0].content).toContain("[End summary — continue from here]");
  });
});

// ── getCompactionPrompt ─────────────────────────────────────────────────

describe("getCompactionPrompt", () => {
  it("returns task prompt for task mode", () => {
    const prompt = getCompactionPrompt("task");
    expect(prompt).toContain("Summarize the conversation for handoff");
    expect(prompt).toContain("### Goal");
    expect(prompt).toContain("### Progress");
    expect(prompt).toContain("### Files Modified");
    expect(prompt).toContain("### Next Steps");
  });

  it("returns chat prompt for chat mode", () => {
    const prompt = getCompactionPrompt("chat");
    expect(prompt).toContain("Summarize the conversation to preserve context");
    expect(prompt).toContain("user preferences");
  });
});

// ── Constants exported correctly ────────────────────────────────────────

describe("constants", () => {
  it("exports expected values", () => {
    expect(PRUNE_PROTECT).toBe(40_000);
    expect(PRUNE_MINIMUM).toBe(20_000);
    expect(TRIGGER_THRESHOLD).toBe(0.85);
    expect(TARGET_AFTER).toBe(0.50);
  });
});

// ── AI SDK v6 message shapes ────────────────────────────────────────────
//
// The runtime (loop-engine tasks, completions) speaks AI SDK v6
// ModelMessages: assistant tool calls are `{type:"tool-call", toolCallId,
// toolName, input}` parts, tool results are `role:"tool"` messages with
// `{type:"tool-result", toolCallId, toolName, output:{type,value}}` parts.
// Estimation and pruning must see them, or compaction never fires on
// tool-heavy tasks (the historical bug pinned in engine-behavior.test.ts).

function v6ToolMsg(id: string, toolName: string, value: string) {
  return {
    role: "tool",
    content: [{
      type: "tool-result",
      toolCallId: id,
      toolName,
      output: { type: "text" as const, value },
    }],
  };
}

describe("AI SDK v6 shapes — estimation", () => {
  it("counts assistant tool-call input tokens", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "bash", input: { command: "x".repeat(4000) } }],
      },
    ]);
    expect(tokens).toBeGreaterThan(900);
  });

  it("counts tool-result output tokens", () => {
    const tokens = estimateMessagesTokens([v6ToolMsg("c1", "bash", "y".repeat(8000))]);
    expect(tokens).toBeGreaterThan(1900);
  });

  it("counts non-text tool-result outputs by stringification", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", output: { type: "json", value: { rows: "z".repeat(2000) } } }],
      },
    ]);
    expect(tokens).toBeGreaterThan(400);
  });
});

describe("AI SDK v6 shapes — pruning", () => {
  const config: CompactionConfig = {
    contextWindow: 200_000,
    maxOutputTokens: 4_000,
    pruneProtect: 500,
    pruneMinimum: 500,
  };

  it("prunes old v6 tool results and preserves the message envelope", () => {
    const messages = [
      v6ToolMsg("c1", "oldTool", "x".repeat(8000)),    // ~2000 tokens, prunable
      // ~600 tokens: fills the 500-token protect window on its own, so the
      // older entry above falls outside it (the walk protects entries until
      // the cumulative total reaches pruneProtect).
      v6ToolMsg("c2", "recentTool", "y".repeat(2400)),
    ];
    const result = pruneToolOutputs(messages, config);

    const pruned = result[0].content[0];
    expect(result[0].role).toBe("tool");
    expect(pruned.type).toBe("tool-result");
    expect(pruned.toolCallId).toBe("c1"); // envelope intact for the provider
    expect(pruned.output.type).toBe("text");
    expect(pruned.output.value).toContain("[Output pruned");
    expect(pruned.output.value).toContain("Tool: oldTool");

    // Recent output protected
    expect(result[1].content[0].output.value).toBe("y".repeat(2400));
    // Original untouched
    expect(messages[0].content[0].output.value).toBe("x".repeat(8000));
  });

  it("compactIfNeeded resolves tool-heavy v6 history with the prune phase", async () => {
    const summarize = vi.fn(async () => "SUMMARY");
    const events: Array<{ phase: string; toolOutputsPruned: number }> = [];

    const result = await compactIfNeeded({
      systemPrompt: "",
      messages: [
        { role: "user", content: "run the pipeline" },
        v6ToolMsg("c1", "bash", "a".repeat(8000)), // ~2000 tokens
        v6ToolMsg("c2", "bash", "b".repeat(8000)), // ~2000 tokens
        v6ToolMsg("c3", "bash", "c".repeat(4000)), // ~1000 tokens, protected
      ],
      tools: [],
      config: {
        contextWindow: 4000,
        maxOutputTokens: 500,
        pruneProtect: 500,
        pruneMinimum: 500,
      },
      summarize,
      mode: "task",
      onCompaction: (e) => events.push({ phase: e.phase, toolOutputsPruned: e.toolOutputsPruned ?? 0 }),
    });

    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    // Prune alone reclaims enough — no LLM summarization needed
    expect(summarize).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("prune");
    expect(events[0].toolOutputsPruned).toBe(2);
  });
});
