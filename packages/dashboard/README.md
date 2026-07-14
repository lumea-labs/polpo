# @polpo-ai/dashboard

Reusable Polpo v2 dashboard views. The package is the shared visual source for
the managed Cloud dashboard and the single-tenant self-hosted dashboard.

The package owns project-scoped runtime surfaces: agents, playground, sessions,
files, memory, skills, and custom tools. The host application owns deployment
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

## Parity

Run `pnpm check:dashboard-parity` from the repository root while a Polpo Cloud
checkout is available. Set `POLPO_CLOUD_DASHBOARD_ROOT` when the Cloud dashboard
is not at the default sibling path. The check compares the shared CSS and the
JSX structure of mapped Cloud v2 components while allowing explicit host
adapters.
