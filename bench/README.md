# Polpo Task Benchmark Suite

Runtime-agnostic, black-box benchmarks for Polpo's TASK execution path.
The suite talks **only to public contracts**:

1. the Polpo HTTP task API (`POST /tasks`, `GET /tasks/:id`, …), and
2. a mock OpenAI-compatible LLM wired in via the standard `providers`
   baseUrl override in `polpo.json`.

Because nothing here imports runtime internals, the exact same suite runs
against different runtime versions (old/new branch, local dist, a sandbox, a
remote deployment) and the JSON results stay comparable over time. Pricing is
a separate declarative layer (`pricing.json`) — measurements never encode
costs.

## Quick start

```bash
pnpm build                                        # dist/ must exist
node bench/run.mjs --label baseline-main-runtime  # full local run
node bench/run.mjs --only smoke,tool_loop_50      # subset
node bench/run.mjs --label rel-subprocess --execution-mode subprocess   # both execution
node bench/run.mjs --label rel-inprocess  --execution-mode in-process   # modes, per release
node bench/compare.mjs bench/results/<a>.json bench/results/<b>.json
```

Local mode creates a throwaway project in a temp dir, starts the mock LLM
(`:8377`) and a `PolpoServer` from `<repo>/dist` (`:8378`), runs every
scenario, writes `bench/results/<ISO-ts>-<gitsha7>-<label>.json`, and tears
everything down. Exit code is non-zero if any scenario fails.

Against a running server (sandbox, other machine, other runtime):

```bash
node bench/mock-llm.mjs --port 8377 &   # somewhere the server's runtime can reach
node bench/run.mjs --target http://host:3890 --mock-url http://mock-host:8377 --label candidate
```

In target mode the target project must already contain the provider override
(see below) pointing at the mock, and `POLPO_API_KEY` is honored if the target
requires auth.

## How it works

### The BENCH directive

Every task description embeds a directive that fully scripts the mock model:

```
[BENCH sid=<id> turns=N toolsPerTurn=K latencyMs=L toolOutputBytes=B finalBytes=F outcomes=O cap=normal|never]
```

- `turns=N` → N **tool turns** (each with `K` parallel `bash` calls producing
  `B` bytes of output), then a final text response of `F` bytes on turn N+1.
- `outcomes=O` → O `register_outcome` calls on the last tool turn.
- `cap=never` → the model never stops calling tools (tests `maxTurns` /
  `maxDuration` ceilings).
- `latencyMs=L` → artificial model think-time per request, so `llm_ms` is
  known exactly and `overhead_ms = wall_ms − llm_ms` is meaningful.

The mock is stateless per request: the current turn is recovered from the
conversation history itself (bench tool-call ids encode `sid` + turn, and the
runtime echoes them back). Per-`sid` stats (requests, turns, artificial
latency applied, tool calls emitted, per-turn request counts `turnRequests`,
max call-id turn seen inside incoming requests `maxHistoryTurn`) are exposed
at `GET /bench/stats/<sid>`; `POST /bench/reset` clears them. The last two
exist for durable-execution verification: a resumed session must show
`turnRequests[t] == 1` for every checkpointed turn (no re-execution) and a
`maxHistoryTurn` proving the seeded checkpoint history reached the model.

The mock speaks **both** wire protocols behind a `baseUrl` override:

- `POST <base>/responses` — OpenAI Responses API. This is what the current
  runtime actually uses: `createOpenAI()(modelId)` from `@ai-sdk/openai` v3
  defaults to the Responses protocol, *not* Chat Completions.
- `POST <base>/chat/completions` — OpenAI Chat Completions (streaming SSE and
  non-streaming), for runtimes using `.chat()` / `openai-compatible`.

Tool-less requests (the engine's context-compaction `generateText` calls) get
a text "summary" that re-embeds the directive, so scripted sessions survive
history compaction.

### Metrics

| metric        | meaning                                                              |
| ------------- | -------------------------------------------------------------------- |
| `wall_ms`     | `POST /tasks` → terminal status observed (100ms polling)             |
| `spawn_ms`    | `POST /tasks` → first status past `pending` (orchestrator tick + runner boot) |
| `llm_ms`      | Σ artificial model latency actually served (from mock stats)          |
| `overhead_ms` | `wall_ms − llm_ms` — everything that isn't the model: ticks, spawn, tool exec, harness |
| `loop_ms`     | first → last LLM request seen by the mock — the agent loop itself, free of tick quantization |
| `loop_overhead_ms` | `loop_ms − llm_ms` — per-loop harness cost (tool exec + engine bookkeeping) |
| `makespan_ms` | concurrency scenarios: first POST → last task terminal               |

### Scenarios

| name             | what it stresses                                                   |
| ---------------- | ------------------------------------------------------------------ |
| `smoke`          | spawn + 1 LLM round-trip, no tools                                 |
| `tool_loop_50`   | 50 sequential tool turns × 1 bash                                  |
| `tool_burst`     | 10 turns × 5 bash/turn (parallel tool dispatch within a turn)      |
| `big_output`     | 30 turns × 64KB tool output (context growth / compaction)          |
| `max_turns_cap`  | `cap=never` vs agent `maxTurns: 15` — loop ceiling                 |
| `outcomes_3`     | `register_outcome` pipeline → `task.outcomes`                      |
| `timeout_kill`   | `cap=never` + `maxDuration: 8s` — watchdog kill → terminal `failed`|
| `concurrency_10` | 10 concurrent 5-turn tasks — fan-out + makespan                    |
| `crash_resume`   | durable turns: SIGKILL server+runner mid-task, restart → resume from checkpoint (see below) |

Add a scenario by appending one object to `bench/scenarios.mjs` (directive
params + declarative invariants — terminal status, turns served by the mock,
tool calls emitted, outcomes on the task record).

### Execution modes (`--execution-mode`)

Adaptive isolation (v0.12.x) makes WHERE a task runs a per-run policy:
`"subprocess"` (historical default, detached runner process) or
`"in-process"` (the loop runs inside the server — ProxyTool P0). The flag
runs the SAME scenarios under the chosen backend so every release measures
both:

- **local mode** writes `settings.taskExecution` into the throwaway project
  (settings tier of the resolver);
- **target mode** sends the per-task `executionMode` field on `POST /tasks`
  (task tier — a remote project's settings can't be rewritten).

Either way the harness verifies the RESOLVED mode as an **invariant, not a
label**: the live run record (`GET /tasks/:id/activity` → `run.executionMode`,
sampled mid-run because run records are deleted at collection) must report
the requested mode, corroborated by the pid sign (negative = in-process
synthetic pid, positive = OS subprocess). Without the flag nothing is sent or
asserted, so the suite still runs against runtimes that predate execution
modes; the observed mode is reported in `metrics.execution_mode` when
available.

### Durable execution (`crash_resume`)

Verifies and measures Phase A durable turns end-to-end, black-box:

1. a control run of the same directive (8 tool turns × 400ms think time)
   completes normally — ground truth for wall time and final result text;
2. the crash run starts on a **dedicated child-hosted server** (own temp
   project, file storage — run records are JSON files that survive restarts);
3. once the mock has served turn `killAfterTurn + 1` (the engine awaits the
   turn-K checkpoint write before requesting K+1, so the turn-4 checkpoint is
   guaranteed durable), the driver SIGKILLs the server host and the runner
   (in-process runs die with the host). SIGKILL is the only honest crash:
   PolpoServer traps SIGTERM/SIGINT into `gracefulStop()`, which deletes run
   records — destroying the checkpoint;
4. the server restarts on the same project dir. Startup orphan recovery
   (`recoverOrphanedTasks`) finds the dead run, harvests `resumeState`, and
   the respawn seeds the checkpoint history.

Invariants: task terminal `done`; **turns ≤ killAfterTurn requested exactly
once** (mock `turnRequests` — retry-from-zero fails this immediately); at
most the un-checkpointed in-flight tail is re-requested, once; the seeded
history reached the model (`maxHistoryTurn`); final result text
byte-identical to the control run. Metrics: `wall_ms` (includes downtime),
`control_wall_ms`, `downtime_ms`, `kill_at_turn`, `resumed_from_turn`,
`turns_saved`, `duplicated_turns`.

Local mode only — the scenario owns its server lifecycle, so it is skipped
(with a note) under `--target`.

## Results: subprocess vs in-process (v0.12.x, sha 84875ff)

First measured comparison of the two execution backends — same scenarios,
same mock, labels `durable-subprocess` / `durable-inprocess` (committed in
`bench/results/`). Both runs 9/9 green, execution-mode invariant verified on
every run record.

| scenario       | subprocess wall | in-process wall | Δ wall | ovh sub | ovh in-proc |
| -------------- | --------------- | --------------- | ------ | ------- | ----------- |
| smoke          | 538             | 155             | −71%   | 488     | 105         |
| tool_loop_50   | 3786            | 3520            | −7%    | 1236    | 970         |
| tool_burst     | 1345            | 1226            | −9%    | 795     | 676         |
| big_output     | 2658            | 2411            | −9%    | 1108    | 861         |
| max_turns_cap  | 1440            | 1043            | −28%   | 690     | 293         |
| outcomes_3     | 826             | 425             | −49%   | 526     | 125         |
| timeout_kill   | 10089           | 10051           | −0.4%  | 1089    | 751         |
| concurrency_10 | 2524 (makespan) | 1230 (makespan) | −51%   | —       | —           |
| crash_resume   | 5883            | 5541            | −6%    | —       | —           |

What the numbers say:

- **In-process removes a ~380–400ms fixed cost per task** (runner Node boot
  + engine import): decisive for short tasks (smoke −71%, outcomes_3 −49%),
  marginal for long loops (tool_loop_50 −7%). This is the measured floor of
  the ProxyTool win before sandbox billing even enters the picture.
- **Fan-out benefits most**: `concurrency_10` makespan halves (1230ms vs
  2524ms) — ten subprocess boots vs zero.
- **The loop itself is slightly slower in-process** on tool-heavy scenarios
  (`loop_ms` +5% on tool_loop_50, +24% on tool_burst): the engine shares the
  server's event loop, so parallel tool dispatch contends with API traffic.
  Wall still wins because the boot saving dominates; worth re-measuring as
  in-process concurrency grows.
- `crash_resume` (see invariants above): kill after the turn-4/5 checkpoint,
  restart, resume — **5 turns saved, zero re-executed**, ~1.3s downtime
  (child-server restart incl. startup recovery), resumed task ~1.4–1.7s
  slower than its no-crash control, final result byte-identical. Works
  identically in both execution modes (synthetic negative pids recover the
  same way: a fresh process has no live in-process runs, so the checkpoint
  is harvested).

## Baseline results (historical: v0.10.x runtime, pre-reactive-tick)

All 8 scenarios pass. Headline numbers from the committed baseline run
(`bench/results/…-baseline-main-runtime.json`, run-to-run variance ~±1%):

| scenario       | wall_ms | spawn_ms | llm_ms | overhead_ms | loop_ms |
| -------------- | ------- | -------- | ------ | ----------- | ------- |
| smoke          | 10066   | 4997     | 50     | 10016       | 0       |
| tool_loop_50   | 10036   | 4968     | 2550   | 7486        | 3058    |
| tool_burst     | 9939    | 4976     | 550    | 9389        | 784     |
| big_output     | 10035   | 5070     | 1550   | 8485        | 1926    |
| max_turns_cap  | 10035   | 4969     | 750    | 9285        | 876     |
| outcomes_3     | 10031   | 4966     | 300    | 9731        | 339     |
| timeout_kill   | 19967   | 4971     | 9600   | 10367       | 9636    |
| concurrency_10 | 10109 (makespan) | 5055 | 3000 | —      | —       |

What the numbers say:

- **Every task pays ~2 orchestrator ticks (~10s wall) of fixed overhead.**
  The supervisor loop polls at 5s (`POLL_INTERVAL`); spawn happens on the
  first tick (`spawn_ms ≈ 5s`), result collection on a later tick. A 51-turn
  tool loop and a 1-turn smoke test both wall at ~10s — the loop itself is
  fast; tick quantization dominates.
- `loop_ms` (tick-free) isolates the engine loop: 51 turns with 50ms think
  time each = 3058ms, i.e. **~10ms harness overhead per turn** (streamText +
  tool exec + transcript). Bursts of 5 tools/turn: ~23ms/turn.
- `big_output` crosses the compaction trigger: the prune stage fired
  (observed: 168K → 48K estimated tokens, 16 tool outputs pruned) with no
  measurable wall impact, and the LLM-summarize stage was never needed.
- `timeout_kill` walls ~20s for an 8s `maxDuration`: the kill fires on the
  tick after the deadline and the failure is collected on a later tick.
- `concurrency_10`: all 10 tasks spawn on the same tick and run genuinely in
  parallel — makespan ≈ single-task wall (~10s).

## Runtime findings (empirical, useful for the loop refactor)

Discovered while building this suite against the current dist runtime:

1. **Custom providers can't spawn task agents.** Pre-spawn validation
   (`validateProviderKeys`) only accepts providers present in the static
   `PROVIDER_ENV_MAP`; a provider named e.g. `bench` (or `ollama`, `vllm`)
   fails with "Missing API key" even when `providers.<name>.baseUrl` is set in
   `polpo.json`. Workaround used here: name the provider `openai` with a
   `baseUrl` override + dummy `OPENAI_API_KEY`.
2. **Provider overrides don't reach the task runner subprocess.** The
   orchestrator applies `providers` from `polpo.json` via
   `setProviderOverrides()` in-process only; `RunnerConfig` carries no
   `providers` (and no `gatewayConfig`), and `dist/core/runner.js` never reads
   `polpo.json`. Chat completions (in-process) honor overrides; task agents do
   not. The harness bridges this with `NODE_OPTIONS=--import
   bench/lib/preload-providers.mjs`, which replays the same overrides inside
   every spawned Node process (a no-op on a runtime that propagates them
   properly).
3. **The default provider protocol is the Responses API.** `@ai-sdk/openai` v3
   `createOpenAI(...)(modelId)` returns a Responses-protocol model. Any
   OpenAI-compatible endpoint used via `providers.*.baseUrl` must implement
   `/responses`, not just `/chat/completions`.
4. **The API rate limiter keys on `x-forwarded-for`** (200 req/60s, in-memory,
   trusts the client header). Local mode rotates synthetic XFF buckets to
   poll at 100ms; target mode polls at 300ms and uses one shared `GET /tasks`
   poll for concurrency scenarios.
5. **`maxTurns` cap is a silent success.** A loop stopped by `maxTurns`
   returns exit code 0 and the task lands in `done` (empty result text) — not
   `failed`. The `max_turns_cap` invariant accepts `done|failed` and asserts
   the mock served exactly `maxTurns` turns.
6. **Retries default on.** `settings.maxRetries` (default 2–3) silently
   re-runs failed tasks; the bench project sets `maxRetries: 0` so failure
   scenarios (`timeout_kill`) reach a terminal state deterministically.
7. **Bash output is truncated to the last 30KB** (`MAX_OUTPUT_BYTES`), so a
   64KB tool output contributes ~30KB to context. Combined with the prune
   stage of compaction (drop old tool outputs before LLM-summarizing), the
   LLM-summarize compaction path is effectively unreachable through bash-only
   loops — prune alone reclaims to target. The mock still handles tool-less
   summarize requests (and re-embeds the directive) in case another runtime
   reaches that path.
8. **`agents.json` on disk is not a bare `AgentConfig[]`** — the file store
   format is `[{ "agent": {...}, "teamName": "..." }]`.
9. **Resume is a hard-crash path only** (verified building `crash_resume`,
   v0.12.x): `gracefulStop()` (also reached via SIGTERM/SIGINT — PolpoServer
   traps both) marks active runs killed and DELETES their run records, so no
   checkpoint survives a graceful shutdown; and a runner that dies while the
   server stays alive goes through stale-detection → retry-from-zero, not
   resume. Startup orphan recovery after SIGKILL is the one path that
   resumes from the checkpoint — which is exactly what the scenario
   simulates (and what a crash/deploy restart looks like in production).

## Pricing layer

`pricing.json` holds per-provider sandbox rates (official pricing pages, July
2026) and the reference sandbox size (2 vCPU / 4 GiB). `compare.mjs` projects
two execution models from any result file:

- **Model A — sandbox-alive-per-task**: the sandbox is billed for the entire
  task `wall_ms` (today's runner-in-sandbox architecture).
- **Model B — ProxyTool**: the LLM loop runs in the server; the sandbox is
  billed only for `overhead_ms` (tool/harness time). LLM think-time costs
  nothing sandbox-side.

Vercel is modeled per its billing semantics: active-CPU on harness time only
(LLM wait is I/O), memory on alive time, 60s minimum bill.

## Philosophy

- **Runtime-agnostic**: only public HTTP contracts; no imports from `src/` or
  `packages/`. If a runtime changes internals but keeps the contracts, the
  suite runs unchanged and the numbers are comparable.
- **Deterministic model**: known think-time and scripted turns make overhead
  computable instead of estimated.
- **Results are committed**: `bench/results/*.json` is the longitudinal
  record. Label runs meaningfully (`--label baseline-main-runtime`,
  `--label task-loop-v2`, …).
- **Prices are data, not code**: update `pricing.json`, never the harness.
