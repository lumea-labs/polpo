# @polpo-ai/dashboard

Reusable Polpo v2 dashboard views for the single-tenant self-hosted dashboard and
embedding hosts. Views follow the managed Cloud design system; the parity check
tracks mapped components across repositories.

The package owns project-scoped runtime surfaces: agents, playground, sessions,
files, databases, memory, skills, and custom tools. The host application owns deployment
boundaries such as authentication, organizations, project provisioning,
billing, managed connections, and the managed model gateway.

```tsx
import {
  DashboardProvider,
  V2AgentsView,
  V2PageBody,
} from "@polpo-ai/dashboard";
import "@polpo-ai/dashboard/v2.css";

<PolpoProvider baseUrl="" apiPrefix="/api/polpo">
  <DashboardProvider
    host={{
      project: { id: "local", name: "Local runtime" },
      capabilities: {
        multiProject: false,
        billing: false,
        managedConnections: false,
        managedGateway: false,
        provisioning: false,
        data: true,
      },
      navigate,
      href,
    }}
  >
    <V2PageBody>
      <V2AgentsView projectId="local" initialAgents={[]} initialTeams={[]} />
    </V2PageBody>
  </DashboardProvider>
</PolpoProvider>
```

`apps/dashboard` is the reference self-hosted host. It proxies browser requests
to the runtime and keeps `POLPO_API_KEY` server-side. Never expose privileged
keys through a `NEXT_PUBLIC_*` variable.

## Databases

`V2DataView` includes its own page layout and uses the SDK client from `PolpoProvider`.
The reference host mounts it at `/data`, linked as **Databases**. Its Schema selector
chooses a logical database; tables appear beside the record, SQL query and migration
views. Database and record mutations retain version checks and retry semantics from
the shared Data API.

Set `POLPO_DATA_DATABASE_URL` on the runtime to configure a separate PostgreSQL
application database. The existing runtime API key authorizes dashboard requests.
An embedding host can hide Databases with `capabilities.data: false`; the capability
does not configure or authorize Data on the server.

The self-hosted view uses a single configured backend. Cloud Live/Test selection,
Neon provisioning status and managed grant editors are host-specific. Self-hosted
agent grants remain trusted runtime configuration. See
[Application Data](../../docs/data.md) for setup, supported SQL and permissions.

## Parity

Run `pnpm check:dashboard-parity` from the repository root while a Polpo Cloud
checkout is available. Set `POLPO_CLOUD_DASHBOARD_ROOT` when the Cloud dashboard
is not at the default sibling path. The check compares the shared CSS and the
JSX structure of mapped Cloud v2 components while allowing explicit host
adapters.
