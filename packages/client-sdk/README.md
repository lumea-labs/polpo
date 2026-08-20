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

## Continue after an SSE disconnect

Durable delivery is opt-in. Existing requests retain cancel-on-disconnect
behavior. Set `polpo.delivery.onDisconnect` to `continue` when execution must
outlive the current SSE subscriber:

```ts
const stream = client.chatCompletionsStream({
  agent: "builder",
  messages: [{ role: "user", content: "Build and test the application" }],
  polpo: { delivery: { onDisconnect: "continue" } },
});

stream.subscribeConnectionState((state) => {
  // streaming | reconnecting | closed
  console.log(state);
});

for await (const chunk of stream) {
  console.log(chunk.choices[0]?.delta.content ?? "");
}
```

The initial response includes `x-polpo-run-id`; each persisted frame has an SSE
`id`. The SDK reconnects to `GET /v1/runs/{runId}/events` from the last complete
cursor and never repeats the creation request. Invalid and ahead cursors fail
explicitly; hosts with bounded event retention also reject expired cursors.

Use the stream controls deliberately:

- `stream.detach()` closes only this subscriber; a durable run continues;
- `await stream.cancel(reason)` requests idempotent server-side cancellation;
- `stream.abort()` keeps its historical cancel meaning;
- `stream.resume({ after })` explicitly reattaches an existing stream.

Canonical events are also available without the chat projection:

```ts
for await (const event of client.streamRunEvents(runId, { after: lastEventId })) {
  console.log(event.sequence, event.type, event.data);
}
```

Self-hosted SQLite and PostgreSQL persist replay events and cancellation state.
The file-storage fallback keeps them only in process memory, so it survives a
subscriber disconnect but not a server restart.

## Activate skills per request

The management client can synchronize complete binary-safe skill bundles,
including `references/`, `scripts/`, and `assets/`:

```ts
const bundle = await client.getSkillBundle("frontend-design");
await client.putSkillBundle(bundle);
```

For project-local installation and assignment, use `polpo skills add` and
`polpo deploy`; these preserve the same complete bundle contract.

An agent can have several assigned skills while a caller explicitly applies
one or more of them to a single execution:

```ts
const response = await client.chatCompletions({
  agent: "builder",
  messages: [{ role: "user", content: "Build the settings page." }],
  polpo: {
    skills: ["frontend-design"],
  },
});
```

This is additive and ephemeral. The selected skill is prioritized for that
request, other skills assigned to the agent remain available, and the agent
configuration is not changed. Polpo rejects skills that are not assigned to
the effective agent or loop. Slash commands are a client-side convenience:
clients should translate `/frontend-design` into `polpo.skills` rather than
expecting the server to parse message text.

With the React SDK, pass the selection to the individual message:

```ts
await chat.sendMessage("Build the settings page.", {
  skills: ["frontend-design"],
});
```

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

## Client-side tools

Declare OpenAI-compatible tools on an individual direct-chat request when the
calling application, rather than Polpo, owns the action:

```ts
const response = await client.chatCompletions({
  agent: "leo",
  messages: [{ role: "user", content: "Configure commerce" }],
  tools: [{
    type: "function",
    function: {
      name: "configure_site_module",
      description: "Open the module configuration UI.",
      parameters: {
        type: "object",
        properties: { module: { type: "string" } },
        required: ["module"],
        additionalProperties: false,
      },
      strict: true,
    },
  }],
  tool_choice: "auto",
  parallel_tool_calls: false,
});

if (response.choices[0]?.finish_reason === "tool_calls") {
  const call = response.choices[0].message.tool_calls?.[0];
  // Execute call.function in the client, then continue the same session with
  // the assistant tool-call message and a role=tool result message.
}
```

Polpo never invokes request-scoped tools on the server. A client-side call is
returned atomically; mixed or parallel calls fail closed. Project Loops do not
accept request-scoped client tools.

To use a client result as the deterministic handoff into a Project Loop, start
the direct request as a stream and retain its tool call plus response metadata:

```ts
const direct = client.chatCompletionsStream({
  agent: "leo",
  messages: [{ role: "user", content: "Create a booking site" }],
  tools: [{
    type: "function",
    function: {
      name: "configure_site_module",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  }],
  parallel_tool_calls: false,
});

let toolCallId = "";
for await (const chunk of direct) {
  toolCallId = chunk.choices[0]?.delta.tool_calls?.[0]?.id ?? toolCallId;
}

const loop = client.continueWithToolResult({
  sessionId: direct.sessionId!,
  sessionVersion: direct.sessionVersion!,
  idempotencyKey: crypto.randomUUID(), // retain this value for retries
  agent: "leo",
  loop: "build-site",
  toolCallId,
  result: JSON.stringify({ module: "booking" }),
});

for await (const chunk of loop) {
  console.log(chunk.choices[0]?.delta.content ?? "");
}
```

The continuation sends exactly one OpenAI-compatible `role: "tool"` message.
Polpo validates it against the latest pending call, rebuilds history from the
session store, and starts one durable Loop run. Retry the same request with the
same idempotency key; a changed payload, stale version, wrong user/scope, or an
already-resolved call fails deterministically. The raw API requires
`x-session-id`, `Idempotency-Key`, `stream: true`, and
`polpo.delivery.onDisconnect: "continue"`.

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
stores them on the assistant message that produced them. When resuming a
session, `useChat` restores active suggestions only when that assistant message
is still the latest message; historical suggestions remain attached to their
original messages without being offered again after a newer user turn.

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
otherwise stop. Use `client.abortRun(stream.runId, "Cancelled by user")` for the
existing steering abort endpoint. On a durable completion, `stream.cancel()` is
the acknowledged cancellation API and `stream.detach()` is the local-only
transport operation. Steering is available on Run-backed execution and never
interrupts an individual tool call in progress.
