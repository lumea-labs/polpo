/**
 * bench/scenarios.mjs — declarative benchmark scenarios.
 *
 * Each scenario describes:
 *   - directive params for the mock LLM (see lib/directive.mjs — `turns` is
 *     the number of TOOL turns; the final text response happens on turn N+1)
 *   - which agent runs it ("bench-agent" maxTurns=250, "bench-capped" maxTurns=15)
 *   - task options (maxDuration, ...)
 *   - invariants checked against the terminal task record + mock stats
 *
 * Invariant fields (all optional):
 *   terminal      array of acceptable terminal task statuses
 *   turnsServed   exact number, or { min, max }
 *   toolCalls     exact number of bash tool calls the mock must have emitted
 *   outcomes      exact number of outcomes expected on the task record
 *   maxWallMs     upper bound on wall time (sanity ceiling, generous)
 *
 * latencyMs defaults to 50 everywhere so llm_ms is known and
 * overhead_ms = wall_ms − llm_ms is meaningful.
 */

export const DEFAULT_LATENCY_MS = 50;

export const scenarios = [
  {
    name: "smoke",
    description: "1 assistant turn, no tools — pure spawn + single LLM round-trip",
    agent: "bench-agent",
    directive: { turns: 0, toolsPerTurn: 0, latencyMs: DEFAULT_LATENCY_MS, finalBytes: 200 },
    timeoutMs: 90_000,
    invariants: { terminal: ["done"], turnsServed: 1, toolCalls: 0 },
  },
  {
    name: "tool_loop_50",
    description: "50 tool turns x 1 bash — sequential loop throughput",
    agent: "bench-agent",
    directive: { turns: 50, toolsPerTurn: 1, latencyMs: DEFAULT_LATENCY_MS, toolOutputBytes: 256 },
    timeoutMs: 240_000,
    invariants: { terminal: ["done"], turnsServed: 51, toolCalls: 50 },
  },
  {
    name: "tool_burst",
    description: "10 tool turns x 5 bash/turn — parallel tool dispatch within a turn",
    agent: "bench-agent",
    directive: { turns: 10, toolsPerTurn: 5, latencyMs: DEFAULT_LATENCY_MS, toolOutputBytes: 256 },
    timeoutMs: 180_000,
    invariants: { terminal: ["done"], turnsServed: 11, toolCalls: 50 },
  },
  {
    name: "big_output",
    description: "30 tool turns x 1 bash with 64KB output — context growth / compaction stress",
    agent: "bench-agent",
    // Note: the runtime's bash tool truncates output to the last 30KB, so each
    // turn contributes ~30KB to context. 30 turns ≈ 900KB ≈ 225K estimated
    // tokens — enough to cross the compaction trigger (85% of a 200K window).
    directive: { turns: 30, toolsPerTurn: 1, latencyMs: DEFAULT_LATENCY_MS, toolOutputBytes: 65_536, finalBytes: 500 },
    timeoutMs: 300_000,
    invariants: { terminal: ["done"], turnsServed: 31, toolCalls: 30 },
  },
  {
    name: "max_turns_cap",
    description: "cap=never on agent with maxTurns=15 — runtime must stop the loop at the ceiling",
    agent: "bench-capped", // maxTurns: 15
    directive: { turns: 9999, toolsPerTurn: 1, latencyMs: DEFAULT_LATENCY_MS, cap: "never" },
    timeoutMs: 120_000,
    // The engine performs exactly maxTurns streamText calls, all answered with
    // tool calls, then exits the loop. Terminal status is runtime-defined:
    // current runtime treats a capped loop as a normal exit (done).
    invariants: { terminal: ["done", "failed"], turnsServed: 15, toolCalls: 15 },
  },
  {
    name: "outcomes_3",
    description: "5 tool turns + 3 register_outcome on the last turn — outcome pipeline",
    agent: "bench-agent",
    directive: { turns: 5, toolsPerTurn: 1, latencyMs: DEFAULT_LATENCY_MS, outcomes: 3 },
    timeoutMs: 120_000,
    invariants: { terminal: ["done"], turnsServed: 6, toolCalls: 5, outcomes: 3 },
  },
  {
    name: "timeout_kill",
    description: "cap=never + task maxDuration=8s — watchdog must kill and fail the task",
    agent: "bench-agent",
    directive: { turns: 9999, toolsPerTurn: 1, latencyMs: 300, cap: "never" },
    taskOpts: { maxDuration: 8_000 },
    timeoutMs: 120_000,
    invariants: { terminal: ["failed"] },
  },
  {
    name: "concurrency_10",
    description: "10 concurrent tasks x 5 tool turns — scheduler fan-out + makespan",
    agent: "bench-agent",
    concurrency: 10,
    directive: { turns: 5, toolsPerTurn: 1, latencyMs: DEFAULT_LATENCY_MS, toolOutputBytes: 256 },
    timeoutMs: 300_000,
    invariants: { terminal: ["done"], turnsServed: 6, toolCalls: 5 },
  },
];

export function selectScenarios(only) {
  if (!only) return scenarios;
  const names = only.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !scenarios.some((s) => s.name === n));
  if (unknown.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknown.join(", ")}. Available: ${scenarios.map((s) => s.name).join(", ")}`);
  }
  return scenarios.filter((s) => names.includes(s.name));
}
