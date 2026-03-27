/**
 * Context Compaction E2E test — verifies compaction triggers and works
 * with realistic message sequences that exceed the context window.
 *
 * Uses a tiny contextWindow (2000 tokens) so we can trigger compaction
 * with just a few messages instead of needing 200K tokens.
 */
import { describe, it, expect, vi } from "vitest";
import {
  compactIfNeeded,
  pruneToolOutputs,
  estimateTokens,
  estimateMessagesTokens,
  type CompactionConfig,
  type SummarizeFn,
} from "../context-compactor.js";

// ── Helpers ──────────────────────────────────────────────

/** Create a user message */
function userMsg(text: string) {
  return { role: "user", content: text, timestamp: Date.now() };
}

/** Create an assistant text message */
function assistantTextMsg(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

/** Create an assistant tool call message */
function assistantToolCallMsg(toolName: string, args: Record<string, unknown>) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name: toolName, arguments: args }],
    timestamp: Date.now(),
  };
}

/** Create a tool result message with large output */
function toolResultMsg(toolCallId: string, toolName: string, output: string) {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: output }],
    timestamp: Date.now(),
  };
}

/** Generate a large string of N tokens (approx) */
function generateLargeText(targetTokens: number): string {
  // 4 chars per token
  return "x".repeat(targetTokens * 4);
}

/** Build a conversation with many tool calls that fills up context */
function buildLongConversation(numToolCalls: number, outputTokensEach: number) {
  const messages: any[] = [
    userMsg("Fix the authentication bug in the login page"),
  ];

  for (let i = 0; i < numToolCalls; i++) {
    const tc = assistantToolCallMsg("read_file", { path: `/src/file_${i}.ts` });
    const toolCallId = tc.content[0].id;
    messages.push(tc);
    messages.push(toolResultMsg(toolCallId, "read_file", generateLargeText(outputTokensEach)));
  }

  // Final assistant response
  messages.push(assistantTextMsg("I've reviewed all the files. Here's my analysis..."));

  return messages;
}

// ── Tests ────────────────────────────────────────────────

describe("Context Compaction E2E", () => {
  // Tiny context window so we can trigger compaction easily
  const smallConfig: CompactionConfig = {
    contextWindow: 2000,   // 2K tokens
    maxOutputTokens: 200,  // 200 output tokens
    // usable = 1800, trigger at 85% = 1530
  };

  const summarizeFn: SummarizeFn = vi.fn(async (_messages: any[], _prompt: string) => {
    return "Summary: The agent was fixing an auth bug. Read 10 files. Found the issue in auth.ts line 42. Modified login handler.";
  });

  it("does NOT compact when context is small", async () => {
    const messages = [
      userMsg("Hello"),
      assistantTextMsg("Hi! How can I help?"),
    ];

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: summarizeFn,
      mode: "task",
    });

    expect(result.compacted).toBe(false);
    expect(result.pruned).toBe(false);
    expect(result.messages).toEqual(messages);
    expect(summarizeFn).not.toHaveBeenCalled();
  });

  it("prunes tool outputs when context exceeds threshold", async () => {
    // Use a larger context window where pruning alone is enough
    // 8000 token window, 800 output → usable 7200, trigger at 6120
    // 15 tool calls * 500 tokens = 7500 → over trigger
    // Pruning protects last 40K (all of them since total < 40K)
    // We need pruneProtect to be smaller to actually see pruning
    const pruneConfig: CompactionConfig = {
      contextWindow: 8000,
      maxOutputTokens: 800,
      pruneProtect: 1500,  // only protect last 1500 tokens
      pruneMinimum: 500,   // prune if we can reclaim 500+
    };

    const messages = buildLongConversation(15, 500);
    const tokensBefore = estimateMessagesTokens(messages);
    expect(tokensBefore).toBeGreaterThan(6120);

    const pruneSummarize = vi.fn(async () => "Should not be called");

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: pruneConfig,
      summarize: pruneSummarize,
      mode: "task",
    });

    expect(result.compacted).toBe(true);
    expect(result.pruned).toBe(true);
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);

    // Verify some tool outputs were pruned (contain placeholder text)
    const allText = JSON.stringify(result.messages);
    expect(allText).toContain("Output pruned");
  });

  it("calls summarize when pruning alone isn't enough", async () => {
    // Many tool calls with large outputs — pruning won't bring it under target
    const messages = buildLongConversation(20, 300);

    const mockSummarize = vi.fn(async () => {
      return "Summary: Fixed auth bug. Modified auth.ts and login.ts.";
    });

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    expect(result.compacted).toBe(true);
    expect(mockSummarize).toHaveBeenCalled();
    expect(result.summary).toBeDefined();
    expect(result.summary).toContain("Fixed auth bug");

    // First message should be the summary injection
    const firstMsg = result.messages[0];
    expect(firstMsg.role).toBe("user");
    expect(firstMsg.content).toContain("Previous context summary");
    expect(firstMsg.content).toContain("Fixed auth bug");

    // Token count should be significantly reduced
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it("preserves recent messages after summarization", async () => {
    const messages = buildLongConversation(20, 300);
    const lastAssistantMsg = messages[messages.length - 1];

    const mockSummarize = vi.fn(async () => "Summary of old conversation.");

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    // The last message (assistant analysis) should still be in the result
    const resultTexts = result.messages.map((m: any) =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    );
    const lastOriginalText = typeof lastAssistantMsg.content === "string"
      ? lastAssistantMsg.content
      : JSON.stringify(lastAssistantMsg.content);

    expect(resultTexts.some((t: string) => t.includes("reviewed all the files"))).toBe(true);
  });

  it("uses task prompt for task mode", async () => {
    const messages = buildLongConversation(20, 300);
    let capturedPrompt = "";

    const mockSummarize = vi.fn(async (_msgs: any[], prompt: string) => {
      capturedPrompt = prompt;
      return "Summary";
    });

    await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    expect(capturedPrompt).toContain("Goal");
    expect(capturedPrompt).toContain("Progress");
    expect(capturedPrompt).toContain("Files");
    expect(capturedPrompt).toContain("Next Steps");
  });

  it("uses chat prompt for chat mode", async () => {
    const messages = buildLongConversation(20, 300);
    let capturedPrompt = "";

    const mockSummarize = vi.fn(async (_msgs: any[], prompt: string) => {
      capturedPrompt = prompt;
      return "Summary";
    });

    await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "chat",
    });

    expect(capturedPrompt).toContain("preferences");
    expect(capturedPrompt).toContain("decisions");
  });

  it("passes older messages to summarize, not recent ones", async () => {
    const messages = buildLongConversation(20, 300);
    let summarizedCount = 0;

    const mockSummarize = vi.fn(async (msgs: any[]) => {
      summarizedCount = msgs.length;
      return "Summary";
    });

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    // Should have summarized some but not all messages
    expect(summarizedCount).toBeGreaterThan(0);
    expect(summarizedCount).toBeLessThan(messages.length);

    // Result should have fewer messages than original
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("handles conversation with only text (no tool calls)", async () => {
    // Build a text-heavy conversation that exceeds context
    const messages: any[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push(userMsg(generateLargeText(50)));
      messages.push(assistantTextMsg(generateLargeText(50)));
    }

    const mockSummarize = vi.fn(async () => "Summary of long text conversation.");

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "chat",
    });

    expect(result.compacted).toBe(true);
    // With no tool outputs to prune, should go straight to summarization
    expect(mockSummarize).toHaveBeenCalled();
  });

  it("respects disabled flag", async () => {
    const messages = buildLongConversation(20, 300);

    const result = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages,
      config: { ...smallConfig, disabled: true },
      summarize: summarizeFn,
      mode: "task",
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  it("multiple compaction cycles work correctly", async () => {
    // Simulate: first compaction, then more messages, then second compaction
    const messages1 = buildLongConversation(15, 300);

    const mockSummarize = vi.fn(async () => "Summary round 1.");

    const result1 = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages: messages1,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    expect(result1.compacted).toBe(true);

    // Add more messages on top of compacted result
    const extendedMessages = [
      ...result1.messages,
      ...buildLongConversation(10, 300).slice(1), // skip the initial user msg
    ];

    mockSummarize.mockResolvedValueOnce("Summary round 2 (includes round 1).");

    const result2 = await compactIfNeeded({
      systemPrompt: "You are an agent.",
      messages: extendedMessages,
      config: smallConfig,
      summarize: mockSummarize,
      mode: "task",
    });

    expect(result2.compacted).toBe(true);
    // The summary should be from round 2
    if (result2.summary) {
      expect(result2.summary).toContain("round 2");
    }
  });
});
