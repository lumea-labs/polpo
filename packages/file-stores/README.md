# Polpo file stores

`FileAgentStore` implements the core `VersionedAgentStore` contract for legacy
`agents.json` and directory definitions (`agents/<name>/agent.json` plus
`instructions.md`). `FileTeamStore` shares the same project coordinator.

Agent, team, task, Mission, Run and approval persistence requires the optional `better-sqlite3` dependency.
Install optional dependencies on hosts using these stores. If its native binding
is unavailable, access fails with `file_coordinator_unavailable`; there is no
unlocked fallback. Other file stores do not acquire this coordinator.

SQLite provides the OS-released cross-process lock only. Agent definitions remain
JSON/Markdown. Private identity, revision and mutation receipt data live under
`.polpo/.runtime/agent-store/`, outside authored configuration. Keep this directory
out of source control, templates and project exports. Never remove or replace its
`coordinator.sqlite` file while any participant is running. Copying project source
to another installation must not copy runtime identities.

## Concurrent writes and recovery

Use `getAgentSnapshot()` followed by `compareAndSwapAgent()` for decisions based
on previously read configuration. Retry the same mutation ID, expected revision
and patch after an uncertain acknowledgement. An identical retry recovers the
receipt only while its committed generation remains current. Stale revisions,
reused mutation IDs with different requests and deleted/recreated agents conflict.
Use `deleteAgentIfRevision()` for conditional deletion.

Ordinary updates merge against current configuration inside the lock. Team
renaming updates membership in the same transaction; team deletion removes its
agents. Cleanup and seeding also participate. Adjacent skill/evaluation files
remain untouched.

All project-layout readers, writers and migration share the coordinator. CLI
skill assignment performs its complete read/modify/write under that lock. CLI
`pull` captures definitions and identity state before prompts, then conditionally
commits both configuration and instructions. A runtime update during a prompt
causes a conflict even when `--force` was requested.

For short synchronous host operations, `withProjectFileTransaction()` exposes a
staged file view. Do not await, prompt or call a network service inside it. Nested
operations share the transaction. A durable forward journal is fsynced before any
authored file changes; the next participant finishes a committed journal after a
process crash. If a destination matches neither its previous nor committed value,
recovery stops without overwriting it. Stop all writers, preserve the journal and
resolve the out-of-protocol edit before retrying.

The tests exercise local Linux filesystems, separate Node processes, built CLI
and runtime packages, and SIGKILL at each instrumented fsync/rename/remove step.
They do not certify hardware power-loss behavior, network filesystems, macOS or
Windows. Do not use network-mounted project state without validating SQLite
locking and filesystem durability on that host. All active clients must use this
protocol; old releases and arbitrary editor writes bypass it.

## Editing definitions by hand

Stop runtimes and CLI writers before editing initialized definitions. Afterwards:

```sh
polpo migrate --dir ./project --reconcile-agent-identities
```

This explicitly gives **every local agent a new identity**, including unchanged
definitions. Reassign Connections and start new executions afterwards. Manual
edits cannot prove that a delete/recreate did not occur between observations, so
old authorizations are not retained. Keep normal layout migration separate when
you only need to convert legacy files: `polpo migrate` preserves creation identity
and advances configuration revision when serialization changes its content.

Direct edits detected without reconciliation fail with
`file_transaction_conflict`. File fingerprints do not turn editor writes into a
concurrency protocol; in particular an unobserved delete/recreate with identical
content cannot be detected automatically. For live edits, use the runtime API or
coordinated CLI operations.

## Atomic Mission admission

`FileTaskStore` also implements the core `MissionExecutionStore` capability
(`@polpo-ai/core/mission-store`). `commitMissionExecution()` accepts a captured
Mission and a complete plan of pending tasks, validates their principal and
dependencies, then commits all tasks, Mission activation/counter and an immutable
receipt in one project-file transaction. Ordinary task/Mission reads and writes
participate in the coordinator, so they recover a committed journal before
observing task state. No partially published task set is visible to participants.

Retry the same Mission ID and occurrence key after an uncertain acknowledgement.
The receipt preserves the originally admitted task snapshots and user even if
the Mission is subsequently edited or completed. Read TaskStore for current task
status. A new occurrence needs a new key and a fresh Mission snapshot. Receipts
under `.runtime/mission-executions/` survive task/Mission deletion; retain them
for as long as old deliveries can be retried. They are private runtime state,
not authored project configuration.

This is a persistence capability. It does not itself make the Mission executor,
HTTP routes or schedule delivery idempotent. Those callers must integrate it;
hooks, volatile agents and checkpoint/delay preparation are separate runtime
work. Old task/Mission writers must be stopped during rollout or rollback, just
as old agent writers must be stopped when adopting the coordinator.

## Run status and concurrent activity

`FileTaskStore` implements `TaskExecutionStore` from
`@polpo-ai/core/task-execution`. A claim commits the Task's execution revision,
active Run ID and initial Run together. Conditional patches, transitions,
cancellation and requeues take the captured `taskExecutionReference(task)`;
obsolete references conflict instead of affecting a newer attempt. Cancellation
and requeue clear the active link, advance the revision and terminate a running
Run in the same journal commit. A terminal Task result is preserved even when
its still-running Run needs cancellation. Retries use a new Run ID.

Ordinary reads recover both files after a crashed writer. These guarantees use
the same coordinator and filesystem requirements described above. The cached
legacy `JsonTaskStore` does not implement this capability. TaskRunner, TaskManager
and AssessmentOrchestrator consume it with the paired FileRunStore for the same
project. Custom result callbacks must forward the execution reference. Storage
atomicity alone does not interrupt running code or fence an unadapted host.

`FileRunStore` keeps each Run in `runs/<id>.json`. Every reader and writer uses
the same project coordinator, including activity, traces, checkpoints, spawn
metadata, results and collection acknowledgements. This prevents a runner's
stale activity write from restoring `running` after cancellation. Terminal
status/result writes and late registration preserve the first terminal record;
a deliberate retry must use a new Run ID. Missing records remain absent, while
malformed records fail closed instead of being silently replaced.

Upgrade orchestrators and runner processes together and stop all old file writers
before using this contract. These persistence guarantees do not themselves stop a
process or cancel a provider request; the runtime host must also stop execution.

## Approval request persistence

`FileApprovalStore` retains the existing `approvals.json` array format. All reads,
upserts and deletions share the project coordinator, including journal recovery.
Each operation reads the current file under the lock; a process cannot erase
another process's requests by flushing an older cache. Returned values are
detached snapshots and `close()` does not rewrite persisted requests.

Missing files represent an empty store. Malformed JSON, duplicate request IDs,
invalid records, unreadable destinations and failed writes reject explicitly;
they never reset the approval history or acknowledge a lost write. Preserve
corrupt data for inspection and stop writers before repairing it. As with other
coordinated stores, all participating processes need the same protocol and the
native locking dependency; old releases must be stopped during rollout.

These guarantees apply to each store operation. `get()` followed by `upsert()`
is still an unconditional replacement of that request, not a conditional
resolution. ApprovalManager must additionally commit the approval decision,
Task generation and Run ownership together before approval/reject/timeout is
safe across retries or competing resolvers. File serialization alone does not
provide that lifecycle guarantee.
