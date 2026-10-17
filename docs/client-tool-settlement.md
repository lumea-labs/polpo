# Recovering an interrupted client tool

Client-tool settlement closes an interrupted client-side tool call in its original
Session without calling a model, client handler, server tool, or Project Loop.
It adds one canonical tool-result message and an immutable receipt. It does not
create a Run, trigger memory extraction, or record a new execution for billing.

The contract is introduced by the `0.18.16` package set. A managed host must also
deploy the matching store/schema and enable its settlement write policy. Package
publication alone does not enable Cloud writes.

## Inspect before recovering

```http
GET /v1/chat/sessions/{sessionId}/tool-calls/{toolCallId}?agent=leo&user=customer-1
Authorization: Bearer <Polpo API key>
```

The response uses the normal `{ "ok": true, "data": ... }` envelope. `data`
contains `sessionId`, `toolCallId`, current `sessionVersion`, and one of:

| Status | Meaning | Additional fields |
| --- | --- | --- |
| `pending` | No continuation or settlement was accepted | `continuationAccepted: false` |
| `settled` | Closed without execution | `continuationAccepted: false`, `receipt` |
| `continuation` | A continuation was accepted | `continuationAccepted: true`, `receipt`, `runStatus` |

An accepted continuation receipt contains `sessionId`, `toolCallId`, `runId`,
the version at acceptance, and `acceptedAt` when available. `runStatus` is an
observation: `accepted`, `running`, `completed`, `failed`, `cancelled`, or
`unknown`. Missing or unreadable Run state never turns an accepted continuation
back into a pending call.

The API key authenticates the project/environment. Agent and external user must
exactly match the Session. Either may be omitted only when absent on the Session;
omission is not a wildcard. External user IDs are application assertions, not
independently authenticated end users. Trusted host scope cannot be supplied in
the request body. Use the same environment that owns the Session.

## Close without executing

```http
PUT /v1/chat/sessions/{sessionId}/tool-calls/{toolCallId}/settlement
Authorization: Bearer <Polpo API key>
Idempotency-Key: recover-customer-tool-1
Content-Type: application/json

{
  "agent": "leo",
  "user": "customer-1",
  "expectedSessionVersion": 44,
  "outcome": "cancelled",
  "reason": "The application did not accept this action"
}
```

Outcomes:

- `success`: requires `result`, an exact string; `reason` is not accepted.
- `failed` or `cancelled`: optional string `result` and `reason`.

`result` is limited to 64 KiB and `reason` to 4 KiB, measured as UTF-8 bytes.
Polpo stores a JSON object string containing `ok`, `outcome`, the exact caller
string in `result` when supplied, and `error` for failed/cancelled outcomes. A
JSON-looking result string is preserved as a string; it is not parsed into a
different content type.

The response is `{ "ok": true, "data": { "status": "settled", "receipt": ... } }`.
An exact semantic retry returns `status: "replay"` and the same receipt, even
when its original expected version is now stale. The receipt contains:

```json
{
  "id": "settlement-id",
  "sessionId": "session-id",
  "toolCallId": "call-id",
  "sourceAssistantMessageId": "assistant-id",
  "resultMessageId": "tool-result-id",
  "outcome": "cancelled",
  "sessionVersion": 45,
  "settledAt": "2026-10-17T12:00:00.000Z"
}
```

There is **no `runId` on a settlement receipt**: no continuation was accepted and
no execution was created. `runId` belongs only to accepted continuation receipts.

Session history exposes `state: "completed"` for success and `state: "error"`
for failed/cancelled outcomes, retaining the existing tool-state vocabulary.
The additive `settlementOutcome` field distinguishes the exact outcome. The call
does not remain `interrupted`. Canonical reads place its result immediately after
the original assistant declaration, in declared tool order, including after reload.

## Concurrency and errors

Continuation and settlement compete atomically. If continuation wins, settlement
returns `409 continuation_already_accepted` with the durable continuation receipt
in `data` and a relative `Location` pointing to its GET resource. If settlement
wins, continuation returns `409 client_tool_call_not_pending`; read the GET
resource for the settlement receipt. Neither losing request executes work.

| HTTP | Code | Recovery |
| --- | --- | --- |
| 400 / 413 | `invalid_client_tool_settlement` | Correct malformed/oversized input |
| 401 | `invalid_api_key` | Correct the project credential |
| 403 | `client_tool_settlement_scope_mismatch` | Check identity, environment and host write policy |
| 404 | `session_not_found`, `client_tool_call_not_found` | Check the exact resource |
| 409 | `session_version_conflict` | Re-read current state before deciding |
| 409 | `continuation_already_accepted` | Inspect the existing Run receipt; do not dispatch again |
| 409 | `idempotency_conflict`, `client_tool_settlement_conflict` | Do not change an accepted outcome |
| 409 | `client_tool_call_not_pending`, `client_tool_call_unverifiable` | The call cannot be settled through this transition |
| 409 | `client_tool_settlement_corrupt` | Preserve history and investigate; do not guess an outcome |
| 501 | `client_tool_settlement_unavailable` | Host/store capability is unavailable |

On a lost response or transport timeout, read the GET resource or repeat the
same settlement with the same key and payload. Do not use the continuation
endpoint as cleanup, restart the handler, or replay the original user request.
An already accepted continuation remains accepted even if its Run is no longer
recoverable. An application may choose a new Session as a fallback, preserving
the old one in read-only form, without automatically repeating the user action.

Only frozen, server-owned client-tool declarations are eligible. Session import
strips internal continuation and settlement fields. Stores without the atomic
capability return an unsupported error; hosts must not emulate settlement using
separate read/update calls. File persistence coordinates a single writer process;
use transactional database storage for multiple server processes.
When the Drizzle settlement capability is configured, message writers also use
transactions to protect terminal calls from stale updates. HTTP-only PostgreSQL
drivers must provide the factory's `transaction` adapter; a non-transactional
read/update fallback cannot provide this guarantee.

## SDK and CLI

```ts
const identity = { sessionId, toolCallId, agent: "leo", user: "customer-1" };
const state = await polpo.getClientToolResolution(identity);
if (state.status === "pending") {
  await polpo.settleClientTool({
    ...identity,
    sessionVersion: state.sessionVersion,
    idempotencyKey: recoveryKey,
    outcome: "cancelled",
    reason: "The application did not accept this action",
  });
}
```

The SDK uses the client's default user when `user` is undefined. Explicit
`user: null` selects a Session with no external user; it does not bypass scope.

```sh
polpo sessions tool-call SESSION CALL --agent leo --user customer-1 --json
polpo sessions settle-tool-call SESSION CALL --agent leo --user customer-1 \
  --session-version 44 --idempotency-key recover-customer-tool-1 \
  --outcome cancelled --reason 'The action was not accepted' --json
```

These commands use the linked project and normal environment selection. They
never retry a continuation automatically. No production backfill runs merely
because the schema is migrated; historical repair is an explicit operation.
