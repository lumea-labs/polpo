# @polpo-ai/core

Pure business logic, types, schemas, and store interfaces for the [Polpo](https://github.com/lumea-labs/polpo) AI agent orchestration framework.

## Installation

```bash
npm install @polpo-ai/core
```

## Agentic loops

Use `defineProjectLoop` for code-first loop definitions that compile to the same JSON-compatible contract used by the API, CLI, dashboard, and runtime. Project files can live in `.polpo/loops/*.ts`; `polpo deploy` sends the source to the server, which compiles it statically and persists canonical JSON.

```ts
import {
  agentStep,
  bash,
  defineProjectLoop,
  permission,
  requireTool,
  toolStep,
  when,
  otherwise,
} from "@polpo-ai/core/loop-code";

export default defineProjectLoop({
  name: "support-flow",
  hooks: {
    "loop:start": [bash("echo support loop started", { saveAs: "audit.start" })],
  },
  permissions: [
    permission({
      id: "support-tools",
      resource: "tool",
      action: "call",
      effect: "allow",
      match: { tool: ["read", "search_docs"] },
    }),
    permission({
      id: "refund-approval",
      resource: "tool",
      action: "call",
      effect: "approval",
      match: { tool: "issue_refund" },
      message: "Refunds require human approval.",
    }),
  ],
  start: "triage",
  steps: {
    triage: agentStep({
      label: "Triage",
      systemPrompt: "Classify the support request.",
      tools: ["read"],
      next: [when("triage.needsRefund == true", "refund"), otherwise("answer")],
    }),
    answer: agentStep({
      label: "Answer",
      tools: ["read", "search_docs"],
      toolChoice: requireTool("search_docs"),
      next: "end",
    }),
    refund: toolStep({
      label: "Issue refund",
      tool: "issue_refund",
      next: "end",
    }),
  },
});
```

Runtime hosts can persist governance/audit data by wiring `LoopRunStore`:

```ts
import { MemoryLoopRunStore } from "@polpo-ai/core/loop-run-store";

const loopRunStore = new MemoryLoopRunStore();
```

`PipelineExecutor` emits typed `LoopPermissionDeniedError`, `LoopPermissionApprovalRequiredError`, `LoopPolicyDeniedError`, and `LoopApprovalRequiredError`, plus structured trace events such as `permission.result`, `policy.result`, and `approval.required`. Approval errors include a resume continuation: the context bag, remaining steps, and previous node. Hosts can persist that on `LoopRunRecord.resume`, approve the gate, then resume from the checkpoint without rerunning completed steps.

Loop run states distinguish the gate lifecycle from execution:

- `awaiting_approval`: execution is paused at a policy/permission gate.
- `approval_approved`: the gate was approved and the run can be resumed.
- `resuming`: the runtime is executing from the saved checkpoint.
- `completed`: the resumed or original run finished.

## Runtime plans

Runtime hosts can resolve a serializable, immutable execution decision before
provider or tool setup:

```ts
import { createRuntimePlan } from "@polpo-ai/core/runtime-plan";

const plan = createRuntimePlan({
  surface: "channel",
  source: "channel",
  model: {
    selection: "openai/gpt-5",
    source: "agent",
  },
  tools: {
    exposure: "direct",
    allowed: ["search_docs"],
  },
});
```

Runtime plans contain policy decisions and references only. Prompts, messages,
provider headers, credentials, and retrieved private content do not belong in
the plan or its `runtime:plan` event.

## Typed Memory

Typed Memory is additive to the legacy markdown `MemoryStore`:

```ts
import {
  createMemoryItem,
  canAccessMemoryScope,
} from "@polpo-ai/core/memory";

const item = createMemoryItem({
  scope: { kind: "user", subjectId: "external-user-123" },
  kind: "preference",
  content: "Prefers concise answers.",
  provenance: { source: "explicit", actor: "user" },
});
```

Scopes never default to global access. User scopes refer to the host
application's external user, not a Polpo account member. The host owns its
project or organization boundary and passes only authorized dimensions to
`canAccessMemoryScope`.

The contract validates item lifecycle, provenance, expiry, and exact dedupe
identity. `InMemoryMemoryItemStore` adds authorized CRUD, deterministic lexical
search, token-budget selection, soft deletion, usage events, and fail-closed
write policy. Every operation requires a host-owned `namespace`, so external
user identifiers are never shared across project boundaries.

`FileMemoryItemStore` from `@polpo-ai/file-stores` is the local durable
reference adapter. It writes `memory-items.json` atomically and leaves the
existing markdown store untouched during migration.

The typed HTTP and model-tool surfaces are separate opt-ins:

- `memoryItemRoutes` in `@polpo-ai/server` receives a host-resolved
  `MemoryStoreContext`, so authentication, namespace, and external-user
  identity stay at the composition root.
- `createTypedMemoryTools` in `@polpo-ai/tools` returns only explicitly granted
  search, remember, update, or forget actions. Write scope and provenance are
  fixed by the host rather than supplied by the model.
- `PolpoClient` in `@polpo-ai/sdk` exposes typed list, create, search, update,
  and forget methods.

No typed Memory route or tool is mounted automatically, and this layer does not
inject retrieved items into prompts. Runtime retrieval is a separate opt-in.

## License

Apache 2.0
