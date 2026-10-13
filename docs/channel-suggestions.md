# Suggestions on messaging Channels

Version boundary: 0.17.1.

Channel hosts can opt into the same agent-owned suggestions used by web chat,
including the final result of a Project Loop. Agent `chat.suggestions.enabled`
and the host's capability must both allow generation. Questions stay disabled on
Channels. Existing installations remain unchanged unless the host opts in.

## Host integration

Set `suggestions: true` on both `ChannelRuntime` and the options passed to
`createConversationChannelTurnHandler`. The runtime option enables transport;
the bridge option controls capability negotiation and selection admission.
The latter can be an async resolver receiving `{ turn, invocation }`, returning
the existing boolean or suggestion-options contract. Resolve application context
and rollout from trusted host state. It is called again after each client-tool
execution, including before Loop continuations, with updated trusted metadata.

The completion drivers return `suggestionsSource: { assistantMessageId }` beside
suggestions (under `polpo` for HTTP/SSE). This identifies the exact persisted
assistant message. A custom `executeTurn` adapter must preserve both fields and
provide the canonical SessionStore; the bridge omits interactive controls if it
cannot verify the source. No database migration is needed.

The bridge returns only message-kind suggestions as `ChannelTurnResult.suggestions`
with their trusted source binding. Deterministic application action suggestions
are not converted into prompts. Existing Loop presentation links and application
postbacks retain their own handling.

## Delivery and selection

The answer is delivered through the ordinary text/media path, followed by a short
controls message. WhatsApp renders one to three choices as reply buttons and
four to ten as a list. The generator still defaults to three and accepts at most
five. The adapter rejects overflow rather than dropping choices. Labels are
shortened without splitting Unicode and disambiguated when necessary; stored
prompts remain unchanged. WhatsApp uses the official adapter's authenticated
transport, including a narrow typed extension for lists.

A provider callback contains a random 128-bit token and an item index, never a
prompt, Session ID, or application identity. Shared StateAdapter state binds it
to provider, installation, credential revision, thread, recipient, source answer,
and accepted outbound provider message. Buttons expire within 24 hours.
The untouched provider request is authenticated by its official adapter before
the runtime handles a selection. WhatsApp `context.id` must match the outbound
controls message; its incoming reply ID is not the source message ID.

After a successful atomic set claim, the selection becomes an ordinary message
turn through `handleTurn` or a `handleEvent` message event, with progress delivery
and normal coordination. The bridge resolves identity, route, Session, and scope
again. It requires the source answer to remain the latest canonical message and
compares ID, label, and exact prompt to persisted suggestions. It never creates
a new Session for an obsolete selection. Normal tool/Connection permissions
remain authoritative. A custom handler replacing the bridge must perform the
same canonical-source and current-identity checks on `turn.suggestionSelection`.

## Reliability and rollout

Use shared atomic StateAdapter storage for multiple replicas. MemoryStateAdapter
supports only a local process. Short state locks and an independent NX claim
ensure that even distinct concurrent clicks on one set dispatch at most once.
The claim remains spent after an uncertain outcome or process death. This can
lose a selection; it must not repeat an operation that may already have started.
An ordinary new user message remains possible.

There is no global transaction between StateAdapter, SessionStore, run admission,
and the messaging vendor. The bridge checks freshness again just before dispatch
inside the host's ordinary turn coordinator. Hosts must retain their existing
authoritative Session/run coordination. The check does not promise a global CAS
against writes from independent API calls, nor exactly-once tool execution.

Suggestion generation, projection, or controls-delivery failure leaves the main
successful result intact. Controls are enabled only after provider acceptance and
successful state activation. A failed activation can leave visible inert controls;
it cannot admit a selection from pending state or repeat the main operation.

The `polpo_suggestion:` namespace is reserved. Unknown, malformed, stale, and
disabled selections are rejected, never forwarded as application actions. The
guard remains active when `suggestions` is false. Keep it during rollback while
previously issued controls remain on devices; older binaries lacking this guard
are not a safe rollback target without an equivalent host ingress guard.

## Validation evidence

The OSS tests exercise the actual pinned WhatsApp adapter, signed webhook bodies,
and intercepted Graph HTTP requests for both reply-button and list callbacks.
They also cover shared-state races, identity/scope/route changes, stale/deleted
Sessions, unknown namespaces, activation/claim failures, provider failures, and
fresh client-tool continuation capabilities.

These are simulated transport tests. They do not establish that Meta accepted a
production request or that a WhatsApp client displayed the controls. A real
authorized recipient roundtrip is a separate hosted release check. No real
WhatsApp messages are sent by the test suite.
