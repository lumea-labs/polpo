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

`polpo login` authorizes the CLI as the approving administrator. Cloud checks
that user's current organization membership on subsequent requests. For CI,
`polpo login --api-key KEY` accepts an ordinary environment key and discovers
only its authorized projects; it does not grant organization administration.
A Production key still requires `--prod`. Deploy and link reject a mismatched
key before local writes. Existing Live/Test keys need an explicit migration
or replacement; their names or prefixes never select Development.

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
Link downloads definitions from the selected environment. With an administrator
login it creates a normal Polpo key for that environment; with an environment
key it uses the existing CLI credential without creating another key or copying
it into `.env.local`. Data uses the same ordinary environment key.

These commands require an environment-aware server: they send requests through
`/environments/<name>`. An unavailable or unauthorized target is an error;
there is no retry against Production or an unscoped endpoint.

```sh
polpo --help
polpo deploy --help
polpo connections mcp connect --help
```
