# @polpo-ai/core

Pure business logic, types, schemas, and store interfaces for the [Polpo](https://github.com/lumea-labs/polpo) AI agent orchestration framework.

## Installation

```bash
npm install @polpo-ai/core
```

## Agentic loops

Use `defineProjectLoop` for code-first loop definitions that compile to the same JSON-compatible contract used by the API, CLI, dashboard, and runtime:

```ts
import { defineProjectLoop } from "@polpo-ai/core/loop-code";

export default defineProjectLoop({
  version: "1",
  kind: "graph",
  name: "support-flow",
  context: "shared",
  permissions: [
    {
      id: "support-tools",
      resource: "tool",
      action: "call",
      effect: "allow",
      match: { tool: ["read", "search_docs"] },
    },
    {
      id: "refund-approval",
      resource: "tool",
      action: "call",
      effect: "approval",
      match: { tool: "issue_refund" },
      message: "Refunds require human approval.",
    },
  ],
  start: "triage",
  steps: {
    triage: {
      type: "agent",
      systemPrompt: "Classify the support request.",
      tools: ["read"],
      next: "end",
    },
  },
});
```

Runtime hosts can persist governance/audit data by wiring `LoopRunStore`:

```ts
import { MemoryLoopRunStore } from "@polpo-ai/core/loop-run-store";

const loopRunStore = new MemoryLoopRunStore();
```

`PipelineExecutor` emits typed `LoopPermissionDeniedError`, `LoopPermissionApprovalRequiredError`, `LoopPolicyDeniedError`, and `LoopApprovalRequiredError`, plus structured trace events such as `permission.result`, `policy.result`, and `approval.required`. Hosts can map those records to audit logs, approval queues, compliance dashboards, or their own GRC surface.

## License

Apache 2.0
