# Mission execution and retries

Create a Mission with its trusted application `user` and `metadata` at the top level, then
execute it with a key that identifies one intended invocation:

```ts
const mission = await client.createMission({
  name: "Read account",
  user: "customer-a",
  metadata: { connectionNamespace: "my-app" },
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
returns the original admission, including its task snapshots, captured user and metadata,
even after the Mission is edited or the tasks are deleted. It does not recreate
deleted tasks. Read the task API separately for current status. A task's
`missionExecutionId` links it to its accepted execution; `group` is a label and
must not be used as a unique identifier.

The executor validates the complete dependency graph, task hooks, agents and model
configuration before making tasks runnable. Atomic admission stores all tasks,
the Mission counter/state and a durable receipt together. Each task inherits the
top-level Mission user and metadata. Authored task data cannot replace that context.
Checkpoints, delays, quality gates and planned temporary agents recover from the
accepted snapshot before dispatch, including after a restart or Mission edit.
Editing the Mission affects future executions. Hooks are planning hooks and may
run more than once; admission idempotency does not make external hook side effects
exactly once.

For an end-user Connection, `user` and `metadata.connectionNamespace` identify
the account owner together. Supply both from your authenticated application
backend; Polpo does not authenticate your application's users. The namespace
must match the one used when connecting the account. An agent still needs an
active Connection grant; metadata alone cannot authorize it. Shared installations without user constraints
can omit this context. No application namespace is inferred for existing work.

`metadata` is a flat string map with at most 16 entries, keys up to 64 characters
and values up to 512 characters. The same limits apply to completions, Task and
Mission creation. Standalone `client.createTask({ ..., user, metadata })` and the
task creation API use the same context. Tool code and trusted server bindings
can read it from `ctx.invocation.metadata`; it is not added to model arguments.
The public update APIs do not change this identity. A retry of an accepted
Mission always retains its original snapshot, even if a trusted host edits the
Mission for future executions.

Runtime checkpoint/delay lists and events preserve `group` as the accepted
human-readable label and include `missionId` and `executionId` for durable
executions. Labels may coincide, so clients must identify timers by execution ID
and delay name. The SDK exports `activeDelayKey()` for the `activeDelays` store;
legacy hosts without execution receipts use the group label as a fallback. The
React hook reconciles initial HTTP snapshots with newer SSE starts/expirations.

Hosts that initialize their execution engine lazily can use
`createMissionRuntimeInspector(stores)` from `@polpo-ai/core` for checkpoint,
delay and resumable-Mission reads. Each getter reads current persistence without
starting an engine, restoring temporary agents, advancing timers or dispatching
pending work. The shared HTTP routes await asynchronous gate getters. Cloud uses
this reader so saved gates remain visible after a process restart. Resumability
requires a pending or failed task in the Mission's current execution; an empty
failed Mission or a failed task from an older execution does not qualify.

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


### Dependency recovery and custom persistence

When dependency recovery analyzes a blocked task, it captures the task and its
dependency graph before waiting for the model. Absorb, retry and fail decisions
are committed only if every captured row is unchanged, including its execution
identity, status, retry budget, description and dependencies. A stale decision
is discarded and the next tick reevaluates current work. Absorbing one dependency
retains other dependencies and any previously absorbed instructions.

The file, SQLite and PostgreSQL stores implement
`ConditionalTaskExecutionStore.mutateTaskExecutionConditionally`. Custom stores
must implement this capability to support automatic dependency recovery. They
must copy inputs before I/O, validate every `TaskExecutionPrecondition` in the
same transaction as the Task/Run mutation, and preserve asserted absence until
commit. Checking `getTask` before a separate mutation is insufficient. A
`snapshot: null` means the row is absent; unreadable or invalid state must reject.
Stores without this capability retain ordinary operations but cannot safely
apply automatic deadlock decisions; no non-atomic fallback is attempted.

PostgreSQL locks existing decision rows in ID order. Decisions asserting missing
rows acquire an exclusive Task-table lock before row locks to prevent inserts
and avoid lock-upgrade deadlocks. These rare decisions can briefly delay other
Task writers; transactions must not perform model or provider calls.

The Node resolver is scoped to one engine. `resolveDeadlock` accepts the shared
`DeadlockFacade` or the existing `Orchestrator` shell; the latter delegates to the
same facade. `isResolving()` remains a process-wide diagnostic; use the resolver
port's method when deciding whether a particular engine is busy. A failure to
notify a local Run owner after a committed decision is logged separately and
does not undo the decision or fail unrelated work. Durable Run observation
remains responsible for cross-host notification; this does not prove termination
of uncooperative code or remote provider sessions.
