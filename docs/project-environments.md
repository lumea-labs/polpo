# Development and Production

An environment is a runtime boundary. It owns its execution, persistent state,
files and credentials. A selector in a URL is only a request to that runtime;
it never grants permission or provisions resources.

The public names are `development` and `production`. A normal Polpo API key
authorizes its environment across agents, Data and other permitted resources.
Data has no separate key or independent environment selector.

## Clients and CLI

Use `environment` in the [SDK](../packages/client-sdk/README.md) or
[React provider](../packages/react-sdk/README.md). Without it, those clients
follow the credential/endpoint instead of guessing Development. Construct a
separate client for each environment. React resets the provider's children and
resource store when its target changes.

The [CLI](../packages/cli/README.md) defaults to Development. Production requires
`--prod` or `--env production` on each invocation. Existing Production CI jobs
must make that target explicit when upgrading. `.polpo/project.json` does not
store a sticky environment; the same definition tree deploys separately to
either target. Deploy does not transfer credentials or accumulated memory.

Cloud login distinguishes the administrator's CLI authorization from ordinary
environment keys. CI can validate a key and discover its authorized projects
without organization-wide administration. A Production key does not change the
CLI default: `--prod` remains required. The server verifies authority for every
request; discovery is a local preflight, not a cached permission grant. These
flows require the matching Cloud implementation and coordinated release.

## Self-hosted runtime

Bind each process explicitly when constructing a server:

```ts
import { PolpoServer } from "@polpo-ai/node/server";

const server = new PolpoServer({
  port: 3890,
  host: "127.0.0.1",
  workDir: "/srv/polpo-development",
  environment: "development",
  apiKeys: [process.env.POLPO_DEVELOPMENT_KEY!],
});
await server.start();
```

The Docker entrypoint accepts `POLPO_PROJECT_ENVIRONMENT=development` or
`production`. Each process needs a separate work directory, backing stores and
credentials. Setting the variable does not create those resources. For capacity
isolation, assign independent container/compute budgets as well.

The explicit HTTP paths are:

```text
/environments/development/api/v1/agents
/environments/development/v1/chat/completions
```

CLI self-hosted origins ending in `/api` also work through
`/api/environments/development/v1/...`. The normal authentication and validation
still apply. A bound Development process rejects Production requests, including
requests made with its own valid key. Unsupported selectors are rejected before
resource access; no fallback chooses a different runtime.

Unscoped endpoints remain available for existing clients. A legacy server with
no bound identity rejects explicit environment paths; configure its intended
identity before using the new CLI against it. That prevents an existing
Production runtime from being silently relabeled Development.

## Implementation status

This branch contains the OSS transport, CLI, React and fixed-runtime contracts.
Cloud provisioning, authenticated routing to dedicated processes, migration of
existing projects/keys and the dashboard selector are separate required work.
No managed isolation or rollout is implied by installing these packages.
