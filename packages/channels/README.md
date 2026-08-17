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

Applications that map provider users to their own identity can resolve that
identity before Polpo selects an agent, creates a Session, or calls a model:

```ts
const handleTurn = createConversationChannelTurnHandler(serverDeps, {
  agent: (turn) => resolveAgentForInstallation(turn.installationId),
  resolveInvocation: async (turn) => {
    const resolution = await resolveApplicationIdentity(turn);
    if (resolution.kind === "pairing") {
      return { disposition: "consume", reply: resolution.reply };
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
