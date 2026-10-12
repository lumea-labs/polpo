# @polpo-ai/connectors

Curated connector provider definitions for Polpo Connect.

The compatibility catalog includes:

- API Key
- GitHub
- Slack
- Google Drive
- Gmail
- MCP Server URL
- a factory for custom OAuth2 connectors

`gmailDefinition` and `googleDriveDefinition` are the version 2 read-only API
definitions for the new curated experience. They declare OAuth independently
of protocol and do not contain managed client credentials. The old
`googleDriveConnector` remains available for compatibility; hosts must choose
and migrate explicitly before substituting its broader historical policy.

`executeGoogleAction` implements Gmail message search/read and Drive file
search/read through a host-provided `ConnectorActionGateway`. No handler gets a
provider token. Bind that gateway to the authorized Connection and enforce
grants before invoking the handler.

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
