# @polpo-ai/connectors

Curated, executable Connector contributions for Polpo Connect.

## Contribution contract

Each curated HTTP API integration owns one directory under
`src/contributions/<connector-id>/`. That directory contains its version 2
definition, model-facing action schemas, bounded provider request builders,
executor, and provider tests. An executor receives only a host-authorized
`ConnectorActionGateway`; it never receives access tokens, API keys, secret
references, tenancy stores, or managed OAuth configuration.

`defineConnectorContribution` validates one module. Actionful HTTP definitions
must ship an executor in the same contribution. MCP definitions may omit one
because their tools are discovered and invoked by the MCP runtime.

`createConnectorContributionRegistry` is the composition boundary. It rejects
duplicate provider ids and globally ambiguous action ids, derives the tool
catalog from definitions, and dispatches only declared actions. The package
ships `defaultConnectorContributionRegistry` for GitHub, Slack, Google Drive,
and Gmail. Its explicit list in `src/contributions/index.ts` is the only shared
file a contributor normally changes.

This layout lets separate contributors work on separate integrations without
editing a central action switch. A contribution is complete when its local
definition/executor tests pass and the aggregate registry accepts it.

Cloud hosts remain responsible for tenant selection, Connection grants,
credential refresh, rate limiting, audit, and the gateway implementation.
Those concerns do not belong in a provider contribution.

The compatibility catalog includes:

- API Key
- GitHub
- Slack
- Google Drive
- Gmail
- MCP Server URL
- a factory for custom OAuth2 connectors

`githubDefinition`, `slackDefinition`, `gmailDefinition`, and
`googleDriveDefinition` are version 2 API
definitions for the new curated experience. They declare OAuth independently
of protocol and do not contain managed client credentials. The old
`githubConnector`, `slackConnector`, and `googleDriveConnector` projections
remain available for compatibility; hosts must choose and migrate explicitly
before substituting their version 2 policies.

`executeGoogleAction` remains as a compatibility dispatcher. New hosts should
execute the provider-specific contribution through the aggregate registry.

Gmail uses the authenticated `me` account. Search returns message IDs and a
continuation token; read returns bounded MIME text and attachment metadata,
without downloading attachments or marking mail as read. There is no send or
mutation action in this initial set.

Drive search and reads include shared-drive support. `driveId` is a search
filter, not a resource authorization boundary; hosts must not present it as a
grant restricting arbitrary file access. The provider still enforces the
connected account's permissions. Document exports are bounded; spreadsheet CSV
exports contain the first sheet only. Files above the configured response limit
fail explicitly.

Each version 2 Google definition includes a non-destructive account probe for
`verifyConnection`. `gmail.readonly` and `drive.readonly` are restricted Google
scopes. Configuring a test client is separate from meeting Google's publication,
verification and applicable security-assessment requirements.

Provider references: [Gmail message reads](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get),
[Drive shared drives](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives),
[Drive exports](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).
