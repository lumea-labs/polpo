# @polpo-ai/drizzle

SQLite and PostgreSQL adapters for Polpo runtime stores. The root entry point
exports the runtime store factories and schema migration helpers.

## Connect storage

`@polpo-ai/drizzle/connect` supplies an opt-in, durable self-hosted adapter for
Connections, OAuth state, setup sessions, project links, custom Connector
definitions, verification results and versioned credentials. All payloads are
encrypted with the existing Polpo vault cryptography, including PKCE verifiers
and account metadata. Only partition keys, record IDs and opaque generations
are unencrypted. Ciphertext is bound to its namespace, kind and record ID.

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createSqliteConnectStores, ensureConnectSchema } from "@polpo-ai/drizzle/connect";
import { createConnectService } from "@polpo-ai/connect-server";
import { gmailDefinition, googleDriveDefinition } from "@polpo-ai/connectors";
import { PolpoServer } from "@polpo-ai/node/server";

const sqlite = new Database("./connect.sqlite");
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
const db = drizzle(sqlite);
await ensureConnectSchema(db, "sqlite");
const stores = createSqliteConnectStores(db, { namespace: "my-operator" });
const connectService = createConnectService({
  providers: [gmailDefinition, googleDriveDefinition],
  store: stores, secrets: stores, links: stores, setupSessions: stores,
  definitions: stores, verifications: stores,
  oauthClients: operatorOAuthClientResolver,
  allowedReturnUrlOrigins: ["https://my-app.example"],
});

const server = new PolpoServer({
  host: "127.0.0.1", port: 3890, workDir: "./my-agent-project",
  apiKeys: [controlPlaneKey],
  connectService,
  connectionCapabilityResolver: trustedAgentConnectionResolver,
});
await server.start();
```

`operatorOAuthClientResolver`, `controlPlaneKey` and
`trustedAgentConnectionResolver` are host configuration, not model arguments.
The OAuth resolver supplies the operator's registered app and its exact
callback allowlist; select `oauthClientMode: "instance"` for that setup. The
capability resolver uses the shared `createConnectionCapabilityResolver` from
`@polpo-ai/connect`, deriving the selector from trusted invocation context and
enforcing local grants. Its request adapter calls `connectService.request` with
the selected Connection, declared scopes and abort signal. Do not materialize
raw credentials for gateway slots or substitute another account after denial.

Management API: `/api/v1/connect`. Public provider callback:
`/api/v1/connect/oauth/callback`. The latter processes only stored OAuth state;
it is not a management endpoint. Put the host behind its canonical HTTPS
origin and register that exact callback at the provider. For the Connect SDK,
use `baseUrl: "https://my-host.example/api"`.

The default key resolver uses `POLPO_VAULT_KEY` or the operator's protected
`~/.polpo/vault.key`. Preserve that key separately from database backups. An
explicit 32-byte `encryptionKey` may be supplied by a host key-management
adapter. A wrong key or corrupted/swapped payload fails closed.

Use `createPgConnectStores(db, options)` and `ensureConnectSchema(db, "pg")`
for PostgreSQL. The same conditional writes implement secret compare-and-set,
single-use setup and callback claims in both dialects. Multi-process hosts
must additionally configure a distributed `TokenRefreshCoordinator`; durable
storage alone does not prevent two provider refresh calls at the same time.

Individual store writes are atomic; writing a secret and then its Connection
is not one transaction across the generic ports. On an uncertain write result,
Connect preserves encrypted material to avoid deleting a credential already
referenced by a committed account. This adapter has no orphan-secret GC/TTL;
the host must establish completion of in-flight writes and reconcile references
before reclaiming retained records.

This adapter queries within one trusted namespace and record kind, then
decrypts records to apply inventory filters. Large managed installations may
use an indexed normalized adapter implementing the same OSS ports. Call the
schema initializer explicitly; the general runtime schema initializer does
not provision Connect automatically.

### Conditional agent configuration updates

The runtime `agentStore` implements the OSS `VersionedAgentStore` contract for
both SQL dialects. Read `getAgentSnapshot(name)`, then call
`compareAndSwapAgent(name, { expected: snapshot.revision, mutationId, patch })`.
A successful receipt contains the exact committed snapshot. `patch.set` replaces
specified top-level fields, `patch.unset` removes fields, and `patch.teamName`
changes membership in the same commit. Hosts validate field values before the
write. A no-op still advances revision; stale writes throw
`AgentMutationError` with `agent_revision_conflict`. Never emulate conditional
writes with a read followed by an ordinary update.

Use a fresh mutation ID per intent, and retain both that ID and its original
precondition if an acknowledgement is lost. The same request can recover only
its still-current committed generation. Reload/recompute after a conflict;
never restore a previous full configuration over a newer revision. Deleting and
recreating an agent allocates a new incarnation.

Run the normal schema migrator before upgrading writers. Legacy rows acquire
an incarnation atomically; schema reconciliation does not reset versions.
All processes writing agents must use this protocol before concurrency safety
can be claimed; old code or direct SQL that bypasses revisions is unsupported.
The shared HTTP API exposes revisions through GET and accepts `If-Match` plus
`Idempotency-Key` on PATCH, including an explicit `unset` array. File-backed
conditional writes and migration of all management clients remain separate
requirements; this SQL adapter does not imply their completion.

### Atomic MCP OAuth callback activation

MCP OAuth hosts must implement `ConnectStore.commitMcpOAuthConnection` and the
versioned secret store contract. The runtime refuses new consent before discovery
if either is missing; it never falls back to separate account/receipt writes.
The commit inserts a new account and completes the current callback claim in one
atomic operation. Expired/replaced claims and conflicting account IDs are denied,
and a delayed token exchange cannot overwrite a newer secret generation.
Memory and the encrypted SQLite/PostgreSQL adapters implement this contract.
Custom adapters must implement it before adopting this runtime version.
The same adapters implement `commitMcpOAuthSetup`: account, active project link,
setup receipt and OAuth receipt are one statement. `failMcpOAuthSetup` ends a
provider-denied setup and its OAuth state together, checking the current claim.
Both paths compare exact stored authority versions and live deadlines. PostgreSQL
checks the clock after locking both state and setup rows; SQLite checks it inside
the statement. A final link insertion error rolls back all four records.

These encrypted generic stores do not own the MCP client resolver's configuration
database. They enforce persisted setup/state identity; live configuration is
resolved by the service before commit. A host needing transactionally atomic
configuration revocation must add that predicate to its managed store adapter.
