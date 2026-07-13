# @polpo-ai/dashboard

Reusable v2 dashboard views for a Polpo runtime. The package contains only
project-scoped runtime UI; authentication, organizations, provisioning and
billing belong to the host application.

```tsx
<PolpoProvider baseUrl={origin} apiPrefix="/api/polpo">
  <DashboardProvider host={{ navigate, capabilities }}>
    <AgentsView />
  </DashboardProvider>
</PolpoProvider>
```

Self-hosted installations should keep `POLPO_API_KEY` server-side and proxy
dashboard requests to the runtime. Never expose privileged keys through a
`NEXT_PUBLIC_*` variable.
