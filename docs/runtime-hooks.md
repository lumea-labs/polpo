# Runtime Hooks

Runtime Hooks use the Claude Code hooks contract. A hook written for Claude
Code moves to a Polpo project without changes: the same event names, matcher
groups, handler fields, JSON on stdin, exit codes, JSON output fields and
blocking behavior. The reference baseline is the Claude Code hooks
documentation as published on 2026-10-24 (`claude-code-hooks@2026-10-24`).

The same hooks run for direct chat, Run-backed chat, Channels, task runs and
agent nodes inside Project Loops.

Hooks do not replace tool policy, approvals, Connections, guardrails or schema
validation. An `allow` decision cannot grant a capability the agent does not
have, and `updatedInput` passes through the normal schema checks again.

## Project layout

A pack is a named file holding an unchanged Claude Code `hooks` object:

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
  "name": "quality",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/block-rm.sh",
            "args": []
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "./scripts/validate.sh", "timeout": 120 }
        ]
      }
    ]
  }
}
```

Assign packs to an agent by name:

```json
{ "name": "support", "hooks": ["quality"] }
```

Import the `hooks` block of an existing Claude Code settings file:

```bash
polpo hooks import .claude/settings.json --name quality
polpo hooks validate
```

`polpo deploy` uploads packs before the agents that reference them. The
removed array format (`{ "version": 1, "hooks": [{ "id", "event", "handler" }] }`)
is rejected with a validation error.

## Tools as hooks see them

Hooks observe Polpo's workspace tools with their Claude Code names and
argument spellings, so matchers like `Bash` or `Edit|Write` and scripts that
read `.tool_input.file_path` work unchanged:

| Polpo tool | Hook `tool_name` | `tool_input` |
| --- | --- | --- |
| `bash` | `Bash` | `command`, `timeout` |
| `read` | `Read` | `file_path` (absolute), `offset`, `limit` |
| `write` | `Write` | `file_path`, `content` |
| `edit` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `glob` | `Glob` | `pattern`, `path` |
| `grep` | `Grep` | `pattern`, `path`, `glob` |
| `search_web` | `WebSearch` | as called |
| MCP tools | `mcp__<server>__<tool>` | as called |
| any other tool | its own name | its own arguments |

`updatedInput` uses the same shape and is mapped back before the tool runs.

## What runs where

Every reference event is accepted in configuration. The portable runtime fires
these lifecycle boundaries (`GET /v1/hooks/capabilities` reports the exact set
for a host):

| Event | Polpo boundary |
| --- | --- |
| `SessionStart` | start of each agent invocation (`startup`, or `resume` for a continued chat) |
| `UserPromptSubmit` | the submitted user message, or a Loop node's step input |
| `PreToolUse` | immediately before a tool's side effect, including deterministic Loop tool steps |
| `PostToolUse` / `PostToolUseFailure` | after the tool result, before the model sees it |
| `PostToolBatch` | after every tool call of a model step resolved, before the next model call |
| `Stop` | the agent produced a terminal answer |
| `StopFailure` | the turn ended on a provider/API error (instead of `Stop`) |
| `PreCompact` / `PostCompact` | automatic context compaction |
| `PostModelSwitch` | automatic provider fallback (`source: "auto"`) |
| `FileChanged` | a watched file written by a workspace tool |
| `SessionEnd` | end of the invocation (`reason: "other"`) |

Events without a Polpo counterpart yet (subagents, teams, tasks, MCP
elicitation, worktrees, configuration and display events) are accepted and
never fire. Polpo graph orchestration has no Claude Code lifecycle
equivalent; deterministic tool steps are tool calls and agent nodes run the
full agent lifecycle above.

The common input carries `session_id`, `cwd`, `permission_mode`,
`hook_event_name`, `agent_type` and, namespaced so Claude-style scripts ignore
it, a `polpo` object with `run_id`, `turn_id`, `loop`, `step` and `surface`.

## Stop: same-agent continuation

A Stop hook validates the terminal answer before it is committed or streamed.
`decision: "block"` with a `reason`, exit code 2 with stderr, or
`hookSpecificOutput.additionalContext` feeds that text back to the same agent
as `Stop hook feedback`. The agent keeps its conversation, tools, sandbox and
working copy, fixes the problem and tries again; the next Stop input has
`stop_hook_active: true`. The rejected candidate is replaced, never appended.

Eight consecutive continuations are allowed; the next block is overridden and
the turn ends. A real tool call resets the count. Max turns, cancellation and
any explicit budget remain hard limits. Durable Loop nodes and Runs checkpoint
the candidate, the continuation count and the validation receipts, so a resume
never runs the model, the tools or a completed hook again.

## Handler hosts

- `command`: the event JSON is written to stdin; exec form when `args` is set,
  `sh -c` otherwise. Commands run in their own process group, which is killed
  at the timeout. In managed runtimes they run inside the agent's sandbox.
- `http`: the event JSON is POSTed; the response follows the reference
  (2xx empty or JSON object). Destinations must resolve to public addresses,
  the connection is pinned to the validated address and redirects are not
  followed.
- `mcp_tool`, `prompt` and `agent` handlers are accepted in configuration; a
  host that cannot run them reports a hook error (never a silent success),
  which `onFailure: "block"` turns into a block.

## Limits and safety

- Matchers that are regular expressions are rejected at deploy time when they
  contain nested quantifiers (catastrophic backtracking).
- Captured output is bounded; strings over 10,000 characters are truncated
  to a 2,000-character preview as in the reference.
- Hook executions are recorded with a stable key per occurrence; replaying a
  durable Run reuses the recorded outcome instead of running the hook again.
