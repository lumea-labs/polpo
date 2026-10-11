# Polpo file stores

`FileAgentStore` implements the core `VersionedAgentStore` contract for legacy
`agents.json` and directory definitions (`agents/<name>/agent.json` plus
`instructions.md`). `FileTeamStore` shares the same project coordinator.

Agent and team persistence requires the optional `better-sqlite3` dependency.
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
