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

## Model profiles

Model profiles give project configuration stable semantic names while keeping
provider model IDs out of agent definitions. Existing string values always
remain concrete model IDs. A profile is selected only with the explicit
`{ profile: "name" }` form.

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

Agents can select a profile and optionally narrow which profiles, including
nested references, they may use:

```jsonc
{
  "name": "support",
  "model": { "profile": "balanced" },
  "allowedModelProfiles": ["balanced", "fast"]
}
```

Resolution is recursive, deterministic, deduplicates concrete models while
preserving order, and fails closed for unknown profiles, cycles, invalid
allowlists, excessive depth, or too many fallbacks. The runtime resolves the
profile before provider setup; providers receive only concrete model IDs.

## Model routing

Model routing is optional automation over model profiles. The OSS router never
selects raw model IDs and never receives profile definitions, prompts,
conversation history, tool schemas, or credentials. Hosts inject a classifier
and keep the feature off until their own rollout policy enables it.

```ts
import {
  modelRouteRuntimePlanFields,
  resolveModelRoute,
} from "@polpo-ai/core/model-router";
import { createStructuredModelRouteClassifier } from "@polpo-ai/llm";

const route = await resolveModelRoute({
  surface: "agent",
  source: "request",
  input: "Summarize this short update.",
  profiles: settings.modelProfiles,
  config: {
    mode: "auto",
    fallbackProfile: "balanced",
    allowedProfiles: ["fast", "balanced"],
  },
}, {
  classifier: createStructuredModelRouteClassifier({ model: routerModel }),
  signal: request.signal,
});

const { model, audit } = modelRouteRuntimePlanFields(route);
```

Explicit authorized profiles skip classification. Disabled routing,
single-profile allowlists, missing input, and missing classifiers resolve
deterministically. Timeout, provider failure, malformed output, unknown
profiles, and low confidence use the configured fallback; caller cancellation
stops planning instead of starting execution with a fallback.

## Guardrails

Runtime hosts can opt into the shared ordered policy engine and wrap every
locally executed tool with the same middleware:

```ts
import {
  RuntimeGuardrailEngine,
  createDefaultToolGuardrailPolicies,
  createRunToolMiddleware,
} from "@polpo-ai/core/guardrails";

const middleware = createRunToolMiddleware(
  new RuntimeGuardrailEngine(createDefaultToolGuardrailPolicies(), {
    onDecision: async (event) => auditStore.append(event),
  }),
  {
    approval: async (request, decision) =>
      approvalStore.isApproved(request.callId, decision.policyId)
        ? "approved"
        : "denied",
  },
);
```

The middleware evaluates the actual arguments before dispatch, executes the
tool at most once, bounds its textual result, and evaluates that result before
it returns to model context. Policy failures fail closed for side-effecting or
unknown tools; read-only tools can use the explicit audit fallback.

Hosts provide policies, approvals, audit persistence, and rollout. No policies
are enabled automatically. Provider-executed tools and client-side tools are
declared to the model but execute outside the local runtime, so they require
provider/client enforcement rather than this middleware.

The Node host can explicitly enable the deterministic OSS pack for both
in-process and subprocess task runs:

```json
{
  "settings": {
    "guardrails": {
      "toolPolicyPack": "default",
      "maxToolOutputCharacters": 256000,
      "readOnlyPolicyFailure": "audit"
    }
  }
}
```

The setting is absent by default. `RunnerConfig` carries only this serializable
selection across process boundaries; approval and audit callbacks stay local
to the active host and are never persisted.

The deterministic private-network policy rejects literal private, loopback,
link-local, metadata, and reserved destinations. Hosts must still enforce
network egress after DNS resolution to prevent DNS rebinding and hostname
resolution from bypassing process-level policy.

## License

Apache 2.0
