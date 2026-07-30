# @polpo-ai/sdk

Typed HTTP, SSE, and reactive-store client for Polpo.

```ts
import {
  PolpoClient,
  PolpoStore,
  isRuntimePlanSSEEvent,
} from "@polpo-ai/sdk";

const client = new PolpoClient({ baseUrl: "http://localhost:3890" });

await client.chatCompletions({
  agent: "support",
  messages: [{ role: "user", content: "Check this order" }],
  model: "openai/gpt-5",
  sandbox: { isolation: "fresh" },
});

const store = new PolpoStore();
// Pass SSE events to store.applyEvent(event).
const latestPlan = store.getSnapshot().latestRuntimePlanId;
```

`runtime:plan` SSE payloads can be narrowed with
`isRuntimePlanSSEEvent`. The store indexes valid, secret-free plans by id and
retains malformed raw events only in its bounded diagnostics history.

Runtime context accounting types are exported from the SDK and originate from
`@polpo-ai/core/runtime-inspection`, so managed and self-hosted inspectors use
the same categories.
