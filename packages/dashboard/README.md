# @polpo-ai/dashboard

The self-hosted Polpo dashboard — the single-instance debugger UI for one Polpo
server: agents, tasks, missions, sessions, memory, skills, playbooks, schedules,
storage, logs and a chat playground.

It talks to your Polpo server through the public SDK (`@polpo-ai/sdk`). There is
no auth, billing, org or onboarding here — those are cloud-only. One server, one
dashboard.

## Run it

You need a running Polpo server (the data plane). Then:

```bash
cp .env.example .env.local      # point NEXT_PUBLIC_API_URL at your server
pnpm install
pnpm dev                        # http://localhost:3000
```

`/` redirects to `/projects/local/agents`. `local` is a placeholder project id —
single-tenant self-host has one project, and the data client ignores the id.

## Config

| Env var | Default | What |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `http://localhost:4000` | Your Polpo server base URL |
| `NEXT_PUBLIC_POLPO_API_PREFIX` | `/api` | Prepended to the views' `/v1/...` paths → `/api/v1/...` (the standalone server's mount) |
| `NEXT_PUBLIC_POLPO_API_KEY` | — | `sk_...` key for the server (optional if it runs without auth) |

## How the data layer works

Views address the data plane by path (`/v1/agents`, `/v1/tasks`, …). `lib/data-client.ts`
drives a single `PolpoClient` from `@polpo-ai/sdk` (transport, auth, errors) and
re-wraps the result in the `{ ok, data }` envelope the views expect. Swapping the
server is just `NEXT_PUBLIC_API_URL`.

## Not wired yet

A few shell/settings surfaces still reach for cloud-only control-plane endpoints
(project name, BYOK keys, billing). These are gated to single-tenant stubs so the
dashboard runs; see the `TODO` in `lib/data-client.ts`. BYOK will be re-pointed to
the data-plane `vault` route.
