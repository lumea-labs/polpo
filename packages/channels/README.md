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
  handleTurn: async (turn) => ({
    text: `Received ${turn.messages.length} message(s)`,
  }),
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

## Turn coordination

The runtime serializes turns for the same installation and thread in one process.
Distributed hosts can replace that behavior with `coordinateTurn` to implement a
durable active-run policy such as queueing or steering:

```ts
const runtime = new ChannelRuntime({
  coordinateTurn: (turn, execute) =>
    activeRuns.coordinate(turn.installationId, turn.threadId, execute),
  handleTurn,
});
```

The coordinator must call `execute()` exactly once to run and deliver the turn,
or deliberately absorb it after persisting a steering/queue decision.

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

## Provider behavior

- Slack supports native streamed replies when no files are attached.
- Telegram, Discord, and WhatsApp streams are buffered and split at semantic
  boundaries without silently truncating output.
- Typing indicator failures are observable but do not fail an agent turn.
- Inbound files remain lazy when the provider supports authenticated fetching.
- Discord HTTP interactions are supported by the official webhook adapter;
  Gateway-only event flows require a separate gateway process.
