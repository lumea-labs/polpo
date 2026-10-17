# Runtime Hooks

Runtime Hooks let trusted project configuration observe or control an agent at
stable lifecycle boundaries. The same agent hook pack is resolved for direct
chat, Run-backed chat, Channels, and agent nodes inside Project Loops.

Hooks do not replace tool policy, approvals, Connections, guardrails, or schema
validation. An `allow` decision cannot grant a denied capability. Modified tool
arguments pass through the normal policy and schema checks before execution.

## Project layout

Create a versioned pack in `.polpo/hooks` and reference it from an agent:

```text
.polpo/
  hooks/
    quality.json
  agents/
    support/
      agent.json
```

```json
{
  "version": 1,
  "name": "quality",
  "hooks": [
    {
      "id": "protect-writes",
      "event": "tool:before",
      "matcher": { "tools": ["write", "edit", "*_delete"] },
      "onFailure": "block",
      "handler": {
        "type": "command",
        "command": "./scripts/check-write.mjs"
      }
    },
    {
      "id": "audit-results",
      "event": "tool:after",
      "mode": "observe",
      "handler": {
        "type": "http",
        "url": "https://policy.example.com/polpo-hooks",
        "connection": "policy-service"
      }
    }
  ]
}
```

```json
{
  "name": "support",
  "model": "anthropic/claude-sonnet-4.5",
  "hooks": ["quality"]
}
```

Validate and deploy with:

```bash
polpo hooks validate
polpo hooks list --local
polpo deploy
polpo hooks list
polpo hooks capabilities
```

## Lifecycle events

The v1 catalog covers sessions, input, model steps, tools, agent nodes,
compaction, model switches, Project Loops, sandboxes, and Runs:

```text
session:start        session:resume       session:end
input:before         turn:stop            turn:error
model:before         model:after          model:error
tool:before          tool:after           tool:error
tool:batch:after     approval:request     approval:denied
agent:spawn          agent:end
context:compact:before                    context:compact:after
model:switch:before  model:switch:after
loop:start           step:before          loop:transition
step:after           loop:stop            loop:end
sandbox:start        sandbox:cwd_changed  sandbox:file_changed
sandbox:end          run:start             run:end
```

`sandbox:file_changed` is emitted for mutations performed through the portable
`write_file` and `edit_file` tools. A host may add external filesystem
watching, but v1 does not claim that capability. Inspect the exact target with
`GET /v1/hooks/capabilities` or `polpo hooks capabilities --json`.

Matchers use exact values or `*` globs for surfaces, agents, Loops, steps, and
tools. Controlling hooks run in stable scope, priority, and declaration order.
Observe-only hooks may run concurrently and cannot change the decision.

## Handlers

Every handler receives a versioned, redacted JSON envelope with an immutable
identity and a stable idempotency key.

- `command` runs in the authorized project workspace or sandbox.
- `http` sends a POST to a public HTTPS destination. Authentication is resolved
  from a Connection; redirects and private DNS destinations are rejected.
- `tool` invokes a trusted Polpo tool adapter.
- `mcp_tool` invokes a tool through an authorized MCP Connection.
- `prompt` performs one bounded structured model evaluation.
- `agent` runs a bounded verifier agent with an explicit tool subset.

Command handlers return their result as JSON on stdout. HTTP handlers return it
as the response JSON body. Empty output means `allow` for ordinary hooks; termination gates require an explicit decision.

```json
{ "decision": { "action": "deny", "reason": "Protected path" } }
```

Supported decisions are `allow`, `deny`, `ask`, `defer`, `modify`, and `stop`.
For `tool:before`, `modify.data.input` replaces the proposed arguments before
normal authorization and schema validation. For `tool:after`,
`modify.data.result` replaces the normalized model-visible text.

## Failure and recursion

`timeoutMs` is bounded to five minutes and defaults to five seconds.
`onFailure: "continue"` records the failure and proceeds;
`onFailure: "block"` denies the operation. Hook-triggered invocations do not
trigger hooks again unless `allowRecursive` is explicitly enabled, and runtime
depth remains bounded.

Provider-executed native tools run outside Polpo's local executor. Their results
can be observed after the provider returns, but a controlling `tool:before`
hook requires a locally executed Polpo or Connection tool so the runtime can
enforce the decision before the side effect.

## Durable replay

Each event and matching hook produce a stable idempotency key. A durable host
stores the terminal execution together with the complete, redacted controlling
decision. When a Run resumes, the runtime reuses that decision and does not
execute or trace the completed handler again. HTTP endpoints and other
side-effecting handlers must still honor the supplied idempotency key because a
process can crash after the external effect succeeds but before its terminal
record is stored.

## Termination gate: validate and repair in the same agent

This opt-in extends `turn:stop`; ordinary stop hooks keep their existing behavior.
Configure a deterministic validator and explicit cumulative limits:

```json
{
  "version": 1,
  "name": "quality",
  "hooks": [{
    "id": "site-ready",
    "event": "turn:stop",
    "matcher": { "steps": ["implement"] },
    "terminationGate": { "maxCycles": 3, "maxDurationMs": 300000, "maxTokens": 60000 },
    "onFailure": "block",
    "handler": { "type": "tool", "tool": "site_validate", "timeoutMs": 60000 }
  }]
}
```

The validator returns one of these results:

```json
{ "decision": { "action": "continue", "feedback": { "valid": false, "failures": [{ "phase": "build", "file": "src/app.ts", "diagnostic": "Missing import" }] } } }
```

```json
{ "decision": { "action": "allow" } }
```

`continue` reopens the operational phase of the **same invocation**, with its authorized
tools, history, sandbox and working copy. Diagnostics are model-visible JSON; the candidate
is available at `hook.data.candidate`, alongside `terminationAttempt` and `correctionCycle`.
The rejected final response is buffered, then replaced by the validated result. Structured
output still uses the separate tool-free formatting phase; validation can return the agent
to work before a new final output is produced. Tool/progress events remain observable.
Remove the `steps` matcher to apply the pack to chat as well as Loop nodes. Validators use
the same authorized tool executor; include the validation tool in the applicable tool policy.

`maxCycles` is the number of allowed repairs (1–20); `maxDurationMs` is elapsed time from
invocation start (at most one hour); `maxTokens` bounds reported agent/compaction tokens
(at most 10 million). Agent maxTurns is an additional cumulative limit. Multiple matching
gates use the strictest limits. Budgets survive checkpoints and cannot be loosened by
resuming. Input tokens already processed by a provider cannot be preempted; the next output
is capped and over-budget usage stops execution. Nested tool/model costs are separate.
Validators themselves must be deterministic `command`, `http`, `tool` or `mcp_tool`
handlers, bounded by timeout. Prompt/verifier-agent hooks remain available outside a gate.

Empty output, missing decisions, invalid feedback, timeouts and checkpoint-write failures
**fail closed**, even if `onFailure` says continue. `stop` with non-empty string feedback
is a compatibility form of `continue` inside a gate. `continue` outside a configured gate
is rejected. Diagnostics remain subject to the hook contract's redaction and size limits.

Durable Run chat and sequential Project Loop nodes persist history, cumulative budgets,
step-invocation identity and pending/accepted validation together. A recorded validation
decision is replayed without rerunning its handler. An accepted checkpoint returns its
stored result without inference or rebilling previous usage. An interruption during a
model/tool operation is marked `termination_gate_effect_unconfirmed`: it requires
reconciliation and never blindly repeats the operation. Validators must honor their
idempotency key because an external effect can precede its ledger write.

Direct HTTP chat supports continuation during the request, but has no crash-resume promise.
Parallel graph branches do not yet have individual durable checkpoints: a durable gate in
such a branch is rejected before inference. Client-tool handoff remains a handoff and does
not count as successful termination. Existing public Project Loop approval-resume rules
remain unchanged; this feature does not introduce a new retry endpoint.

Errors use `termination_gate_*` codes, including `cycles_exhausted`, `turns_exhausted`,
`time_exhausted`, `tokens_exhausted`, `usage_unknown`, `checkpoint_invalid`,
`checkpoint_too_large`, `effect_unconfirmed`, `parallel_unsupported` and `rejected`.
Traces distinguish validating, continuing and accepted, with stable hook execution IDs.

In Cloud, `runtime.termination-gate.mode` and `runtime.hooks.mode` must both enforce for
the target project/environment. Default gate rollout is off. A configured gate whose rollout
or handler is disabled blocks execution instead of silently removing validation.
Inspect `polpo hooks capabilities --json`: portable `terminationGate` states contract
support; `managed.terminationGate.enabled` states availability on the target.
Author packs under `.polpo/hooks`, run `polpo hooks validate`, then deploy normally.
