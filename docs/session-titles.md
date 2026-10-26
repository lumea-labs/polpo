# Automatic Session titles

New conversations receive a short title in a separate, asynchronous, tool-free
model call after their first user message is persisted. This includes greetings
such as “ciao”. The main response never waits for title inference. Until it is
ready, the first-message preview remains visible. Existing/imported Sessions and
manually assigned titles are not renamed automatically.

## Configure

Set `sessionTitles` on an agent (`.polpo/agents/<name>/agent.json` or the agent
API). Local project defaults use `settings.sessionTitles` in `.polpo/project.json`.
Host defaults are supplied through `CompletionRouteDeps.sessionTitles.defaults`.
Each field inherits independently: host < project < agent. An omitted or null
field inherits. `enabled: false` explicitly disables naming.

```json
{
  "sessionTitles": {
    "enabled": true,
    "model": "openai/gpt-5-mini",
    "language": "auto",
    "maxLength": 80,
    "maxOutputTokens": 128,
    "timeoutMs": 5000
  }
}
```

`model` is optional. Without an override, naming uses the concrete model resolved
for the first conversational turn. Profile references and explicit fallback
policies use the existing model selection format. No unrelated fallback model is
selected silently. Naming disables agent reasoning and does not receive its
system prompt, tools, memory, history or sandbox. It only receives the bounded
first user input (maximum 2,048 Unicode code points); attachment URLs/bytes are
excluded. Language accepts `auto` or a BCP 47 tag such as `it` or `en-US`.

Defaults are enabled, auto language, 80 characters, 128 output tokens and 5 seconds
per attempt. Hard caps are 200 characters, 512 tokens and 15 seconds. There are at
most two attempts within 60 seconds, including declared model fallbacks. Errors
retain the provisional title and do not change the outcome of the conversation.

Agent definitions retain these settings through `polpo deploy` and `polpo pull`.
Project defaults for Cloud are configured with the project/environment settings
API under `runtime.sessionTitles`; local project settings are not implicitly
copied to a managed environment by deploy.

## Receive updates

An open completion stream can include an ordinary completion chunk with an empty
assistant delta and a `polpo.session` extension:

```json
{
  "choices": [{ "index": 0, "delta": {} }],
  "polpo": {
    "session": {
      "id": "SESSION_ID",
      "title": "Planning a restaurant website",
      "titleSource": "generated",
      "titleRevision": 1,
      "titleUpdatedAt": "2026-10-26T12:00:00.000Z",
      "titleGenerationStatus": "completed"
    }
  }
}
```

This is metadata, not response text. Project event subscribers receive
`session:updated` with `{ session: <snapshot> }`. A title that completes after
`[DONE]` is persisted; it never reopens the stream or rewrites the Run journal.
Read `GET /v1/chat/sessions/{id}` for metadata only. List and message-history
responses expose the same fields. All requests use the existing project and
environment credentials; application backends remain responsible for their end
users' authorization. Do not give end-user browsers a project-wide credential.

```ts
const stop = client.watchSessionTitle(sessionId, session => {
  // Apply only newer titleRevision values to avoid stale reloads overwriting a title.
  updateSessionLabel(session.id, session.title);
});
// On unmount or when switching client/project/environment:
stop();
```

The SDK watcher deduplicates reads per client/Session, backs off, and stops when
naming is terminal, credentials are rejected, the Session disappears, all
subscribers leave, or 60 seconds elapse. `useChat({ onSessionUpdated })` and
`useSessions()` integrate this automatically. Late recovery after the watcher
expires is visible on the next metadata/list read.

## Rename manually

```ts
await client.renameSession(sessionId, "Customer onboarding", currentTitleRevision);
const session = await client.getSessionMetadata(sessionId);
```

The optional revision prevents lost edits (`409 SESSION_TITLE_REVISION_CONFLICT`).
An explicit rename always wins over in-flight generation, even when the string
is unchanged. Its response preserves `renamed: true` and adds `session` with the
authoritative title snapshot. `titleRevision` is independent of the conversation's
`version`; automatic naming does not reorder the activity list or modify messages.

```sh
polpo sessions show SESSION_ID --prod
polpo sessions rename SESSION_ID 'Customer onboarding' --title-revision 1 --prod
```

Omit `--prod` for the CLI's normal development target.

## Host integration and recovery

File, SQLite and PostgreSQL stores persist first-message admission atomically
with the canonical user write. A fenced claim prevents concurrent workers from
applying stale results. The validated candidate is persisted before updating the
title; notification retries do not call the model again. SQL uses private
`sessions.title_state` plus an indexed `title_work_pending` column. Files carry
equivalent private state under the existing cross-process project lock. Neither
private input nor job policy is returned to clients.

The Node host starts/stops its recovery lifecycle automatically. Custom hosts
must supply a persistent `prepare`/`wake` mechanism and call the shared recovery
coordinator independently of requests. Store adapters without title capabilities
retain their existing behavior. Session/agent deletion fences stale work;
recreating an agent does not transfer a captured agent identity to its replacement.

Auxiliary usage is reported with `operation: "session_title"`, purpose
`session.title`, Session ID and a stable attempt ID. Cloud uses its established
best-effort completion meter with ledger operation `chat`, without creating an
agent Run or charging another agent execution. A crash before provider usage is
reported can leave accounting unknown, as with existing auxiliary inference;
this feature does not claim exactly-once provider requests or billing delivery.
