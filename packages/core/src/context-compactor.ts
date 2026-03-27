/**
 * Context Compaction — prevents context window overflow.
 *
 * Two-phase approach (same as OpenCode):
 * Phase 1: Prune old tool outputs (no LLM call, free)
 * Phase 2: LLM summarization if pruning isn't enough
 */

// ── Token estimation ────────────────────────────────────────────────────

/** Estimate token count: ~4 chars per token (industry standard heuristic) */
export function estimateTokens(text: string): number {
  return Math.round(text.length / 4);
}

// ── Constants (same as OpenCode) ────────────────────────────────────────

/** Protect last 40K tokens of tool output from pruning */
export const PRUNE_PROTECT = 40_000;

/** Only prune if we can reclaim at least 20K tokens */
export const PRUNE_MINIMUM = 20_000;

/** Trigger compaction at 85% of usable context */
export const TRIGGER_THRESHOLD = 0.85;

/** Target 50% of usable context after compaction */
export const TARGET_AFTER = 0.50;

// ── Types ───────────────────────────────────────────────────────────────

export interface CompactionConfig {
  /** Model's context window size in tokens */
  contextWindow: number;
  /** Max output tokens the model can generate */
  maxOutputTokens: number;
  /** Trigger compaction at this % of usable context (default: 0.85) */
  triggerThreshold?: number;
  /** Tokens of recent tool output to protect from pruning (default: 40000) */
  pruneProtect?: number;
  /** Minimum tokens to reclaim before pruning (default: 20000) */
  pruneMinimum?: number;
  /** Disable auto-compaction entirely */
  disabled?: boolean;
}

export type SummarizeFn = (messages: any[], prompt: string) => Promise<string>;

/** Event emitted when compaction occurs */
export interface CompactionEvent {
  /** What phase triggered: "prune" or "summarize" */
  phase: "prune" | "summarize";
  /** Token count before compaction */
  tokensBefore: number;
  /** Token count after compaction */
  tokensAfter: number;
  /** Tokens reclaimed */
  tokensReclaimed: number;
  /** Number of messages before */
  messagesBefore: number;
  /** Number of messages after */
  messagesAfter: number;
  /** Number of tool outputs pruned (phase 1) */
  toolOutputsPruned?: number;
  /** Summary text (phase 2 only) */
  summary?: string;
  /** Mode: task or chat */
  mode: "task" | "chat";
}

export type OnCompactionFn = (event: CompactionEvent) => void;

export interface CompactionInput {
  systemPrompt: string;
  messages: any[]; // AgentMessage[] from pi-agent-core
  tools?: any[];
  config: CompactionConfig;
  summarize: SummarizeFn;
  mode: "task" | "chat";
  /** Called when compaction occurs — use for logging, events, UI updates */
  onCompaction?: OnCompactionFn;
}

export interface CompactionResult {
  messages: any[];
  compacted: boolean;
  pruned: boolean;
  summary?: string;
  tokensBefore: number;
  tokensAfter: number;
}

// ── Summarization prompts ───────────────────────────────────────────────

const TASK_COMPACTION_PROMPT = `Summarize the conversation for handoff to a continuation agent.

## Required sections:
### Goal
What is the task trying to accomplish?

### Progress
- Completed: what's done
- In progress: what was interrupted
- Remaining: what's left

### Key Decisions & Discoveries
Technical decisions, constraints found, approaches tried and failed

### Files Modified
List of files read, created, or edited with brief description

### Next Steps
Specific actions to take next

Be precise and concise. Preserve file paths, function names, and error messages exactly.`;

const CHAT_COMPACTION_PROMPT = `Summarize the conversation to preserve context for continuation.
Focus on: user preferences, decisions made, questions asked, key facts shared.
Preserve any code snippets, file paths, or technical details mentioned.
Be precise and concise.`;

/** Get the appropriate compaction prompt for a given mode */
export function getCompactionPrompt(mode: "task" | "chat"): string {
  return mode === "task" ? TASK_COMPACTION_PROMPT : CHAT_COMPACTION_PROMPT;
}

// ── Token estimation for messages ───────────────────────────────────────

/** Estimate total tokens across an array of messages */
export function estimateMessagesTokens(messages: any[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

function estimateMessageTokens(msg: any): number {
  if (!msg) return 0;

  // Role overhead (~4 tokens for role + formatting)
  let tokens = 4;

  const content = msg.content;
  if (typeof content === "string") {
    tokens += estimateTokens(content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        tokens += estimateTokens(block.text);
      } else if (block.type === "toolCall") {
        // Tool call: name + stringified arguments
        if (block.name) tokens += estimateTokens(block.name);
        if (block.arguments !== undefined) {
          const args =
            typeof block.arguments === "string"
              ? block.arguments
              : JSON.stringify(block.arguments);
          tokens += estimateTokens(args);
        }
      }
    }
  }

  return tokens;
}

// ── Threshold check ─────────────────────────────────────────────────────

/** Check whether compaction should be triggered based on current token usage */
export function shouldCompact(config: CompactionConfig, currentTokens: number): boolean {
  if (config.disabled) return false;
  const usable = config.contextWindow - config.maxOutputTokens;
  const threshold = config.triggerThreshold ?? TRIGGER_THRESHOLD;
  return currentTokens >= usable * threshold;
}

// ── Phase 1: Prune tool outputs ─────────────────────────────────────────

/**
 * Walk backwards through messages and replace old tool result content with
 * placeholders. Protects the most recent `pruneProtect` tokens of tool output.
 * Only prunes if total prunable tokens >= `pruneMinimum`.
 */
export function pruneToolOutputs(
  messages: any[],
  config: CompactionConfig,
): any[] {
  const protectTokens = config.pruneProtect ?? PRUNE_PROTECT;
  const minimumTokens = config.pruneMinimum ?? PRUNE_MINIMUM;

  // First pass: walk backwards and collect tool result locations + sizes
  interface ToolResultEntry {
    messageIndex: number;
    blockIndex?: number; // for array content within toolResult messages
    tokens: number;
    toolName: string;
  }

  const entries: ToolResultEntry[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "toolResult" && Array.isArray(msg.content)) {
      for (let j = msg.content.length - 1; j >= 0; j--) {
        const block = msg.content[j];
        if (block.type === "text" && typeof block.text === "string") {
          const tokens = estimateTokens(block.text);
          // Try to find the tool name from the message-level or block-level properties
          const toolName = msg.toolName || msg.name || block.toolName || "unknown";
          entries.push({
            messageIndex: i,
            blockIndex: j,
            tokens,
            toolName,
          });
        }
      }
    }
  }

  // entries are in reverse order (most recent first) due to backward walk
  // Calculate how many tokens to protect and how many are prunable
  let protectedSoFar = 0;
  let prunableTokens = 0;
  const prunableEntries: ToolResultEntry[] = [];

  for (const entry of entries) {
    if (protectedSoFar < protectTokens) {
      protectedSoFar += entry.tokens;
    } else {
      prunableTokens += entry.tokens;
      prunableEntries.push(entry);
    }
  }

  // Only prune if we can reclaim enough
  if (prunableTokens < minimumTokens) {
    return messages;
  }

  // Deep-clone messages to avoid mutation
  const result: any[] = JSON.parse(JSON.stringify(messages));

  // Apply pruning
  for (const entry of prunableEntries) {
    const msg = result[entry.messageIndex];
    if (entry.blockIndex !== undefined && Array.isArray(msg.content)) {
      msg.content[entry.blockIndex] = {
        type: "text",
        text: `[Output pruned — was ${entry.tokens} tokens. Tool: ${entry.toolName}]`,
      };
    }
  }

  return result;
}

// ── Phase 2: Full compaction ────────────────────────────────────────────

/**
 * Main entry point. Checks if compaction is needed, tries pruning first,
 * then falls back to LLM summarization if necessary.
 */
export async function compactIfNeeded(input: CompactionInput): Promise<CompactionResult> {
  const { systemPrompt, messages, tools, config, summarize, mode, onCompaction } = input;

  if (config.disabled) {
    const tokens = estimateTotalTokens(systemPrompt, messages, tools);
    return {
      messages,
      compacted: false,
      pruned: false,
      tokensBefore: tokens,
      tokensAfter: tokens,
    };
  }

  const tokensBefore = estimateTotalTokens(systemPrompt, messages, tools);
  const usable = config.contextWindow - config.maxOutputTokens;
  const threshold = config.triggerThreshold ?? TRIGGER_THRESHOLD;

  // Not over threshold — nothing to do
  if (tokensBefore < usable * threshold) {
    return {
      messages,
      compacted: false,
      pruned: false,
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }

  const target = usable * TARGET_AFTER;

  // Phase 1: try pruning tool outputs
  const pruned = pruneToolOutputs(messages, config);
  const tokensAfterPrune = estimateTotalTokens(systemPrompt, pruned, tools);

  if (tokensAfterPrune <= target) {
    onCompaction?.({
      phase: "prune",
      tokensBefore,
      tokensAfter: tokensAfterPrune,
      tokensReclaimed: tokensBefore - tokensAfterPrune,
      messagesBefore: messages.length,
      messagesAfter: pruned.length,
      toolOutputsPruned: countPrunedOutputs(pruned),
      mode,
    });
    return {
      messages: pruned,
      compacted: true,
      pruned: true,
      tokensBefore,
      tokensAfter: tokensAfterPrune,
    };
  }

  // Phase 2: LLM summarization
  // Keep ~60% of target budget as recent messages
  const recentBudget = target * 0.6;

  // Walk backwards to find split point
  let recentTokens = 0;
  let splitIndex = pruned.length;
  for (let i = pruned.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(pruned[i]);
    if (recentTokens + msgTokens > recentBudget && i < pruned.length - 1) {
      splitIndex = i + 1;
      break;
    }
    recentTokens += msgTokens;
    if (i === 0) splitIndex = 0;
  }

  // Need at least some older messages to summarize
  if (splitIndex <= 0) {
    // Everything is "recent" — just return pruned
    return {
      messages: pruned,
      compacted: true,
      pruned: true,
      tokensBefore,
      tokensAfter: tokensAfterPrune,
    };
  }

  const olderMessages = pruned.slice(0, splitIndex);
  const recentMessages = pruned.slice(splitIndex);

  const prompt = getCompactionPrompt(mode);
  const summary = await summarize(olderMessages, prompt);

  const summaryMessage = {
    role: "user",
    content: `[Previous context summary]\n${summary}\n[End summary — continue from here]`,
  };

  const compactedMessages = [summaryMessage, ...recentMessages];
  const tokensAfter = estimateTotalTokens(systemPrompt, compactedMessages, tools);

  onCompaction?.({
    phase: "summarize",
    tokensBefore,
    tokensAfter,
    tokensReclaimed: tokensBefore - tokensAfter,
    messagesBefore: messages.length,
    messagesAfter: compactedMessages.length,
    toolOutputsPruned: countPrunedOutputs(pruned),
    summary,
    mode,
  });

  return {
    messages: compactedMessages,
    compacted: true,
    pruned: true,
    summary,
    tokensBefore,
    tokensAfter,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────

function countPrunedOutputs(messages: any[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role === "toolResult" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.startsWith("[Output pruned")) {
          count++;
        }
      }
    }
  }
  return count;
}

function estimateTotalTokens(
  systemPrompt: string,
  messages: any[],
  tools?: any[],
): number {
  let total = estimateTokens(systemPrompt);
  total += estimateMessagesTokens(messages);
  if (tools && tools.length > 0) {
    // Rough estimate: stringify tool definitions
    total += estimateTokens(JSON.stringify(tools));
  }
  return total;
}
