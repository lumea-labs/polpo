# Polpo CLI

Create, link and deploy Polpo projects, and manage their runtime resources.

## Development and Production

Project commands default to **Development**. Production is always explicit:

```sh
polpo deploy
polpo deploy --prod
polpo deploy --env production
polpo link --project-id PROJECT_ID --env development
polpo data list --prod
polpo connections list --prod
polpo cloud-logs --prod --follow
```

`--env` accepts only `development` and `production`. `--prod --env development`
fails before authentication or writes. A previous Production command does not
change the default for the next invocation. The same options apply to tools,
Channels, volumes, Memory, BYOK, status, and skill commands with `--deploy`.
Organization administration remains outside a project environment.

There is one local definition tree, not one codebase per environment:

```text
.polpo/
  project.json
  agents/
  teams/
  loops/
  tools/
  skills/
  skills.lock.json
```

The selected target is not persisted in `project.json`. Deploy the same
definitions independently to either environment. Deploy does not discover or
upload local model keys, vault credentials, or learned memory. Configure those
explicitly in each target. Existing task/session import options are explicit
state transfers; `--all` includes those imports, never credentials or memory.
Link downloads definitions from the selected environment and creates a normal
Polpo key for that environment. Data uses that same key.

These commands require an environment-aware server: they send requests through
`/environments/<name>`. An unavailable or unauthorized target is an error;
there is no retry against Production or an unscoped endpoint.

```sh
polpo --help
polpo deploy --help
polpo connections mcp connect --help
```
