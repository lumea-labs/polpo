# @polpo-ai/connect-server

Server-side primitives for Polpo Connect.

This package implements the backend lifecycle for API-key and OAuth2 connections:

- API-key connection creation
- OAuth authorization URL generation
- OAuth callback and token exchange
- access token retrieval
- refresh token handling
- policy checks before token release
- revocation and secret deletion

It is independent of the HTTP framework. Node hosts can mount it through Hono,
Express, or another transport. Its default DNS and crypto adapters use Node APIs;
do not infer direct Workers compatibility without a tested host adapter.

## Host responsibilities

Pass legacy providers or version 2 Connector definitions to
`createConnectService`. `listCatalog()` returns a normalized asynchronous
catalog including registered custom definitions; `listProviders()` retains the
static compatibility catalog. Configure these ports as needed:

- `store`, `secrets`, `links`, `setupSessions`: durable account, encrypted
  credential, project-link and single-use setup/state storage.
- `oauthClients`: explicit operator/customer/managed registration resolution.
  A missing selected client must fail, not fall back to another owner.
- `definitions`: tenant-scoped `ConnectorDefinitionStore`; duplicate creation
  must be atomic and IDs cannot be reused after disablement.
- `verifyMcp`: a host adapter that initializes the native MCP client and lists
  tools using the resolved credential and supplied abort signal. Use
  `discoverRemoteMcpTools({ url, transport, headers, signal })` after resolving
  headers inside the trusted host. It supports HTTPS Streamable HTTP and SSE,
  refuses cross-origin credential forwarding, pins public DNS and bounds time,
  response size and pagination. It throws on failure; an empty array means a
  successful `tools/list` response with no tools. It never calls a tool.
- `verifications`: optional persistence for sanitized verification results.
- `policy` and the trusted capability resolver: authorization checks before
  execution, including user/tenant binding and operation restrictions.
- `refreshCoordinator`: distributed coordination for multi-replica hosts.

Multi-replica OAuth refresh also requires a `VersionedConnectionSecretStore`
with atomic compare-and-set, as supplied by the Memory and Drizzle adapters.
Before an API or MCP refresh consumes a potentially single-use token, the service
stores a private intent inside the encrypted credential. A replica acquiring an
expired coordinator lease cannot reuse a token whose attempt is still pending.
The result is committed against that intent, including a receipt for recovering
a lost storage acknowledgement. This state is never public Connection metadata.

A lost provider response or crash after dispatch leaves the outcome uncertain.
Automatic retries of that old refresh token are denied; a still-running owner
can finish its commit, otherwise the account needs a new authorization. Replacing
the credential creates a new lineage. Unversioned secret adapters retain their
single-process coordinator behavior and do not provide this cross-replica fence.
All refresh writers must be upgraded before enabling this guarantee: older
binaries do not understand the intent, and must be drained during cutover.

Memory adapters are for tests or ephemeral hosts. They do not make setup state,
credentials or custom definitions durable across process restarts. For durable
self-hosting, `@polpo-ai/drizzle/connect` provides SQLite and PostgreSQL adapters
for these ports, with encrypted payloads and atomic state/secret updates.
See [self-hosted setup](../../drizzle/README.md#connect-storage).

The Node `PolpoServer` and `createApp` accept an explicit `connectService` and
`connectionCapabilityResolver`. Management routes mount at `/api/v1/connect`
behind the normal server authentication. The public browser callback is
`/api/v1/connect/oauth/callback`; register that exact canonical URL at the
provider. It exposes no credential or account record, and redirects only to a
return URL previously validated during setup. Installing packages alone does
not configure providers, OAuth apps, grants or a Cloud dashboard.

## Lifecycle guarantees

If a reference write loses its acknowledgement, the service recovers only a
positively confirmed matching credential generation or OAuth state. A failed
read or absent row does not prove rollback: the service preserves the staged
secret and reports the original error. Cleanup is immediate only before a
reference write is attempted or after an explicit reconnect CAS miss. Hosts
must reconcile uncertain writes before reclaiming genuinely unreferenced
credentials; the included adapters currently provide no orphan-secret GC/TTL.
Durable secret stores encrypt retained material; memory stores are ephemeral.

Static API/public/MCP creation and MCP OAuth share `ConnectionCreationContext`:
explicit audience, owner and optional trusted binding. The default remains
shared for compatibility. Personal and end-user owners produce a matching
principal restriction; conflicting, missing or null constraints fail before
secret persistence or provider discovery. Hosts authorize the caller before
accepting these control-plane inputs. They must not populate them from model
arguments or unverified browser identity.

The OSS HTTP surface includes `POST /connections/mcp`, `/mcp/inspect` and
`/mcp/oauth/start` under the authenticated Connect mount. API/public creation
preserves the same context. MCP OAuth state and callback preserve namespace,
audience and bindings. A selected Connector's auth method remains authoritative;
generic MCP header injection is validated and persisted in the initial write.
Creation strips host-observed discovery metadata rather than accepting a caller's
tool inventory. Durable hosts must condition discovery persistence on unchanged
account, credential generation, scopes, binding and endpoint metadata, so an old
network response cannot replace newer configuration or discovery evidence.

The selected authentication method is persisted through setup and callback.
New authorizations pin the registered OAuth client ID and endpoints; replacing
the app requires reconnect, while rotating its secret does not. Store adapters
must preserve `authenticationId`, `oauthClientFingerprint` and
`credentialVersion`. Existing records without those fields remain compatible
and need an explicit migration/reconnect strategy at the host boundary.

Code exchange and refresh use bounded HTTPS requests with public-address checks,
no redirects, validated token responses and sanitized errors. Gateway deadlines
cover DNS, redirects and streamed response bodies. Hosts still need appropriate
network egress controls. The default Node transport validates DNS in the socket
connector and supplies those exact public addresses to TLS, preventing a second
unvalidated DNS resolution. A custom `fetch` adapter must enforce the equivalent
socket/egress policy itself. MCP OAuth discovery, registration and token bodies
are bounded before the protocol SDK parses them.

`verifyConnection` runs configured read probes through the same gateway and
scope policy. Results report the checked generation, never response bodies or
credentials. Hosts must rotate `credentialVersion` on credential replacement
and disregard cached checks after relevant configuration or credential changes.
Verified account identities populate `Connection.providerAccountId`.

`getSetupReadiness` is a separate, local configuration check. It resolves the
chosen OAuth Client from the same resolver used by setup and validates the
exact callback. A `passed` / `consent_required` result means authorization can
be attempted; it cannot certify the app's provider publication or approval.
Static-key setup still needs the account key; MCP requires discovery of the
actual server. No readiness check calls the provider or exposes client secrets.

An OAuth provider can return scopes granted by a previous consent to the same
app. Actual token scopes remain in encrypted token storage; a Connection keeps
only its explicitly requested scope ceiling. Neither extra scopes nor refresh
can silently widen the Connection or a narrower Polpo grant.

Both API and MCP OAuth refreshes preserve that ceiling, recheck revocation and
use versioned secret writes when supplied. Multi-process hosts must also supply
a shared refresh coordinator. Revocation first denies access, then removes the
credential; if vault deletion fails, repeating revocation retries cleanup.

## Connection-backed MCP execution

`createConnectionMcpCapabilityResolver` uses the same exact-account selection
and live authorization as HTTP capabilities. The host supplies `resolveSpec`,
`resolveEndpoint` and `resolveHeaders`; the endpoint comes from the installed
Connection, and credential resolution/refresh stays in the Connect service.
The MCP SDK does not start OAuth or write tokens during a tool call.

Each resolved capability authorizes one named operation. Its deadline includes
account acquisition, host policy and credential refresh. Before every HTTP
send it rechecks the account, binding, project link, grant, credential generation
and endpoint. Cancellation cannot fall back to another account or transport.
The native transport checks public HTTPS destinations, refuses redirects, bounds
response bodies and terminates stateful Streamable HTTP sessions. Cleanup is
bounded and cannot turn an already completed operation into a retryable failure.

Agent runtimes use `ResolveMcpRuntimeCapabilities` from `@polpo-ai/core` and
`resolveRuntimeMcpTools` from `@polpo-ai/tools`. A host returns a non-secret,
verified inventory with a resolver for each server namespace. Tool execution
acquires capabilities with the actual immutable invocation and tool-call ID;
model arguments never select credentials or account identity. The optional
`onError(error, input)` hook is host-only. Model-visible errors are redacted.

Node hosts inject `resolveMcpCapabilities` through server options or the
in-process run dependencies. Chat and task/Loop execution share the adapter,
tool policy and cancellation semantics. Connection-backed configuration requires
that host port; `connectionId` survives API serialization and cannot downgrade
to an authored URL when the port is unavailable. The standalone subprocess
runner can bootstrap this port through the broker contract below; without an
explicit host-issued lease it rejects Connection-backed configuration. Task
engines keep legacy stdio/URL loading disabled; standalone
chat retains its explicit compatibility path for unclaimed namespaces.

### Subprocess broker contract

Core exports `createRemoteMcpRuntimeCapabilities` and strict schemas for a
versioned `McpRunnerLeasePayload`, inventory and requests. Connect Server exports
`createMcpRunnerBroker`, an HTTP-neutral Request/Response handler. Hosts supply
opaque lease storage, immutable invocation and inventory, a native capability
factory restricted to the minted grants, live run/generation authorization and
an atomic per-lease `claimCall` callback. Repeated call IDs must return 409 even
if the first operation failed or its response was lost. There is no automatic
retry of provider mutations.

Only `inventory` and `call { capability, toolCallId, arguments }` cross the
runner boundary. The runner cannot submit identity, destination, credentials or
permission overrides. The host checks the inventory against current tool
descriptors, then uses the existing native MCP resolver. Its authorization must
also recheck lease/run/rollout during every native transport send. Requests have
a 30-second total deadline, 256-KiB input and 2-MiB response limits. Disposal is
bounded, including cancellation during acquisition. Responses and errors never
include the host's raw diagnostics.

The Node runner accepts `--capabilities-stdin`. Before loading configuration it
emits `POLPO_RUNNER_CAPABILITIES_READY_V1`, consumes one newline-delimited JSON
envelope (16-KiB maximum, 30-second timeout), pauses stdin and removes listeners.
The envelope carries a shared agent/run/sandbox identity and optional `mcp` and
`data` leases; at least one must exist. It validates every nested binding before
constructing either runtime port. An absent Data binding explicitly disables
ambient Data fallback. The two remote protocols remain independent. The host must
disable input echo, wait for readiness, send the frame once, and revoke it on
every exit. Do not put the bearer in argv, shell commands, persistent sandbox
environment, RunnerConfig or RunStore. A late or uncertain delivery requires
revocation and process termination, not retransmission. This is a host adapter
contract; providing these OSS primitives does not itself configure Cloud lease
storage or a remote sandbox lifecycle.

### OAuth host authorization

`createConnectService({ authorizeOAuth })` accepts an optional host-only hook.
It receives a frozen `OAuthOperationContext`: `operation` (`setup`, `authorize`,
`callback`, `credential`, `refresh`), `protocol` (`api` or `mcp`), and Connector,
Connection and tenant identifiers. It never receives OAuth codes, tokens,
client secrets or metadata. Throw to deny the operation. Without the hook,
self-hosted operation is unchanged.

The shared service checks before onboarding side effects, before exchanging a
callback code, before reading OAuth credentials, inside the refresh coordinator,
and before releasing a credential or sending an API request. Disabling the host
policy during provider exchange prevents activation. If a provider has already
rotated tokens, their encrypted replacement is retained, but disabled callers
receive no credential. Configuration reads and revocation remain available;
static API keys, static MCP tokens and public MCP do not use this OAuth hook.

Hosts must bind runtime evaluation to the **invoking** project. A shared
Connection's original `projectId` is not the execution context. This hook is
additional host authorization; it does not replace Connection selection,
tenant visibility, grants or provider scopes. It cannot recall credentials that
a host previously exported to a legacy consumer.

### Setup status, cancellation and receipt recovery

`getSetupStatus(id)` returns a public projection without owner, binding, OAuth
client, callback metadata or private persistence references. `cancelSetupSession`
competes atomically with authorization start; cancellation is idempotent but
cannot undo an authorization already started. Legacy rows without an explicit
status derive pending/started from `consumedAt`. Setup-link expiry is the start
window; OAuth state expiry becomes the status deadline after start.

Memory and Drizzle stores implement status, cancellation and terminal receipts.
For separate account/link/receipt writes, they also persist a private completion
intent before account persistence. A subsequent status read reconciles only the
exact recorded account generation and active project link. It does not exchange
tokens, search caller metadata, create links or reactivate revoked access. Drizzle
persists the intent encrypted and supports recovery after process restart.

Hosts with an atomic credential/account/link/receipt transaction may instead
implement `finishConnectionSetupSession` by verifying that transaction's receipt.
Custom adapters must implement the optional cancellation/completion ports to
provide the full lifecycle, and either atomic completion or the preparation and
reconciliation ports for durable receipt recovery. A missing or modified account
or link is never reported as a recovered success. Older interrupted flows without
a prepared intent cannot be reconstructed safely and require operator review.


### Reusable MCP client configuration contract

`McpOAuthClientResolver` resolves host-owned configurations independently of
user consent. Ownership (`managed`, `customer`, `instance`) is distinct from
MCP client registration (`dynamic`, `metadata_document`, `pre_registered`). A
configuration pins its Connector/authentication, owner, MCP resource/transport,
callback and registration identity. A backend may select a configuration ID;
the host must reject an out-of-scope or ambiguous selection.

`resolveMcpOAuthSetupClient` validates a scoped selection and returns the private
resolved client plus a non-secret reference/fingerprint. Only that reference
belongs in a setup session. `verifyMcpOAuthSetupClient` re-resolves it and refuses
identity, owner, endpoint or callback changes; secret-only rotation is permitted.
Supply the resolver as `mcpOAuthClients` to enable MCP on `createSetupSession`.
`configurationId` selects an approved configuration; identity comes from the
authenticated application backend. `startOAuthSetup` and `completeOAuthCallback`
use the same setup lifecycle for all three registration methods and ownership
modes. The account belongs to the saved subject and is linked to the initiating
project. Neither caller metadata nor direct MCP start can create setup authority.

MCP DCR adapters receive `registrationKey`. When present they must use it and must
not fall back to old unkeyed entries. It incorporates the private configuration
namespace, resource, authorization/registration/token endpoints, callback, client
branding and requested scopes. Reusing the same MCP URL is insufficient evidence
that its authorization server or client identity is unchanged. User tokens remain
separate from this client-registration cache.

### Atomic MCP OAuth callback activation

MCP OAuth hosts must implement `ConnectStore.commitMcpOAuthConnection` and the
versioned secret store contract. The runtime refuses new consent before discovery
if either is missing; it never falls back to separate account/receipt writes.
The commit inserts a new account and completes the current callback claim in one
atomic operation. Expired/replaced claims and conflicting account IDs are denied,
and a delayed token exchange cannot overwrite a newer secret generation.
Memory and the encrypted SQLite/PostgreSQL adapters implement this contract.
Custom adapters must implement it before adopting this runtime version.
Embedded MCP hosts instead need `commitMcpOAuthSetup`, `failMcpOAuthSetup`, private
setup-reference lookup, setup completion, link storage, callback claims and
versioned secrets. Creation checks these capabilities before issuing a session.
Activation commits the account, project link, setup receipt and OAuth receipt in
one operation. Provider denial conditionally ends both receipts under the current
unexpired claim; a stale callback cannot fail a newer attempt. Completed callbacks
can be retried after a lost acknowledgement, but never recreate revoked links.

The generic resolver is rechecked before consent, exchange, activation and
credential delivery. Its last successful lookup is the configuration authorization
boundary in OSS: an external resolver cannot participate atomically in the generic
store's transaction. Hosts requiring atomic configuration revocation must also
check/lock the live configuration in their `commitMcpOAuthSetup` implementation.
Project authorization and approved return-origin policy likewise belong to the
host. These contracts do not imply a deployed managed implementation.

### Host dispatch budgets

`createConnectService({ beforeDispatch })` accepts an optional trusted host
quota callback. It runs before each API send, including allowed redirects and
API verification probes. A runtime may provide the request-level `beforeDispatch`
instead to use its authenticated invocation principal; the service calls one
quota callback per send, never both. Authorization and credential preflight do
not consume quota. After the asynchronous callback, the service rechecks the
account generation, granted scopes and invocation authorization before sending.
An authorization change can consume budget without sending; budget is not a
billing record and is not refunded after uncertain writes.

Native MCP accepts the corresponding transport callback for every HTTP request
(initialization, notifications, discovery, calls, listening and cleanup). The
Connection capability resolver also rechecks the selected account, current grant,
project visibility and endpoint after waiting. A custom `verifyMcp` adapter must
call its supplied `beforeDispatch` immediately before every provider request;
`discoverRemoteMcpTools` accepts it directly. Do not expose these callbacks or
quota identity to authored tools or model arguments.

Hosts may throw `ConnectError("rate_limited", ..., { details: {
retryAfterSeconds } })` for a quota refusal (HTTP 429), or `dispatch_unavailable`
for unavailable quota infrastructure (HTTP 503). The MCP broker/subprocess/tool
path preserves only the allowlisted quota code and a bounded integer retry time,
using a canonical message; arbitrary provider errors stay redacted. Neither
path retries mutations automatically. Cleanup failures cannot turn an already
completed tool operation into an apparent failure. Self-hosted instances may
omit quotas; distributed persistence and tenant budgets belong to the host.
