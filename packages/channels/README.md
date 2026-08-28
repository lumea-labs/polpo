# @polpo-ai/channels

Provider-neutral messaging channels for the Polpo runtime, built on the official
Vercel Chat SDK adapters for Slack, Telegram, Discord, and WhatsApp.

The package owns transport concerns: webhook verification, provider event
normalization, deduplication, typing indicators, response delivery, attachments,
and provider message limits. Your host owns credentials, durable state, routing,
agent execution, sessions, billing, and rollout policy.

## Install

```bash
pnpm add @polpo-ai/channels ai
```

Node.js 20 or later is required.

## Runtime

```ts
import {
  ChannelRuntime,
  dispatchChannelWebhook,
  type ChannelInstallation,
} from "@polpo-ai/channels";

const runtime = new ChannelRuntime({
  handleEvent: async (event) => {
    if (event.type === "message") {
      return { text: `Received ${event.messages.length} message(s)` };
    }
    if (event.type === "action") {
      return { text: `Selected ${event.actionId}` };
    }
  },
});

async function resolveInstallation(
  routeKey: string | undefined,
): Promise<ChannelInstallation | null> {
  // Resolve an opaque route key to scoped credentials in your own store.
  return null;
}

export async function webhook(request: Request, provider: string, routeKey: string) {
  return dispatchChannelWebhook({
    provider,
    request,
    routeKey,
    resolveInstallation: ({ routeKey }) => resolveInstallation(routeKey),
    runtime,
  });
}
```

Never select an installation from an unverified workspace, chat, team, or phone
identifier contained in the request body. Resolve only an opaque route key from
the webhook URL, then let the official adapter verify the untouched request.

## Installations

Each installation has a stable `id` and a `credentialRevision`. Change the
revision whenever credentials rotate; the runtime will evict the old adapter.

```ts
const telegram = {
  id: "channel_123",
  provider: "telegram",
  credentialRevision: "sha256-of-secret-version",
  credentials: {
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,
  },
} as const;
```

Equivalent typed installation shapes exist for Slack, Discord, and WhatsApp.
Secrets stay in the host credential store and are never added to normalized
turns.

## Response delivery

Responses remain one logical provider message by default and are split only when
the provider hard limit requires it. Messaging products can opt into shorter,
semantic conversational messages per installation:

```ts
const installation = {
  // credentials, id, provider, and revision omitted
  responseDelivery: {
    style: "conversational",
    targetCharacters: 900,
    maxMessages: 6,
  },
};
```

The runtime prefers paragraphs, sentences, and whitespace, preserves the exact
output, never splits a Unicode surrogate pair, and always honors provider hard
limits. `maxMessages` is a conversational preference rather than permission to
truncate; additional technical segments are emitted when a provider limit makes
them unavoidable.

### Proactive delivery

Use the same official adapter outside a webhook to send scheduled work,
notifications, or operator-triggered messages. `post` targets a thread and
`postChannel` targets a channel. Both initialize the adapter, apply the same
response policy, and return every provider message ID created by segmentation.

```ts
const delivery = await runtime.post(
  installation,
  "whatsapp:PHONE_NUMBER_ID:15551234567",
  "Your report is ready.",
);

console.log(delivery.messages);
// [{ id: "wamid...", threadId: "whatsapp:PHONE_NUMBER_ID:15551234567" }]
```

Treat the call as successful only when it resolves. A returned message ID means
the provider accepted the send request; it does not by itself prove that the
recipient received or read the message.

## Durable state

The default state adapter is in-memory and is appropriate for local development
or one process. Production hosts should provide a shared `stateFactory` backed
by Redis or another atomic store so webhook deduplication, queues, subscriptions,
and locks work across replicas.

```ts
const runtime = new ChannelRuntime({
  stateFactory: (installation) => createRedisState(installation.id),
  handleTurn,
});
```

## Transport observability

Set `onEvent` to receive provider-neutral runtime, turn, delivery, and transport
coordination events. Queue, burst, and debounce lifecycle events include only
safe scalar details such as message ID, queue depth, skipped count, and reason;
locks, credentials, provider payloads, and media bytes are never emitted.

```ts
const runtime = new ChannelRuntime({
  handleTurn,
  onEvent: async (event) => audit.write(event),
});
```

Transport events use the `transport.message.*` namespace. Observability hooks are
isolated from execution: a logging or audit-store failure cannot fail a webhook,
agent turn, or provider delivery. Pass `logger` when Chat SDK diagnostic logging
is also required; Polpo defaults those diagnostics to `warn` while still emitting
typed transport events.

Hooks are best-effort and time-bounded. `observabilityTimeoutMs` defaults to one
second; a timed-out hook is temporarily suppressed so an unavailable audit store
cannot repeatedly delay webhook acknowledgement or agent execution.

## Events and native output

`handleEvent` receives a discriminated union for messages, slash commands,
actions, reactions, modal submit/close events, and dynamic option loads. This
keeps provider payloads available in `raw` while exposing a provider-neutral
contract for normal application logic.

Handlers can return `text`, files, a Chat SDK stream, or native
`PostableMessage` objects in `posts`. Native posts support cards, actions, and
other rich content without flattening it to text. Native posts cannot be mixed
with convenience output in the same result, which prevents duplicate delivery.

Use `channelProviderCapabilities(provider)` before exposing provider-specific
controls. The returned immutable matrix distinguishes native, partial, buffered,
fallback, file-fallback, and unsupported behavior.

## Event coordination

The runtime serializes turns for the same installation and thread in one process.
Distributed hosts can replace that behavior with `coordinateEvent` to implement
a durable active-run policy such as queueing, steering, or rejection:

```ts
const runtime = new ChannelRuntime({
  coordinateEvent: (event, execute) =>
    activeRuns.coordinate(event.installationId, event.threadId, execute),
  handleEvent,
});
```

Return `executed` after awaiting `execute()` exactly once. Return `queued`,
`steered`, or `rejected` without executing inline after durably recording that
decision. The runtime rejects contradictory dispositions and duplicate calls to
`execute()`. `coordinateTurn` remains available for hosts using the legacy
message-only handler.

## Polpo conversation bridge

`@polpo-ai/server` exports `createConversationChannelTurnHandler`. It maps a
normalized channel turn onto Polpo's canonical conversation runtime, keeps one
stable Session per external user and thread, loads bounded history, and supports
host-defined attachment resolution.

```ts
import { createConversationChannelTurnHandler } from "@polpo-ai/server";

const handleTurn = createConversationChannelTurnHandler(serverDeps, {
  agent: (turn) => resolveAgentForInstallation(turn.installationId),
  resolveAttachment: processChannelAttachment,
});
```

Attachment resolution runs after trusted identity resolution but before agent
selection, Session creation, history, or model work. The resolver receives the
immutable invocation context so a host can ingest provider media into its own
authoritative asset store and return only an opaque application reference:

```ts
resolveAttachment: async (attachment, { invocation, turn }) => {
  const asset = await assets.ingest({ attachment, invocation, turn });
  return { type: "text", text: `[attachment reference: ${asset.id}]` };
},
```

Do not expose provider credentials, temporary download URLs, or trusted grants
in the returned model content.

Read receipts and typing have separate lifecycle controls. Existing
`typingEnabled` remains compatible; new installations should use `activity`:

```ts
const installation = {
  // ...provider and credentials
  activity: {
    readReceipt: "immediate",
    typing: "before-delivery",
  },
};
```

`before-delivery` emits typing for progress and terminal delivery, rather than
at the start of a potentially long-running turn. Unsupported read receipts are
a provider capability no-op and never block execution.

Applications that map provider users to their own identity can resolve that
identity before Polpo selects an agent, creates a Session, or calls a model:

```ts
const handleTurn = createConversationChannelTurnHandler(serverDeps, {
  agent: (turn) => resolveAgentForInstallation(turn.installationId),
  resolveInvocation: async (turn) => {
    const resolution = await resolveApplicationIdentity(turn);
    if (resolution.kind === "pairing") {
      return {
        disposition: "consume",
        presentation: {
          text: resolution.reply,
          actions: [{
            id: "open-builder",
            label: "Open builder",
            type: "open_url",
            url: resolution.builderUrl,
          }],
        },
      };
    }
    return {
      disposition: "dispatch",
      user: resolution.userId,
      metadata: {
        tenantId: resolution.tenantId,
        siteId: resolution.siteId,
        grant: resolution.grant,
      },
    };
  },
});
```

A consumed turn may use the legacy text-only `reply` or a provider-neutral
`presentation`, but never both. Presentations are validated before delivery,
do not create a Session or invoke a model, and support the same `open_url` and
`postback` actions as Project Loop results.

### Channel tool policy

Channel turns can narrow the agent's tool ceiling at two levels. Configure
`agent.channels.allowedTools` for every messaging Channel using the agent, and
`allowedTools` on a Channel Route for one destination or route. The runtime
intersects both restrictions with `agent.allowedTools` and trusted grant policy
before exposing server or OpenAI-compatible client tool schemas to the model.

```ts
await channelManagement.upsertRoute(channelId, {
  agentName: "leo",
  allowedTools: ["ask_user_question", "site_context_get"],
  enabled: true,
  priority: 100,
});
```

With the CLI, repeat `--allowed-tool`:

```bash
polpo channels add whatsapp --agent leo \
  --allowed-tool ask_user_question \
  --allowed-tool 'site_context_*'

polpo channels routes add CHANNEL_ID --agent leo \
  --allowed-tool ask_user_question
```

The Route policy applies only to the current Channel turn. When a server-side
client tool explicitly continues into a Project Loop, Polpo recalculates the
effective set from the agent, Loop, step, request, and trusted grant policies.
It preserves the canonical Session and trusted identity but does not carry the
Route restriction into Loop execution.

### Server-side client tools

A channel host can execute an allowlisted client tool on behalf of a messaging
client, then continue the same Polpo Session either directly or in a fixed
Project Loop. The model cannot select the handler endpoint, credentials, or Loop.

```ts
const handleTurn = createConversationChannelTurnHandler(serverDeps, {
  agent: (turn) => resolveAgentForInstallation(turn.installationId),
  clientTools: [{
    type: "function",
    function: {
      name: "apply_site_change",
      description: "Apply a requested site change",
      parameters: {
        type: "object",
        properties: { instruction: { type: "string" } },
        required: ["instruction"],
        additionalProperties: false,
      },
      strict: true,
    },
  }],
  executeClientTool: async (execution) => {
    const { result, grant, workingCopyId } = await applicationTools.execute({
      idempotencyKey: execution.idempotencyKey,
      invocation: execution.invocation,
      sessionId: execution.sessionId,
      sessionVersion: execution.sessionVersion,
      toolCall: execution.toolCall,
    });
    return execution.toolCall.name === "apply_site_change"
      ? {
          result,
          loop: "site-change",
          acknowledgement: {
            text: "I am updating the site now. I will send the preview when it is ready.",
          },
          trustedMetadata: { grant, workingCopyId },
        }
      : { result };
  },
  maxClientToolContinuations: 4,
});
```

The bridge derives a stable idempotency key from the verified provider event and
tool call. The handler must treat repeated keys as the same operation. Each
continuation uses the canonical Session version, appends exactly one tool result,
and preserves trusted invocation identity and metadata. Handler-provided
`trustedMetadata` is merged into the immutable invocation context for the next
direct turn or Loop. It is never appended to the tool result or model history.
A configured Loop starts only after that atomic continuation succeeds.
When a Loop continuation includes `acknowledgement`, Channels validates and
delivers it before starting the Loop. Progress delivery is idempotent for the
provider event and is persisted in the canonical Session before continuation.
If the handler omits it, non-empty assistant content emitted alongside the
client-tool call is delivered instead.

Reject unknown tools before network or application work, bound the continuation
count, and fail closed on handler, authorization, or Session-version errors.
Cloud hosts can authenticate an HTTPS handler through a project Connection; the
handler request has this provider-neutral shape:

```json
{
  "version": 1,
  "idempotencyKey": "channel-tool:...",
  "channel": {
    "provider": "whatsapp",
    "installationId": "channel_id",
    "threadId": "whatsapp:phone:user",
    "providerEventId": "wamid..."
  },
  "session": { "id": "session_id", "version": 2 },
  "toolCall": {
    "id": "call_id",
    "name": "apply_site_change",
    "arguments": { "siteId": "site_id" }
  },
  "invocation": {
    "user": "stable_user_id",
    "metadata": { "tenantId": "tenant_id" },
    "scope": { "key": "workspace_id", "version": "3" }
  }
}
```

Return one JSON object containing `result` and optional host-trusted metadata:

```json
{
  "result": { "accepted": true },
  "acknowledgement": {
    "text": "I am updating the site now. I will send the preview when it is ready."
  },
  "trustedMetadata": {
    "grant": "short-lived-signed-grant",
    "workingCopyId": "working-copy-id"
  }
}
```

Project Loops can separate machine-readable output from Channel presentation:

```json
{
  "result": {
    "data": { "$context": "finalization" },
    "presentation": {
      "text": { "$context": "finalization.response" },
      "actions": [
        {
          "id": "preview",
          "type": "open_url",
          "label": "Open preview",
          "url": { "$context": "finalization.previewUrl" }
        }
      ]
    }
  }
}
```

`data` remains available as `loop_result` and on the persisted Loop run.
`presentation.text` is the user-visible completion; supported actions are
`open_url` and `postback`. Channels render them through Chat SDK cards and use
the adapter fallback on providers without native controls. Postback clicks
return as ordinary typed Channel action events and are not trusted bindings.

Hosts can reject a Channel turn after resolving its canonical Session by using
`resolveSessionDisposition`. This runs before history, model, Memory, or tools:

```ts
resolveSessionDisposition: async (_turn, sessionId) =>
  await hasActiveMutation(sessionId)
    ? { disposition: "consume", reply: "I am still completing the previous change." }
    : { disposition: "dispatch" },
```

Managed hosts expose the equivalent opt-in `activeRunPolicy`. Use Channel
concurrency `concurrent` for zero-delay rejection. A host that needs bounded
`burst` aggregation before the same check can mark the resolved installation
with `turnExecution: "background"`. The runtime then releases Chat SDK transport
coordination after the canonical burst is assembled, while the turn and its
delivery continue through the runtime background task set:

```ts
const runtime = new ChannelRuntime({
  handleTurn,
  waitUntil: (task) => executionContext.waitUntil(task),
});

const installation = {
  ...resolvedInstallation,
  concurrency: { strategy: "burst", debounceMs: 2_000 },
  turnExecution: "background",
};
```

Only hosts with authoritative Session/run coordination should enable this
mode. `shutdown()` and installation invalidation drain matching background
turns before disconnecting their adapters; execution failures remain visible
through `turn.failed` without converting an acknowledged webhook into a retry.

Cloud Channel configuration declares both the continuation policy and the
OpenAI-compatible function schema. The endpoint, Connection, Loop, and trusted
metadata remain server-controlled:

```json
{
  "clientToolHandler": {
    "version": 1,
    "type": "http",
    "endpoint": "https://app.example.com/polpo/client-tools",
    "connectionId": "conn_handler",
    "tools": {
      "apply_site_change": {
        "mode": "loop",
        "loop": "site-change",
        "description": "Apply a requested site change",
        "parameters": {
          "type": "object",
          "properties": { "instruction": { "type": "string" } },
          "required": ["instruction"],
          "additionalProperties": false
        },
        "strict": true
      }
    }
  }
}
```

Custom tools inside the Loop consume secrets through existing hidden bindings,
not model-visible arguments:

```ts
defineTool({
  name: "site_checkout",
  inputSchema: Type.Object({}),
  bindingsSchema: Type.Object({
    grant: Type.String(),
    workingCopyId: Type.String(),
  }),
  serverBindings: {
    grant: { $context: "invocation.metadata.grant" },
    workingCopyId: { $context: "invocation.metadata.workingCopyId" },
  },
  execute: async (_input, ctx) => checkout(ctx.bindings),
});
```

## Agent-native management

The CLI uses the same provider-neutral management contract as the HTTP API and
MCP. Credentials are referenced through project Connections and are never
accepted inline.

```bash
polpo channels add whatsapp \
  --agent leo \
  --connection conn_whatsapp \
  --destination 1234567890

polpo channels test channel_id --to 15551234567
```

WhatsApp provisioning remains pending until Meta successfully verifies the
callback challenge. The provisioning result includes the exact callback URL;
configure it in the Meta app with the verify token stored in the WhatsApp
Connection. A Channel is marked active only after that callback succeeds.

### Trusted identity resolver

Use a trusted resolver when the provider user must be mapped to an application
user, tenant, workspace, or grant before routing to an agent:

```bash
polpo channels add whatsapp \
  --agent leo \
  --connection conn_whatsapp \
  --destination 1234567890 \
  --identity-resolver-endpoint https://api.example.com/polpo/channel-identity \
  --identity-resolver-connection conn_resolver_bearer \
  --identity-resolver-timeout 3000
```

Polpo calls the HTTPS endpoint server-side with the Bearer token held by the
resolver Connection. The resolver output populates trusted invocation `user`
and `metadata`; inbound messages and models cannot override those bindings.
Use `polpo channels update CHANNEL_ID --disable-identity-resolver` to remove it.

`consume` returns directly to the provider and never enters model history.
`dispatch` supplies immutable trusted invocation identity to custom tools. The
resolver metadata is not copied into model-visible tool arguments or ordinary
Session metadata. A configured resolver must fail closed; do not fall back to
provider identity after resolver errors.

Chat SDK thread history is transport state. Polpo Sessions remain the canonical
conversation history used by the model.

## Self-hosted webhook routes

`@polpo-ai/node` can mount the runtime directly:

```ts
await server.start({
  channels: {
    runtime,
    resolveInstallation: async ({ routeKey }) => loadInstallation(routeKey),
  },
});
```

This exposes:

- `POST /v1/channel-webhooks/:provider/:routeKey`
- `POST /v1/channel-webhooks/:provider`

The route without a key is useful only when the resolver has another trusted,
host-controlled installation binding.

## WhatsApp Cloud API

Create a Meta app with the WhatsApp product and provision a Cloud API phone
number. A WhatsApp installation requires four server-side values:

```ts
const installation = {
  id: "channel_whatsapp_support",
  provider: "whatsapp",
  credentialRevision: "secret-version-1",
  credentials: {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    appSecret: process.env.WHATSAPP_APP_SECRET!,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  },
} as const;
```

Register an opaque installation URL in Meta, for example
`https://api.example.com/channels/whatsapp/<opaque-route-key>`. Route both the
GET verification challenge and signed POST notifications to
`dispatchChannelWebhook` without parsing or rewriting the body. Resolve the
opaque key to exactly one installation before the official adapter verifies the
request. Never route by a phone number or account ID taken from an unverified
payload.

## Agent-native Channel management

The webhook runtime and the management control plane are separate. A host can
expose Channel provisioning through the API, SDK, CLI, or MCP while all four
surfaces call the same `ChannelManagementService`.

```ts
import {
  ChannelManagementService,
  InMemoryChannelManagementStore,
} from "@polpo-ai/channels";

const channelManagement = new ChannelManagementService({
  store: new InMemoryChannelManagementStore(),
  agentExists: async (scope, agentName) => hasAgent(scope.projectId, agentName),
  connectionResolver: projectConnectionResolver,
  providerAutomation: channelProviderAutomation,
  secureSetup: secureBrowserHandoff,
});
```

The durable Drizzle implementation is exported as
`DrizzleChannelManagementStore` by `@polpo-ai/drizzle`. Self-hosted Node hosts
can mount the routes alongside the webhook runtime:

```ts
await server.start({
  channels: {
    runtime,
    resolveInstallation,
    management: {
      service: channelManagement,
      resolveScope: async (requestContext) => authenticatedProjectScope(requestContext),
    },
  },
});
```

The resulting management API is available under `/api/v1/channels`. Cloud
hosts expose the same contract under `/v1/channels`.

The resource model is intentionally explicit:

- a **Connection** stores project authorization and provider credentials;
- a **Channel** identifies an installed provider destination;
- a **Route** grants one agent access to that Channel;
- a **setup** is temporary state for authorization or provider-side steps.

Calling `configure` without a Connection never asks the model or CLI for a
secret. The host returns an expiring HTTPS setup URL and resumes the idempotent
operation after authorization. Public records and MCP results are redacted by
contract.

```bash
polpo channels providers
polpo channels add whatsapp --agent support
polpo channels setup-status <setup-id>
polpo channels list
polpo channels routes add <channel-id> --agent triage
```

Use `--connection <id>` when the project already has the required Connection.
Use `--json` for agentic or scripted callers. Destructive commands require an
interactive confirmation or `--yes` in non-interactive environments.

The adapter normalizes inbound text, replies, images, audio, video, and files.
Attachment bytes are fetched lazily through authenticated provider requests.
The host decides size limits, transcription, model input support, durable
Session routing, and retention. Duplicate webhook deliveries are suppressed by
the configured state adapter; use shared durable state in a multi-replica host.

WhatsApp's 24-hour customer service window and template approval rules still
apply. `ChannelRuntime.post` sends normal conversation content; approved
business-initiated templates are not part of the provider-neutral Polpo output
contract yet.

The Chat SDK WhatsApp adapter pinned by this release does not expose Meta
`statuses` notifications as normalized delivered/read/failed events. Therefore
`delivery.completed` means the provider accepted the send request, not that the
recipient received or read it. Do not use it as an authoritative delivery
receipt until the upstream adapter exposes that lifecycle.

## Provider behavior

- Streams are delegated to the official Chat SDK adapter. Slack streams
  natively, Discord and Telegram use their adapter-specific streaming strategy,
  and WhatsApp buffers until completion.
- Long non-streaming text is split at semantic boundaries without silently
  truncating output.
- Convenience output containing text and files is serialized into observable
  provider operations for Slack and WhatsApp. If a later upload fails after an
  earlier send succeeds, an exact webhook retry does not replay the agent turn
  and duplicate content that was already accepted.
- Typing indicator failures are observable but do not fail an agent turn.
- Inbound files remain lazy when the provider supports authenticated fetching.
- Discord HTTP interactions are supported by the official webhook adapter;
  Gateway-only event flows require a separate gateway process.
