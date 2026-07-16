# Deploy Polpo on Railway

This guide deploys the Polpo runtime and dashboard as two Railway services backed by PostgreSQL. The runtime service keeps a persistent workspace volume; the dashboard is the only public service and proxies runtime API calls server-side.

## Services

Create one Railway project with:

- `postgres`: Railway PostgreSQL.
- `runtime`: this repository, root `Dockerfile`.
- `dashboard`: this repository, `apps/dashboard/Dockerfile`.

Expose only the dashboard service.

## Runtime service

Build from the repository root with `Dockerfile`.

Attach one Railway volume to the runtime service:

- Mount path: `/app/workspace`

Set runtime variables:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
POLPO_API_KEY=<long-random-secret>
POLPO_MODEL=anthropic/claude-sonnet-4.5
AI_GATEWAY_API_KEY=<gateway-or-provider-key>
HOST=0.0.0.0
PORT=3890
WORK_DIR=/app/workspace
RAILWAY_RUN_UID=0
```

`RAILWAY_RUN_UID=0` avoids write permission issues with Railway volumes. The runtime entrypoint initializes `/app/workspace/.polpo/polpo.json` on first boot when the mounted volume is empty.

Healthcheck:

```text
/api/v1/health
```

Do not expose the runtime publicly unless you also put authentication and network controls in front of it.

## Dashboard service

Build from `apps/dashboard/Dockerfile`.

Set dashboard variables:

```env
POLPO_API_URL=http://runtime.railway.internal:3890
POLPO_API_KEY=<same-long-random-secret>
PORT=3000
```

Publish the dashboard domain, for example:

```text
https://staging.polpo.sh
```

## Notes

- Railway volumes are mounted when the service starts, not during image build or pre-deploy commands.
- Because the app workdir is under `/app`, mount persistent runtime data under `/app/workspace`.
- Railway allows one volume per service, so use it for the runtime workspace and keep durable state in PostgreSQL.
- The dashboard does not need a volume: it is stateless and talks to the runtime through its server-side proxy.
