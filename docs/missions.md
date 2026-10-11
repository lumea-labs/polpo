# Mission execution and retries

Create a Mission with its trusted application `user` at the top level, then
execute it with a key that identifies one intended invocation:

```ts
const mission = await client.createMission({
  name: "Read account",
  user: "customer-a",
  data: JSON.stringify({
    tasks: [{ title: "Read inbox", description: "Summarize unread mail", assignTo: "support" }],
  }),
});
const accepted = await client.executeMission(mission.id, {
  idempotencyKey: "daily-summary:2026-10-11",
});
```

The same API is `POST /api/v1/missions/:missionId/execute` on the local server
and `POST /v1/missions/:missionId/execute` in Cloud. The optional JSON body is
`{"idempotencyKey":"daily-summary:2026-10-11"}`. Existing callers may omit it.
Keys must contain 1–200 characters, with no surrounding whitespace or control
characters. A key belongs to one Mission in one project; use a different key for
a new intended execution. Keep the original key after a timeout or lost response.

The response includes `tasks`, display `group`, and `executionId`. A repeated key
returns the original admission, including its task snapshots and captured user,
even after the Mission is edited or the tasks are deleted. It does not recreate
deleted tasks. Read the task API separately for current status. A task's
`missionExecutionId` links it to its accepted execution; `group` is a label and
must not be used as a unique identifier.

The executor validates the complete dependency graph, task hooks, agents and model
configuration before making tasks runnable. Atomic admission stores all tasks,
the Mission counter/state and a durable receipt together. Each task inherits the
top-level Mission user. Authored task data cannot replace that principal.
Checkpoints, delays, quality gates and planned temporary agents recover from the
accepted snapshot before dispatch, including after a restart or Mission edit.
Editing the Mission affects future executions. Hooks are planning hooks and may
run more than once; admission idempotency does not make external hook side effects
exactly once.

Runtime checkpoint/delay lists and events preserve `group` as the accepted
human-readable label and include `missionId` and `executionId` for durable
executions. Labels may coincide, so clients must identify timers by execution ID
and delay name. The SDK exports `activeDelayKey()` for the `activeDelays` store;
legacy hosts without execution receipts use the group label as a fallback. The
React hook reconciles initial HTTP snapshots with newer SSE starts/expirations.

The built-in file, SQLite and PostgreSQL stores support this contract. Custom
stores can implement `MissionExecutionStore` from `@polpo-ai/core/mission-store`:
receipt lookup by key and execution ID, atomic admission and conditional
finalization. File storage requires its SQLite coordinator; PostgreSQL hosts using
the stateless Neon HTTP driver must supply a real interactive transaction provider.
Cloud supplies the Neon WebSocket provider.

A custom store with only ordinary Mission/Task CRUD retains ordinary execution
without an idempotency key. Explicit idempotent execution fails before writes if
the capability is unavailable. API errors distinguish invalid requests (`400`),
admission conflicts (`409`) and unsupported atomic persistence (`501`).

Local Mission scheduling supplies an occurrence key and awaits asynchronous
admission. Cloud Schedule `legacy_mission` dispatch supplies a key derived from
its durable schedule run and records the returned execution ID. The CLI's authored
Mission files and deployment format are unchanged; there is no new dedicated CLI
execute command.

Upgrade participating runtime, store, server and SDK packages together. Old
executors and file writers must be stopped during migration or rollback: they do
not enforce the new admission and recovery barrier. Retain receipts for as long
as callers may replay keys.
