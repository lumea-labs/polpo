# Task approval lifecycle

Human gates on `task:spawn` and `task:complete` use one durable batch per
invocation. Every matching gate must pass. An individual approval changes only
its request; the final approval changes the Task in the same transaction.

The batch binds the durable Task input and caller identity, the effective
post-hook spawn input, the agent configuration and creation identity, and the
complete gate policy. A retry, changed input, deleted/recreated Task or agent,
or a changed gate policy cannot reuse consent for different work.

- Spawn approval moves the Task from `awaiting_approval` to `pending`. A single
  atomic claim binds that consent to one Run. Re-entering the spawn gate for
  that Run does not ask again; a later retry needs new consent.
- Completion approval finalizes the stored assessment result and clears the
  Task phase. It does not spawn or assess the agent again. Completion hooks may
  veto completion; mutations to their payload copy do not replace the durable
  assessment or principal shown to the approver.
- Rejection commits feedback, revision count, cleared outcomes and requeue
  together. Timeout uses the captured gate action and deadline, even after a
  configuration reload. A timeout losing a concurrent decision retries while
  its request is still current.

`Task.approvalState` is runtime-owned. Create/update inputs, execution patches
and Mission admission cannot supply it. `ApprovalRequest.taskExecution` is an
immutable typed binding, separate from its display payload. The public approval
routes return HTTP 409 for stale decisions instead of mutating a newer Task.

## Host integration

Use `ApprovalManager` from `@polpo-ai/core/approval-manager` with the Task store,
approval store, hooks, config and event bus. Await `init()`. Wire the manager to
`TaskRunner` and `AssessmentOrchestrator`; `OrchestratorEngine` does this for its
injected manager. Manual resolution needs no scheduler, model or sandbox.

Await `manager.close()` before replacing the manager or closing storage. This
stops timers/hooks and drains pending persistence, so the replacement's `init()`
can discover all committed requests. `dispose()` stops new work immediately but
does not await already-started writes. Completion after-hooks run asynchronously
and may request host shutdown or reload without waiting on themselves.

Node `Orchestrator.gracefulStop()` stops Task dispatch and waits for active
supervisor work and locally spawned runners before closing storage. It leaves
uncollected successful and failed results for the normal assessment and approval
pipeline after restart; shutdown never marks a Task complete directly. A drain
timeout rejects with storage still open. Retrying waits for the same unfinished
work, including post-exit persistence, rather than starting a second drain.

A custom spawner needs owner-scoped `cancelRun(runId)` and a `SpawnResult.onExit`
receipt to drain a live runner. Polling a terminal Run row is not an exit receipt.
Unsupported spawners fail the drain with storage open. Persisted process-list
PIDs are never authority to signal processes during shutdown or orphan recovery.

Recovery of a versioned active attempt checks both the captured Task and the
Run's current status in the storage transaction. A concurrent completion remains
available to assessment; a replacement attempt is left untouched. Recovery uses
the checkpoint returned by that transaction, including updates committed after
the initial orphan scan.

The Task store must implement `TaskApprovalExecutionStore`, including its bound
`getTaskApprovalStore()` adapter. File, SQLite and PostgreSQL implementations
commit Task, Run and Approval state together. PostgreSQL hosts may supply an
interactive transaction provider, including Neon. Unsupported adapters fail
explicitly when a Task gate needs this capability.

## Compatibility and release

SQL migration adds nullable `tasks.approval_state` and
`approvals.task_execution` text columns; normal schema reconciliation is
idempotent. File storage retains the existing Task and approval JSON layout.
Use a coherent package set and drain old writers before enabling the new
protocol. Old runtime versions cannot enforce its authority fields.

Legacy requests without a Task execution binding remain inspectable but cannot
authorize the current Task. Cancel/requeue the Task to produce fresh consent;
do not invent bindings from an old request's task ID or arbitrary payload.

This protocol concerns Task spawn/completion gates. Pre-create, Mission,
schedule and Loop approvals retain their separate semantics; approving a
`task:create` request does not prove a Task has been created. Tool credential
consent is also a separate authorization mechanism.
