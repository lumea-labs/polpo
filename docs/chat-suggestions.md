# Chat suggestions after Project Loops

See [the SDK contract](../packages/client-sdk/README.md#chat-interactions) for
request examples, limits, context semantics, and React/continuation usage.

## Ownership and lifecycle

Core owns settings, request options, limits and eligibility. Server owns bounded
auxiliary generation after a successful guarded text completion. Both HTTP
adapters and the transport-independent conversation runner use that contract.
The Loop generator receives final presentation text and the authorized Session's
text conversation up to the current assistant placeholder (latest eight nonempty
user/assistant messages, 7000 characters). With no stored history it falls back
to request messages. It never receives private Loop context, raw tool output, or
system messages. The final answer is limited to 4000 characters in this prompt.

The same result is persisted on the assistant message, emitted as a root
`polpo.suggestions` frame before `stop`/`[DONE]`, and replayed from the durable
journal. No database migration is needed: all Session stores already persist
suggestion arrays. Request hints are not returned as message metadata.

Agent-directory configuration remains `chat.suggestions` in the existing agent
JSON. CLI push/pull and agent API/MCP use this same configuration; no new CLI
command or file layout is introduced. Per-request context belongs in the runtime
request, not the agent definition.

## Acceptance matrix

- Boolean compatibility, default three, valid count two through five; reject six.
- Agent/client/host ceiling and Channel exclusion; no auxiliary call when disabled.
- Streaming, non-streaming and adapter Loop paths produce identical persistence.
- Session history includes prior conversation, excludes later concurrent turns.
- Root SSE suggestions precede terminal frames; durable replay reuses their IDs.
- Session messages API returns the same array as the stream.
- Request guidance/context reach the generator but never the assistant output.
- Invalid output, provider failure, timeout, stalled preparation and abort fail open.
- Client SDK and React forward options on normal and client-tool continuation paths.
- Existing pending client-tool turns remain suggestion-free.
- Cloud UI loads/saves five and Cloud runtime flag remains authoritative.

## Delivery boundary

Release OSS packages first, then pin Cloud to that published version and verify
its runtime ceiling and auxiliary accounting. This change covers Loop completion,
request guidance/context, and count five. Deterministic action suggestions and
Channel rendering are later interventions, with their own contracts and rollout.
