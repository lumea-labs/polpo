/**
 * BENCH directive — the contract between the benchmark runner and the mock LLM.
 *
 * A directive is embedded in the first user message of a task (i.e. the task
 * description). The mock LLM parses it and scripts its behavior from it, so
 * the benchmark never depends on runtime internals — only on the fact that
 * the task description reaches the model.
 *
 * Format:
 *   [BENCH sid=<id> turns=N toolsPerTurn=K latencyMs=L toolOutputBytes=B finalBytes=F outcomes=O cap=normal|never]
 *
 * Semantics:
 *   sid             session id (alphanumeric, no underscores) — keys mock-side stats
 *   turns           number of TOOL turns. The mock emits tool calls for turns
 *                   1..N and a final text response on turn N+1.
 *                   turns=0 → immediate final response (no tools).
 *   toolsPerTurn    bash tool calls emitted per tool turn
 *   latencyMs       artificial model "think time" applied before every response
 *   toolOutputBytes size of the output each bash command produces
 *   finalBytes      size of the final assistant text
 *   outcomes        register_outcome tool calls emitted on the LAST tool turn
 *   cap             "never" → never emit a final response (always tool calls);
 *                   used to test maxTurns/timeout ceilings
 */

const DIRECTIVE_RE = /\[BENCH\s+([^\]]+)\]/;

export const DIRECTIVE_DEFAULTS = {
  turns: 0,
  toolsPerTurn: 1,
  latencyMs: 50,
  toolOutputBytes: 256,
  finalBytes: 200,
  outcomes: 0,
  cap: "normal",
};

/** Build a directive string from params. */
export function buildDirective(sid, params) {
  const p = { ...DIRECTIVE_DEFAULTS, ...params };
  return (
    `[BENCH sid=${sid} turns=${p.turns} toolsPerTurn=${p.toolsPerTurn} ` +
    `latencyMs=${p.latencyMs} toolOutputBytes=${p.toolOutputBytes} ` +
    `finalBytes=${p.finalBytes} outcomes=${p.outcomes} cap=${p.cap}]`
  );
}

/** Parse the first BENCH directive found in a text blob. Returns null if absent. */
export function parseDirective(text) {
  if (typeof text !== "string") return null;
  const m = DIRECTIVE_RE.exec(text);
  if (!m) return null;
  const params = { ...DIRECTIVE_DEFAULTS };
  let sid = null;
  for (const pair of m[1].trim().split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key === "sid") sid = value;
    else if (key === "cap") params.cap = value === "never" ? "never" : "normal";
    else if (key in params) params[key] = Number(value);
  }
  if (!sid) return null;
  return { sid, ...params };
}

/** Generate a session id — lowercase alphanumeric, no underscores (call-id safe). */
export function genSid() {
  return (
    "s" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 8)
  ).toLowerCase();
}

/**
 * Tool call ids encode sid + turn so the mock can recover its position
 * statelessly from the conversation history the runtime echoes back:
 *   call_<sid>_t<turn>_<index>
 */
export function buildCallId(sid, turn, index) {
  return `call_${sid}_t${turn}_${index}`;
}

const CALL_ID_RE = /call_([a-z0-9]+)_t(\d+)_(\d+)/g;

/** Extract {sid, maxTurn} from any text containing bench call ids. */
export function scanCallIds(text) {
  let sid = null;
  let maxTurn = 0;
  for (const m of text.matchAll(CALL_ID_RE)) {
    sid = m[1];
    const turn = Number(m[2]);
    if (turn > maxTurn) maxTurn = turn;
  }
  return sid ? { sid, maxTurn } : null;
}
