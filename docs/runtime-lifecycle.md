# Run preparation and cancellation

The Node runtime's `executeRun` owns initial steering restoration, transcript
session creation and Run registration through final cleanup. The subprocess
runner and `InProcessSpawner` use this same lifecycle.

A host can supply `ExecuteRunDeps.signal` and `preparationTimeoutMs`. The default
preparation deadline is 30 seconds; accepted overrides are positive integer
milliseconds up to five minutes. The timer stops when the engine handle is
created, so it does not limit the duration of the running agent. These options
are transient host controls, not persisted `RunnerConfig` fields.

`createLogSession({ signal })` receives the combined host, steering, durable-Run
and preparation-deadline cancellation signal. `SteeringController.restore` can
accept the same context as its optional second argument. Existing callbacks
that ignore extra arguments remain compatible. Callbacks should pass the signal
to operations that support cancellation and register every acquired resource
with the host's `finalize` callback before returning.

Cancellation prevents subsequent preparation phases and model/tool startup. A
TaskRunner-owned Run is observed before initial preparation. A fresh standalone
Run is observed after its first registration; a missing or unreadable registered
Run stops execution. Existing terminal outcomes take precedence over local
errors and are never reopened by registration.

The runtime awaits a pending registration or resource-producing callback even
after cancellation. A deadline requests cancellation; it cannot forcibly stop
an arbitrary custom store or callback that ignores its signal. Such work keeps
its owner until it settles, then finalization runs once. `SpawnResult.onExit`
fires only after that drain and cleanup. Hosts must keep dependent stores open
until this receipt; a terminal Run row alone does not prove local exit.

An initial rejection is handled by the same failure/cleanup path as later
preflight failures. A lost registration acknowledgement does not cause a retry:
the runtime attempts terminal persistence and confirms the authoritative Run.
If persistence cannot confirm the result, execution reports failure rather than
claiming success or recreating a missing Run.

This lifecycle begins at `executeRun`. Host work performed before entering it
(such as managed sandbox allocation or Data/MCP resolution) needs its own owner
and cancellation propagation. This contract does not establish remote-provider
termination, managed billing reconciliation or a hard wall-clock bound on
uncooperative I/O.

TaskRunner stores the complete configuration of a pre-registered Run through
`RunStore.updateRunConfig(runId, config, configPath)` when available. The built-in
File, Drizzle (SQLite/PostgreSQL) and Ephemeral stores atomically update only an
existing `running` record. Missing or terminal records return `false`, which
prevents spawning without an upsert fallback. The write changes configuration,
path, update timestamp and the execution mode if specified; it preserves the
claim revision, start time, activity, checkpoints and result. The port remains
optional for third-party store compatibility: TaskRunner retains its historical
registration path only when the method is absent. Hosts requiring the update-only
guarantee must reject unsupported stores instead of emulating it with read/upsert.

Before calling `Spawner.spawn`, TaskRunner also registers the exact pending
Run identity locally. Shutdown records interruption and calls `cancelRun(runId)`
while host acquisition is still pending. A failed cancellation leaves stores
open and can be retried; other pending cancellations remain owned and are not
duplicated. Successful notification alone does not finish shutdown: TaskRunner
still waits for the preparation to settle, transfers a returned handle to its
real `onExit` receipt, and preserves interruption acknowledgements across errors.
A spawner must drain its owned preparation effects and cleanup before rejecting
`spawn`. TaskRunner does not synthesize an exit receipt for a returned handle or
fall back to killing a persisted PID.
