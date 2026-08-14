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
  sandbox: {
    isolation: "fresh",
    volumes: [{ name: "reference", access: "read-only" }],
    lifecycle: {
      onRelease: "pool",
      stopAfterIdleMinutes: 30,
      deleteAfterStopMinutes: 60,
    },
  },
  guardrails: { policyPack: "strict" },
});

const store = new PolpoStore();
// Pass SSE events to store.applyEvent(event).
const latestPlan = store.getSnapshot().latestRuntimePlanId;
```

With `sandbox.isolation: "fresh"`, Polpo acquires one clean sandbox for the
outer completion. Deterministic tools and nested Agentic Loop steps share its
filesystem until that completion finishes. Allocation and release are
independent: `lifecycle.onRelease` either returns the sandbox to the
project-scoped pool or destroys it. Pooled sandboxes can be stopped after
`stopAfterIdleMinutes` and deleted after another `deleteAfterStopMinutes`.
The deprecated `idleTtlMinutes` field remains accepted on its own for older
clients, but cannot be mixed with the explicit controls.

Use `sandbox.isolation: "shared"` only when concurrent outer runs are intended
to collaborate in one project-scoped workspace. `reuse` remains exclusive and
only makes the sandbox available to another run after release.

`sandbox.volumes` selects host-defined persistent volumes by name. The request
may remove an agent grant or narrow it to `read-only` or manual writeback, but
cannot add an ungranted volume, change its strategy, or choose a host mount
path. The only provider-neutral strategies are `mounted` and `hydrated`;
strategy and storage credentials are resolved by the runtime host.

`runtime:plan` SSE payloads can be narrowed with
`isRuntimePlanSSEEvent`. The store indexes valid, secret-free plans by id and
retains malformed raw events only in its bounded diagnostics history.

Runtime context accounting types are exported from the SDK and originate from
`@polpo-ai/core/runtime-inspection`, so managed and self-hosted inspectors use
the same categories.

## Structured outputs

Use the OpenAI-compatible `response_format` field when the final assistant
message must contain validated JSON:

```ts
const response = await client.chatCompletions({
  agent: "support",
  messages: [{ role: "user", content: "Classify this customer." }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "customer_tier",
      strict: true,
      schema: {
        type: "object",
        properties: {
          tier: { type: "string", enum: ["free", "paid"] },
        },
        required: ["tier"],
        additionalProperties: false,
      },
    },
  },
});

const result = JSON.parse(response.choices[0].message.content ?? "{}");
```

The same request works with `chatCompletionsStream`. Polpo buffers the
structured value until it is complete and schema-valid, then emits one
canonical JSON content chunk. Existing text requests are unchanged.

## Chat interactions

Enable only interactions your client can render:

```ts
const response = await client.chatCompletions({
  agent: "support",
  messages: [{ role: "user", content: "Help me configure this" }],
  polpo: {
    capabilities: {
      ask_user_question: true,
      suggestions: true,
    },
  },
});

for (const suggestion of response.polpo?.suggestions ?? []) {
  console.log(suggestion.label, suggestion.prompt);
}
```

For streaming requests, `ChatCompletionStream.suggestions` contains the latest
validated suggestions after the stream completes. Each item has only `id`,
`label`, and the exact `prompt` to send as the next user message. The React
`useChat` hook requests both supported interactions, exposes `suggestions`, and
stores them on the assistant message that produced them.

## Steer an active run

Start a streaming chat request before iterating it to read the active run id
from the response headers, then send steering through the authenticated API:

```ts
const stream = client.chatCompletionsStream({
  agent: "builder",
  messages: [{ role: "user", content: "Create the dashboard" }],
});

await stream.start();
if (!stream.runId) throw new Error("This execution does not support steering");

await client.steerRun(stream.runId, {
  id: crypto.randomUUID(),
  mode: "steer",
  content: {
    text: "Use the attached reference for the next revision.",
    attachments: [{
      type: "image",
      url: "https://example.com/reference.png",
      mediaType: "image/png",
    }],
  },
});

for await (const chunk of stream) {
  // Consume the response normally.
}
```

Use `mode: "follow_up"` to run the message only after the current work would
otherwise stop. Use `client.abortRun(stream.runId, "Cancelled by user")` for a
server-side cancellation; `stream.abort()` only closes the caller's HTTP
stream. Steering is available on Run-backed execution and never interrupts an
individual tool call in progress.
