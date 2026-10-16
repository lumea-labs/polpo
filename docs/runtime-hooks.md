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
as the response JSON body. Empty output means `allow`.

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
