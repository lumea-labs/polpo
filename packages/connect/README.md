# @polpo-ai/connect

Shared contracts and client SDK for Polpo Connect.

Polpo Connect models external service connections as scoped, revocable capabilities that can be assigned to agents without exposing raw access tokens to the model.

This package contains:

- connector provider definitions
- connection and OAuth state types
- scope normalization and validation helpers
- connector registry helpers
- a small HTTP client for Connect APIs

Server-side OAuth/token lifecycle lives in `@polpo-ai/connect-server`.

## Domain model

- A version 2 `ConnectorDefinition` declares `http_api` or `mcp`, supported
  authentication methods, scopes, operations and policy. It contains no client
  secret, API key or account token.
- A Connection selects one `authenticationId` and represents an authorized
  account. Its owner, audience, scopes, binding and grants remain distinct.
- An OAuth Client is the registered application used to obtain authorization.
  Operator/customer/managed ownership does not determine whether an account is
  shared or belongs to an end user.

`normalizeConnectorDefinition` validates and copies authored definitions.
`createConnectorRegistry` accepts both old providers and version 2 definitions.
`catalog()` describes protocol and supported authentication separately. Legacy
generic API keys with no destination policy are classified as credentials.
`list()` remains a compatibility projection of each Connector's default method.

## Creating static and MCP Connections

`createApiKeyConnection`, `createPublicConnection`, `createMcpConnection` and
`startMcpOAuth` accept trusted `audience`, `subject` and `binding`. Omitting
`audience` retains the shared default; a human owner does not implicitly make an
account personal. Set `personal` with a `user` owner or `end_user` with an
`external_user` owner containing both `namespace` and `id`. The service derives
the principal binding and rejects conflicting or malformed constraints before
storing credentials or starting consent. Shared accounts can still have narrower
tenant/resource bindings.

For Cloud, use `createProjectApiKeyConnection`, `createProjectPublicConnection`,
`createProjectMcpConnection` and `startProjectMcpOAuth`. For a self-hosted server,
the unsuffixed methods target `/v1/connect`; MCP OAuth requires an explicit
registered `redirectUri`. `inspectMcpOAuth` inspects a self-hosted endpoint's
OAuth configuration. All creation methods are authenticated control-plane calls,
not tools exposed to the model or unauthenticated application users.

Choose a custom MCP's `providerId` and `authenticationId` explicitly. Its selected
method determines credential injection, including the header name. Generic MCP
supports public, bearer or a validated `headerName` with `auth: "header"`.
Discovery inventory is recorded by the host: caller-supplied `discoveredTools`
and `lastDiscoveredAt` metadata cannot install callable tools.

CLI: `polpo connections create <public|api-key|mcp> ./connection.json` sends the
same request to the linked project. Store credential-bearing input in a private
file outside source control; the command prints only the non-secret result.
`polpo connections mcp connect` opens the dashboard for review and consent. It
accepts a catalog ID or clean HTTPS endpoint, with optional `--name`,
`--transport` and `--dashboard-url`. It rejects advanced authentication, owner,
audience, binding and scope flags because the handoff link cannot carry those
contracts. Use the session-authenticated MCP OAuth API or a trusted setup session
when that context is required.

## Agent capabilities

HTTP action handlers receive an authorized `ConnectorActionGateway`. They pass
an operation and required scopes; the host binds the Connection, trusted user,
tenant and grants and injects credentials outside the model and tool arguments.
MCP uses its native transport and discovery. The presence of legacy token and
application-capability helpers is not an invitation to make Polpo a general
backend integration broker; the current product scope is agent capabilities.

The host can set the trusted selector's `audience` to select a shared, personal
or end-user account explicitly. Shared capabilities retain the caller's identity
for audit. They are not a fallback for a missing end-user match. Legacy records
without audience remain shared while retaining their binding restrictions.

For a distributed sandbox relay, `getConnectionCapabilitySelection(capability)`
returns a host-only selection snapshot from the acquired gateway capability.
Persist it in trusted server state and pass it as `selection` when constructing
the resolver for subsequent relay requests. Resume loads only that installation
and rechecks its identity, binding, audience, credential generation and live
permissions. The snapshot is kept in a WeakMap rather than capability properties;
never copy it into a tool's arguments, metadata or sandbox payload. A relay claim
without a selection must be reacquired, not resolved to a replacement account.

## OAuth setup without a required hosted page

Create a setup session from a trusted backend, deriving `subject` and `binding`
from the application's authenticated user. Never copy an unverified browser
user ID into this context or put a Polpo API key in browser code.

For the generic OSS API, use `createSetupSession` then `startOAuthSetup(id)`.
For Cloud, use `createProjectSetupSession(projectId, input)` and
`startProjectOAuthSetup(token)`. These helpers intentionally target different
host routes. Cloud may also return a convenience `setupUrl`; opening that page
is optional. Both paths lead to the same provider-hosted consent.

Cloud control-plane methods use a platform API key supplied through the client's
`headers: { Authorization: "Bearer ..." }`; the constructor has no `apiKey` or
`projectId` option. Keep this key on the trusted backend.
`getSetupStatus`, `cancelSetupSession`, and `waitForSetupCompletion` work with
both hosts. The OSS router exposes `GET /connect/setup/:id/status` and
`POST /connect/setup/:id/cancel` under its existing authenticated API; Cloud
exposes the hosted bearer-link routes. Configure the client's base URL for its
host. A browser redirect alone never proves completion.

Setup-link expiry limits when authorization can start. Once started, status uses
the OAuth authorization deadline. Cancellation is allowed only before start;
completed, cancelled and failed outcomes remain terminal after expiry.

Managed clients show the provider's registered Polpo app identity. Customer
clients show the customer's registered identity. In both cases the host handles
the provider callback, exchanges the code, and retains tokens server-side.
The approved application `returnUrl` is separate from that callback. Confirm
completion through setup status, not a success parameter supplied by a browser.

Cloud project administrators can configure application destinations independently
of OAuth app ownership using `configureProjectSetup(projectId, { returnOrigins:
["https://app.example.com"] })` and inspect them with
`getProjectSetupConfiguration(projectId)`. Origins must use HTTPS and cannot include
paths or wildcards. The CLI equivalents are `polpo connections setup-config show`
and `polpo connections setup-config set --origin https://app.example.com` (or
`--clear`). This configures the application's completion destination, not the
provider's callback. Removing the last approval for an origin invalidates pending
flows using it; an OAuth client's or host's separate origin approvals still apply.

After setup, a trusted backend can list and revoke an external user's accounts:

```ts
const owner = { namespace: "my-app", id: authenticatedUser.id };
const accounts = await connect.listProjectEndUserConnections(projectId, owner);
await connect.revokeProjectEndUserConnection(projectId, owner, connectionId);
```

Revocation targets one Connection within that exact project, namespace and user.
The CLI equivalents are `polpo connections end-users list <user-id> --namespace
my-app` and `polpo connections end-users revoke <user-id> <connection-id>
--namespace my-app`. These are authenticated management operations, not public
browser endpoints.

Agent runtime selection uses that same namespaced identity. Supply the trusted
principal as `{ type: "external_user", namespace: "my-app", id: userId }`; an ID
without its application namespace cannot authorize an end-user account. In Cloud
completion context, the trusted backend supplies `user` and
`metadata.connectionNamespace`, or the full principal in
`metadata.connectionScope.principal`. Never derive the namespace from the model,
provider, email address or an unverified browser parameter. Existing namespaced
owners remain usable even if their older stored binding omits the namespace;
records without a valid external-user owner require explicit correction or setup.

For a Connector with multiple authentication methods, pass `authenticationId`
when configuring a project or organization OAuth client. Pass the same method
as the optional third argument to `revokeProjectOAuthClient` or
`revokeOrganizationOAuthClient`. CLI `connections oauth-clients set` and `revoke`
accept `--authentication <id>`. Omitting it preserves the default method.

## Custom definitions and verification

`registerConnectorDefinition` registers a validated custom definition on a host
with a `ConnectorDefinitionStore`. IDs are immutable: changing endpoint policy
requires a new definition and explicit setup, so existing secrets cannot be
silently redirected. `disableConnectorDefinition` blocks subsequent use.
The store must be scoped to the authorized tenant by the host.

For Cloud, use `listProjectCatalog(projectId)`,
`registerProjectConnectorDefinition(projectId, definition)`, and
`disableProjectConnectorDefinition(projectId, connectorId)`. The CLI exposes
`connections connectors register <file>` and `connections connectors disable <id>`.

`getSetupReadiness(input)` checks local prerequisites for the selected
authentication and OAuth Client mode. It reports configuration readiness only:
`consent_required` does not claim a working authorization, and
`credentials_required` does not validate a key. Use `verifyConnection` after
setup for a live check. The managed/own label describes app ownership, not
availability or connection health.

The Cloud variant is `getProjectSetupReadiness(projectId, { providerId,
authenticationId, oauthClientMode })`. Its CLI equivalent is `connections
setup-readiness <provider-id> --authentication <id> --oauth-client-mode managed`.
This checks setup prerequisites; `connections readiness` instead checks a
specific runtime slot's trusted selection and grants.

`verifyConnection(id)` returns `passed`, `failed`, `inconclusive`, or
`unsupported`, with check type, timestamp and configuration/credential versions.
A successful public operation does not verify a credential. MCP discovery does
not prove that every discovered tool works. Verification is independent of the
Connection lifecycle and must not silently revoke it. Project hosts use
`verifyProjectConnection(projectId, id)` and must implement the matching route.
## Account assignment preflight

Hosts can validate account assignments for a logical capability with
`validateConnectionAssignments([{ connection, binding }])`. The optional binding
adds grant constraints to the Connection's own binding. The result is `{ ok:
true }` or a non-secret conflict with `reason` and `connectionIds`.

Different accounts need disjoint trusted contexts. Personal ownership constrains
the principal; missing fields do not disambiguate accounts. The host must select
the audience explicitly and must still enforce visibility, active status,
scopes, grants, and concurrent-write protection. This configuration check does
not replace the runtime resolver's exact-one-account authorization.


MCP reusable client configuration is described by `ResolvedMcpOAuthClient` and
`McpOAuthClientResolver`. These host-only contracts distinguish configuration
ownership from the protocol's three registration methods. They do not expose
provider secrets to the setup SDK. An OSS host with `mcpOAuthClients`, setup/link
stores and atomic embedded persistence supports MCP through `createSetupSession`:
pass `configurationId` to select the approved reusable configuration. The same
selector is available on `CreateConnectionSetupSessionRequest`, the OSS HTTP
setup endpoint, and `polpo connections setup-session --configuration <id>`.
The request assigns a trusted owner and audience; the browser receives a setup
token, not the client secret. Callback completion creates that owner's account,
its project link and both receipts atomically. Managed hosts must implement and
deploy the same server capability before accepting MCP on their setup route.
