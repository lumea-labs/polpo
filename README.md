<p align="center">
  <img src="https://polpo.sh/logo.svg" alt="Polpo" width="80" />
</p>

<h1 align="center">Polpo</h1>

<p align="center">
  The open backend for AI agents.
  <br />
  Define your agent, deploy it, and get a fully working API with memory, tools, sandboxing, completions — out of the box.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/polpo-ai"><img src="https://img.shields.io/npm/v/polpo-ai.svg" alt="npm" /></a>
  <a href="https://github.com/lumea-labs/polpo/actions/workflows/ci.yml"><img src="https://github.com/lumea-labs/polpo/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/lumea-labs/polpo/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue.svg" alt="Apache 2.0" /></a>
  <a href="https://discord.gg/6JHCYQHr"><img src="https://img.shields.io/discord/placeholder?label=discord" alt="Discord" /></a>
</p>

<p align="center">
  <a href="https://docs.polpo.sh">Docs</a> &middot;
  <a href="https://polpo.sh">Website</a> &middot;
  <a href="https://discord.gg/6JHCYQHr">Discord</a> &middot;
  <a href="https://github.com/lumea-labs/polpo/issues">Issues</a>
</p>

---

## What is Polpo?

Polpo is an open-source runtime for building, running, and managing AI agents. It provides the infrastructure layer so you can focus on what your agents do, not how they run.

- **Tasks** -- assign work to agents, track status, retry on failure
- **Missions** -- multi-step workflows with checkpoints and delays
- **Tools** -- filesystem, browser, HTTP, email, PDF, Excel, audio, images, vault
- **Completions** -- OpenAI-compatible `/v1/chat/completions` endpoint
- **Loops** -- beta project-level deterministic graphs assigned to agents
- **Real-time** -- SSE event streaming for live agent activity
- **Durable delivery** -- opt-in completion replay and reconnect after SSE loss
- **Storage** -- file (default), SQLite, or PostgreSQL via Drizzle
- **Assessment** -- built-in quality scoring with LLM review
- **Skills** -- reusable agent capabilities loaded from YAML playbooks
- **Dashboard** -- reusable v2 React views and a single-tenant self-host app
- **CLI** -- `polpo create`, `polpo dev`, `polpo deploy`
- **Agent-native Channels** -- configure Slack, Telegram, Discord, and WhatsApp through the SDK, CLI, or MCP without exposing provider secrets

## Quick start

```bash
npx polpo create
```

Scaffolds a new Polpo project (cloud + local) with an interactive wizard: pick an org, a project name, and a template. Link an existing project instead:

```bash
npx polpo link --project-id <id>
```

Install globally so `polpo` is on your PATH:

```bash
npm i -g @polpo-ai/cli
```

The local server starts on `http://localhost:3890`. Open the API at `/api/v1/health`.

### Programmatic usage

```typescript
import { Orchestrator } from "polpo-ai";

const orchestrator = new Orchestrator("./my-project");
await orchestrator.init();
await orchestrator.run();
```

## Packages

| Package | Description | npm |
|---------|-------------|-----|
| [`polpo-ai`](.) | Main package -- CLI, server, orchestrator | [![npm](https://img.shields.io/npm/v/polpo-ai.svg)](https://www.npmjs.com/package/polpo-ai) |
| [`@polpo-ai/core`](packages/core) | Pure business logic, zero Node.js deps | [![npm](https://img.shields.io/npm/v/@polpo-ai/core.svg)](https://www.npmjs.com/package/@polpo-ai/core) |
| [`@polpo-ai/drizzle`](packages/drizzle) | Drizzle ORM stores (SQLite + PostgreSQL) | [![npm](https://img.shields.io/npm/v/@polpo-ai/drizzle.svg)](https://www.npmjs.com/package/@polpo-ai/drizzle) |
| [`@polpo-ai/server`](packages/server) | Hono route factories (shared between OSS and cloud) | [![npm](https://img.shields.io/npm/v/@polpo-ai/server.svg)](https://www.npmjs.com/package/@polpo-ai/server) |
| [`@polpo-ai/sdk`](packages/client-sdk) | TypeScript client SDK | [![npm](https://img.shields.io/npm/v/@polpo-ai/sdk.svg)](https://www.npmjs.com/package/@polpo-ai/sdk) |
| [`@polpo-ai/react`](packages/react-sdk) | React hooks (TanStack Query + SSE) | [![npm](https://img.shields.io/npm/v/@polpo-ai/react.svg)](https://www.npmjs.com/package/@polpo-ai/react) |
| [`@polpo-ai/dashboard`](packages/dashboard) | Runtime dashboard views for OSS and managed hosts | [![npm](https://img.shields.io/npm/v/@polpo-ai/dashboard.svg)](https://www.npmjs.com/package/@polpo-ai/dashboard) |
| [`@polpo-ai/tools`](packages/tools) | Extended tool definitions | [![npm](https://img.shields.io/npm/v/@polpo-ai/tools.svg)](https://www.npmjs.com/package/@polpo-ai/tools) |
| [`@polpo-ai/vault-crypto`](packages/vault-crypto) | Encryption for vault secrets | [![npm](https://img.shields.io/npm/v/@polpo-ai/vault-crypto.svg)](https://www.npmjs.com/package/@polpo-ai/vault-crypto) |

## Architecture

```
@polpo-ai/core          Pure logic, types, state machine, store interfaces
    |
@polpo-ai/drizzle       SQLite + PostgreSQL store implementations
    |
polpo-ai                Node.js shell: orchestrator, CLI, Hono server, tools
    |
@polpo-ai/server        Shared Hono route factories
@polpo-ai/sdk           Client SDK (fetch + SSE)
@polpo-ai/react         React hooks wrapping the SDK
@polpo-ai/dashboard     Reusable v2 runtime views
```

Core contains zero Node.js dependencies. The shell (`polpo-ai`) wires concrete adapters: file stores, Drizzle stores, the LLM engine, and the HTTP server.

Core also exposes additive typed Memory contracts through
`@polpo-ai/core/memory`. Existing markdown Memory remains compatible while
hosts adopt scoped items and policy-backed stores. The default local typed
store persists independently in `.polpo/memory-items.json`.

Typed Memory remains opt-in at the composition root. Hosts can mount
`memoryItemRoutes` from `@polpo-ai/server`, expose only explicitly granted
actions with `createTypedMemoryTools` from `@polpo-ai/tools`, and use the typed
CRUD/search methods on `PolpoClient`. Merely creating a store does not mount
routes, add tools to a model, or inject Memory into a prompt.

Typed Memory listing also supports additive cursor pagination. The original
`MemoryItemStore.list()` and `PolpoClient.listMemoryItems()` return types remain
unchanged. Stores can implement `listPage()` for stable `(createdAt, id)`
keyset pagination, and clients can use `listMemoryItemsPage()` with the opaque
cursor returned by the HTTP API.

## Self-host with the dashboard

The repository includes a single-tenant dashboard host that keeps the runtime API key on the server. Start the production-oriented example with PostgreSQL:

```bash
cp docker/self-host/.env.example docker/self-host/.env
# Replace both secrets and provide AI_GATEWAY_API_KEY in docker/self-host/.env.
docker compose \
  --env-file docker/self-host/.env \
  -f docker/self-host/compose.example.yml \
  up --build --detach --wait
```

Open `http://localhost:3000`. The runtime is only exposed to the private Compose network; the dashboard proxies API and completion requests with `POLPO_API_KEY` server-side.

Use the deterministic, isolated verification stack before deploying changes:

```bash
pnpm test:self-host
```

That test creates disposable PostgreSQL storage, exercises authenticated REST and chat completion paths, renders the dashboard, and removes its containers and volumes when complete.

For Railway, deploy the runtime and dashboard as separate services and mount a runtime volume at `/app/workspace`; see [docker/railway/README.md](docker/railway/README.md).

## Storage

Polpo supports three storage backends:

```jsonc
// .polpo/project.json
{
  "settings": {
    "storage": "file"      // default -- JSON/MD files in .polpo/
    // "storage": "sqlite"  // better-sqlite3 via Drizzle
    // "storage": "postgres" // PostgreSQL via Drizzle
  }
}
```

## Tools

Agents get access to tools based on their configuration. Built-in tool groups:

- **System** -- bash, read, write, edit, glob, grep, memory
- **Browser** -- Playwright-based web automation
- **HTTP** -- fetch, download
- **Email** -- SMTP send, IMAP read/search
- **PDF** -- read, create, merge
- **Excel** -- read/write spreadsheets
- **Docx** -- read Word documents
- **Audio** -- STT/TTS (Deepgram, OpenAI Whisper, ElevenLabs)
- **Image** -- generation and analysis
- **Vault** -- encrypted secret management

## Project layout

New projects keep each agent in its own directory. The directory name is the
agent id, structured configuration lives in `agent.json`, and instructions
live in Markdown:

```text
.polpo/
├── project.json
├── agents/
│   └── support/
│       ├── agent.json
│       └── instructions.md
├── teams/
│   └── default.json
├── loops/
├── skills/
└── tools/
```

Existing aggregate `polpo.json`, `agents.json`, and `teams.json` projects stay
readable. Run `polpo migrate --dry-run` to validate a conversion, then
`polpo migrate` to write the directory layout. Migration retains the original
manifests as `*.v1.json` backups.

### Runtime skills

Runtime skills follow the [Agent Skills specification](https://agentskills.io/specification).
Each directory is a complete bundle: `SKILL.md` plus optional `references/`,
`scripts/`, `assets/`, and other files used by the skill.

```bash
# Add one skill from a registry repository and assign it locally.
polpo skills add owner/repository --skill frontend-design --agent builder

# Local custom bundles work the same way.
polpo skills add ./my-skill --agent builder

# Inspect, update, or deploy the project explicitly.
polpo skills list
polpo skills update frontend-design
polpo deploy
```

`polpo skills add` writes the complete bundle under `.polpo/skills/`, updates
the selected agents' `skills` arrays, and records source provenance in
`.polpo/skills.lock.json`. It does not deploy unless `--deploy` is present.
`polpo deploy` and `polpo pull` preserve all nested text and binary files.
Symlinks are rejected rather than followed outside the bundle.

Other local operations are available without the dashboard:

```bash
polpo skills assign frontend-design --agent builder
polpo skills unassign frontend-design --agent builder
polpo skills remove frontend-design
polpo skills update --all
```

Custom tools can keep host identity out of the model-visible parameter schema.
Declare a separate binding schema and map it only to immutable invocation
context paths:

```ts
import { Type } from "@sinclair/typebox";
import { defineTool } from "@polpo-ai/tools";

export default defineTool({
  name: "site_context_get",
  description: "Read the current user's site context.",
  parameters: Type.Object({}, { additionalProperties: false }),
  bindingsSchema: Type.Object({
    externalUserId: Type.String({ minLength: 1 }),
    tenantId: Type.String({ format: "uuid" }),
    grant: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  serverBindings: {
    externalUserId: { $context: "invocation.user" },
    tenantId: { $context: "invocation.metadata.tenantId" },
    grant: { $context: "invocation.metadata.grant" },
  },
  async execute(ctx) {
    // ctx.invocation and ctx.bindings are copied, deeply frozen, and validated.
    // None of these binding values are included in the model's tool arguments.
    return JSON.stringify({ tenantId: ctx.bindings.tenantId });
  },
});
```

`ctx.invocation` contains `requestId`, `runId`, optional `sessionId`, optional
`user`, `metadata`, and a `surface` (`chat`, `task`, `loop`, `schedule`, or
`channel`). Missing or invalid required bindings fail before tool code runs.

Custom tool entrypoints may import relative TypeScript, JavaScript, TSX, or JSON
modules kept under the same source directory. Both `polpo tools push <file>` and
`polpo deploy` collect that local dependency graph and upload it as one versioned
artifact. Bare package imports remain runtime dependencies. Computed dynamic
imports, symlinks, paths outside the tool directory, and path traversal are
rejected before upload. Existing single-file custom tools remain compatible.

## Loops Beta

Loops are project-level deterministic graphs stored in `.polpo/loops/*.json` or authored as static `.polpo/loops/*.ts` DSL files, then assigned from an agent's `agent.json`. This avoids duplicating loop definitions across agents: a loop has `name`, `context`, `start`, and `steps`; an agent has `assignedLoops` and optional execution routing.

Use `type: "tool"` for deterministic sandbox/tool actions without an LLM turn, and `toolChoice` on `type: "agent"` when the model should still reason but must use a tool. Secrets stay in Connections; loop JSON should only contain non-secret input, while custom tools resolve credentials with `ctx.connections`.

`.polpo/loops/router-flow.json`:

```jsonc
{
  "name": "router-flow",
  "context": "shared",
  "start": "clone_repo",
  "steps": {
    "clone_repo": {
      "type": "tool",
      "tool": "clone_repository",
      "input": {
        "repoUrl": "https://github.com/acme/app.git",
        "targetDir": "workspace/app"
      },
      "saveAs": "repo.clone",
      "next": "classify"
    },
    "classify": {
      "type": "agent",
      "systemPrompt": "Classify the incoming request.",
      "tools": ["read"],
      "skills": ["classification"],
      "output": {
        "schema": {
          "type": "object",
          "properties": {
            "route": { "type": "string" }
          }
        }
      },
      "stopWhen": { "expression": "classify.route != null" },
      "next": [
        { "when": "classify.route == 'answer'", "to": "answer" },
        { "to": "human_review" }
      ]
    },
    "answer": {
      "type": "agent",
      "systemPrompt": "Answer using the selected route.",
      "tools": ["write"],
      "toolChoice": { "mode": "required", "tool": "write" },
      "next": "end"
    },
    "human_review": {
      "type": "human",
      "output": {
        "schema": {
          "type": "object",
          "properties": {
            "decision": { "type": "string" }
          }
        }
      },
      "next": "end"
    }
  }
}
```

`.polpo/agents/router/agent.json`:

```jsonc
{
  "role": "Deterministic request router",
  "runtime": "polpo-runner",
  "assignedLoops": ["router-flow"]
}
```

The agent's system instructions belong in
`.polpo/agents/router/instructions.md`.

Loop guards use Polpo's safe expression evaluator instead of JavaScript `eval` or `new Function`. Step outputs are available in the shared context bag by step id or `saveAs` path, e.g. `classify.route`, `review.approved`, or `timing.start`. `saveAs` writes context data; it does not create shell variables inside later `bash` commands. The OSS surface validates and round-trips the contract through core types, API schemas, SDK types, `polpo deploy`, and `polpo pull`.

Loops also have first-class governance fields:

- `permissions`: readable allow/deny/approval rules for resources such as `tool`, `step`, `model`, `human`, and `loop`. Use this for least-privilege runtime constraints beyond an agent's broad tool assignment.
- `policies`: expression-based gates for advanced compliance rules.
- `hooks`: deterministic tool actions at lifecycle points such as `loop:start`, `tool:before`, `tool:after`, and `loop:end`.
- `loop_trace`: durable runtime events including `permission.result`, `policy.result`, `approval.required`, tool calls, transitions, and step outcomes.

When a permission or policy requires approval, the runtime stores a checkpoint on the loop run. Approving the gate moves the run to `approval_approved`; `POST /loop-runs/:id/resume` continues from the saved context and remaining steps without replaying completed steps.

You can also keep loops as static TypeScript source. The CLI validates the file locally, deploys the source to `/v1/loops`, and the server compiles it to the same canonical JSON contract without executing arbitrary code:

```ts
// .polpo/loops/router-flow.ts
import { agentStep, defineProjectLoop, requireTool, toolStep, when, otherwise } from "@polpo-ai/core/loop-code";

export default defineProjectLoop({
  name: "router-flow",
  permissions: [
    {
      id: "router-tool-allowlist",
      resource: "tool",
      action: "call",
      effect: "allow",
      match: { tool: ["read", "write"] }
    }
  ],
  start: "classify",
  steps: {
    classify: agentStep({
      label: "Classify",
      systemPrompt: "Classify the incoming request.",
      tools: ["read"],
      next: [when("classify.route == 'answer'", "answer"), otherwise("end")],
    }),
    answer: agentStep({
      label: "Answer",
      systemPrompt: "Answer using the selected route.",
      tools: ["write"],
      toolChoice: requireTool("write"),
      next: "audit",
    }),
    audit: toolStep({
      label: "Audit",
      tool: "audit_log",
      input: { flow: "router" },
      next: "end",
    }),
  },
});
```

CLI support:

```bash
polpo loops validate
polpo loops compile .polpo/loops/router-flow.ts
polpo deploy   # deploys .json as JSON and .ts/.js/.mjs as source
```

### Steer active runs

Run-backed chat completions expose their active run id in the
`x-polpo-run-id` response header. A caller can use that id to add information
while the run is working or to queue a follow-up without interrupting a tool
halfway through execution:

```ts
import { PolpoClient } from "@polpo-ai/sdk";

const polpo = new PolpoClient({
  baseUrl: "http://localhost:3890",
  apiKey: process.env.POLPO_API_KEY,
});
const stream = polpo.chatCompletionsStream({
  agent: "builder",
  messages: [{ role: "user", content: "Build the application" }],
});

await stream.start();
if (!stream.runId) throw new Error("Run steering is unavailable");

await polpo.steerRun(stream.runId, {
  id: crypto.randomUUID(),
  mode: "steer",
  content: { text: "Use PostgreSQL and keep the existing visual system." },
});

for await (const chunk of stream) {
  // Render the normal OpenAI-compatible stream.
}
```

`steer` is delivered before the next model invocation at a safe boundary.
`follow_up` waits until the run would otherwise finish and then starts another
turn. Messages may include HTTPS or data-URL image, audio, and file
attachments. Message ids are idempotency keys; retries with the same id do not
enqueue duplicate work. `abortRun(runId, reason)` cancels the same run-scoped
model and tool lifecycle. Steering never interrupts a tool call in progress.

Pending steering is included in durable turn checkpoints and survives resume.
The built-in OSS host keeps the active-run index in process; distributed hosts
should implement the same `SteeringRunRegistry` contract with a durable command
transport. Inline chat execution does not expose an active steering scope.

### Activate skills for one request

Callers can explicitly apply skills already assigned to the selected agent:

```json
{
  "agent": "builder",
  "messages": [{ "role": "user", "content": "Build the settings page." }],
  "polpo": {
    "skills": ["frontend-design"]
  }
}
```

The activation is additive and lasts only for that request. Other assigned
skills remain available, and no agent configuration is mutated. Polpo validates
the names against the effective direct-agent or loop skill set. Clients may
offer `/skill-name` shortcuts, but must map them to `polpo.skills`; the runtime
does not parse slash-prefixed message text.

### Structured outputs

The OpenAI-compatible `/v1/chat/completions` endpoint accepts
`response_format` for both non-streaming and streaming requests:

```bash
curl http://localhost:3890/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "support",
    "messages": [{ "role": "user", "content": "Return the customer tier as JSON." }],
    "response_format": {
      "type": "json_schema",
      "json_schema": {
        "name": "customer_tier",
        "strict": true,
        "schema": {
          "type": "object",
          "properties": {
            "tier": { "type": "string", "enum": ["free", "paid"] }
          },
          "required": ["tier"],
          "additionalProperties": false
        }
      }
    }
  }'
```

The validated object is returned as a canonical JSON string in
`choices[0].message.content`, matching the OpenAI chat-completions wire shape.
`{"type":"json_object"}` is also supported. Structured streaming is buffered
until the complete value is parsed and validated, then emitted in one content
chunk so clients never receive a partial invalid object. Tool calls may still
run before the final structured response. Project loop execution currently
rejects `response_format` explicitly instead of silently ignoring it.

### Chat interactions

Each agent can allow the built-in `ask_user_question` client tool and opt into
suggested next messages through its `chat` configuration:

```json
{
  "name": "support",
  "chat": {
    "allowUserQuestions": true,
    "suggestions": {
      "enabled": true,
      "maxItems": 3,
      "guidance": "Prefer concrete next actions."
    }
  }
}
```

A client declares the optional interactions it can render in the request:

```json
{
  "agent": "support",
  "messages": [{ "role": "user", "content": "Help me configure this" }],
  "polpo": {
    "capabilities": {
      "ask_user_question": true,
      "suggestions": true
    }
  }
}
```

Suggestions are returned as a namespaced extension and never alter the normal
OpenAI-compatible finish reason:

```json
{
  "polpo": {
    "suggestions": [
      {
        "id": "suggestion_...",
        "label": "Show an example",
        "prompt": "Show me a complete example."
      }
    ]
  }
}
```

Streaming requests receive the same root-level `polpo.suggestions` object in a
chunk immediately before the final `stop` chunk. Suggestions require both the
selected agent to opt in and `polpo.capabilities.suggestions: true`; generation
is bounded, tool-free, and fail-open. Structured outputs, failed or aborted
turns, pending client tools, empty responses, and channel turns do not generate
them. Agents without `chat` preserve the compatible defaults: questions are
allowed and suggestions are disabled.

### Schedules

Schedules are first-class, durable invocations stored in
`.polpo/schedules/*.json`. A schedule targets an existing agent, task,
channel, webhook, or a legacy mission:

```json
{
  "id": "daily-report",
  "name": "Daily report",
  "timing": {
    "kind": "cron",
    "expression": "0 9 * * *",
    "timezone": "Europe/Rome"
  },
  "invocation": {
    "surface": "agent",
    "agentName": "reporter",
    "input": { "prompt": "Prepare today's report." }
  },
  "policy": {
    "catchUp": "skip",
    "misfireGraceSeconds": 300,
    "maxConcurrency": 1
  }
}
```

`polpo deploy` validates every schedule before sending any of them, checks
locally-known agent, loop, and mission references, and previews the next
occurrence in the configured timezone. Mission-shaped schedule files remain
supported for the compatibility window and produce a migration warning.

The typed SDK exposes additive v2 methods without removing the legacy mission
helpers:

```ts
const schedule = await polpo.createScheduleV2(definition);
await polpo.pauseSchedule(schedule.id, {
  expectedRevision: schedule.revision,
});
const runs = await polpo.listScheduleRuns(schedule.id, { limit: 25 });
await polpo.triggerSchedule(schedule.id, {
  idempotencyKey: "manual-check-2026-07-28",
});
```

When a host enables `ScheduleService`, mission-shaped route requests are
translated into v2 schedules and no longer mutate `Mission` scheduling fields.
Hosts can import existing Mission-backed definitions idempotently before
cutover:

```ts
import { migrateLegacyMissionSchedules } from "@polpo-ai/server";

const report = await migrateLegacyMissionSchedules({
  service: scheduleService,
  missions: await missionStore.listMissions(),
  dryRun: true,
});
```

Run the same migration without `dryRun` after reviewing collisions and
ambiguous legacy states. Hosts that have not enabled `ScheduleService` retain
the old Mission scheduler during the announced compatibility window.

Agent-direct chat can target a loop explicitly:

```json
{
  "agent": "router",
  "loop": "router-flow",
  "metadata": { "projectRef": "project-123" },
  "messages": [{ "role": "user", "content": "Route this request" }]
}
```

At runtime, the selected project loop can narrow the effective prompt, tools, skills, model, reasoning, tool choice, and max turns per agent step. If a step omits `skills`, it inherits the agent-level `skills`. Project loop execution in chat completions uses the shared context graph: deterministic tool steps run first, store outputs in the context bag, and later agent steps receive that context as runtime data in their system prompt. Core keeps a compatibility normalizer for legacy inline `loops` + `pipeline` configs and ships a pure `PipelineExecutor` for sequential, tool, switch, parallel, and human nodes; hosts wire `runLoop`, `runTool`, and `handleHuman` callbacks to their concrete runtime.

Deterministic tool inputs can read typed request metadata without an LLM step:

```jsonc
{
  "type": "tool",
  "tool": "project_checkout",
  "input": {
    "projectRef": { "$context": "request.metadata.projectRef" },
    "createIfMissing": true
  },
  "saveAs": "checkout",
  "next": "end"
}
```

The runtime resolves exact `{ "$context": "path.to.value" }` markers recursively before validating the tool schema or executing the tool. Missing paths, malformed markers, and schema mismatches fail deterministically without running the tool. Static inputs remain unchanged, and strings are never interpolated, including Bash commands. Request context is read-only, stays out of model prompts and fallback output, and is retained by loop checkpoints and resumes.

Project loops also support governance fields:

```jsonc
{
  "version": "1",
  "kind": "graph",
  "name": "governed-build",
  "context": "shared",
  "hooks": {
    "loop:start": [
      { "tool": "unix_time", "saveAs": "timing.start" }
    ],
    "tool:after": [
      { "tool": "audit_step", "input": { "level": "info" }, "saveAs": "audit.last", "onError": "continue" }
    ],
    "loop:end": [
      { "tool": "unix_time", "saveAs": "timing.end" }
    ]
  },
  "policies": [
    {
      "id": "only-safe-tools",
      "hook": "tool:before",
      "effect": "allow",
      "when": "tool.name == 'read' || tool.name == 'grep' || tool.name == 'unix_time'"
    },
    {
      "id": "deny-shell",
      "hook": "tool:before",
      "effect": "deny",
      "when": "tool.name == 'bash'",
      "message": "bash requires an explicit build loop"
    }
  ],
  "start": "capture_start",
  "steps": {
    "capture_start": {
      "type": "tool",
      "tool": "unix_time",
      "saveAs": "timing.start",
      "next": "plan"
    },
    "plan": {
      "type": "agent",
      "systemPrompt": "Plan the work. Do not edit files.",
      "tools": ["read", "grep"],
      "next": "end"
    }
  }
}
```

Lifecycle hooks are deterministic tool actions run by the host runtime at `loop:start`, `step:before`, `model:before`, `tool:before`, `tool:after`, `step:after`, `loop:transition`, and `loop:end`. Hook `when` guards are evaluated against the shared context plus lifecycle payload such as `step.name`, `step.type`, `tool.name`, `tool.input`, and `transition.from/to`. Hook outputs are saved into the context bag with `saveAs`; `onError: "continue"` turns a failed hook into trace-only telemetry, while the default is fail-closed.

Policies are evaluated before hook actions at the same lifecycle point. `deny` fails the loop with `LoopPolicyDeniedError`, `approval` raises `LoopApprovalRequiredError`, and `allow` policies form an allow-list for that lifecycle point when at least one exists. If an allow-list is present and no allow rule matches, the loop is blocked.

When the host wires `LoopRunStore`, chat completions create durable loop runs, append every `loop_trace` event, and return `loop_run_id`. When the host also wires `ApprovalStore`, approval policies create a pending approval request and mark the loop run as `awaiting_approval` with `approvalRequestId`. The SDK exposes `getLoopRuns()` and `getLoopRun(id)` for audit/history surfaces. Streaming completions still emit each trace incrementally.

### Model profiles

Project-level model profiles let agents use stable semantic policies without
making legacy model strings ambiguous:

```jsonc
{
  "settings": {
    "modelProfiles": {
      "fast": "openai/gpt-4o-mini",
      "balanced": {
        "primary": "anthropic/claude-sonnet-4",
        "fallbacks": [{ "profile": "fast" }]
      }
    },
    "orchestratorModel": { "profile": "balanced" }
  }
}
```

Select profiles explicitly on an agent with `"model": { "profile": "balanced" }`.
Use `allowedModelProfiles` to narrow the root profiles that agent may select.
Profiles referenced inside an allowed profile inherit that root grant, so
project owners can evolve an alias without updating every assigned agent.
Plain strings such as `"openai"` or `"openai/gpt-4o-mini"` always remain
direct model IDs. Unknown profiles, cycles, disallowed root references, and
invalid fallback policies fail before provider execution.

Direct models and explicit aliases stay pinned. An agent participates in
project model routing only with the explicit opt-in
`"modelRouting": { "mode": "auto" }`; deterministic project rules run before
an optional bounded classifier, and neither path can select outside
`allowedModelProfiles`.

## SDK

### Client SDK

```typescript
import { PolpoClient } from "@polpo-ai/sdk";

const client = new PolpoClient({
  baseUrl: "http://localhost:3890",
});

const tasks = await client.getTasks();
const agents = await client.getAgents();
```

The SDK also exposes typed `runtime:plan` SSE events, runtime-plan selectors,
and the shared secret-free context accounting contract used by runtime
inspectors.

### React SDK

```tsx
import { PolpoProvider, useTasks, useAgents } from "@polpo-ai/react";

function App() {
  return (
    <PolpoProvider baseUrl="http://localhost:3890">
      <TaskList />
    </PolpoProvider>
  );
}

function TaskList() {
  const { tasks, createTask } = useTasks();
  // Real-time updates via SSE
  return <ul>{tasks.map(t => <li key={t.id}>{t.title}</li>)}</ul>;
}
```

## Development

```bash
git clone https://github.com/lumea-labs/polpo.git
cd polpo
pnpm install
pnpm build
pnpm test
```

### Project structure

```
src/                    Main package source
  adapters/             Node.js runtime adapters (engine, filesystem, shell)
  assessment/           Quality scoring and LLM review
  cli/                  Commander CLI commands
  core/                 Orchestrator wiring + re-exports from @polpo-ai/core
  server/               Hono HTTP server + routes
  stores/               File-based store implementations
  tools/                Tool implementations (browser, email, PDF, etc.)
packages/
  core/                 @polpo-ai/core -- pure business logic
  drizzle/              @polpo-ai/drizzle -- SQL store implementations
  server/               @polpo-ai/server -- shared Hono route factories
  client-sdk/           @polpo-ai/sdk -- TypeScript client
  react-sdk/            @polpo-ai/react -- React hooks
  dashboard/            @polpo-ai/dashboard -- reusable v2 views
  tools/                @polpo-ai/tools -- tool definitions
  vault-crypto/         @polpo-ai/vault-crypto -- encryption
examples/
  chat-app/             React chat app example
apps/
  dashboard/            Single-tenant Next.js dashboard host
docker/self-host/       Compose example and isolated E2E fixture
```

## Cloud

Polpo Cloud is the managed version at [polpo.sh](https://polpo.sh). It uses the same open-source core with managed infrastructure: Neon PostgreSQL, sandboxed execution, and a dashboard.

## License

[Apache 2.0](LICENSE) -- Lumea Labs
