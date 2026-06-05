import { api } from "#/lib/api";
import type { Project } from "#/lib/api";
import { SettingsForm } from "#/components/dashboard/settings-form";
import type { AutumnStatusResponse } from "#/components/dashboard/settings-form";

/**
 * Tenant data-plane URL. Mirrors the helper in connect-dialog.tsx so what
 * the user sees on the Settings tab matches what they wire into their CLI
 * / SDK / `curl` calls. Local dev gets the apex localhost so the dashboard
 * stays usable without DNS.
 */
function tenantApiUrl(slug?: string): string {
  if (!slug) return "—";
  if (process.env.NEXT_PUBLIC_API_URL?.includes("localhost")) {
    return `http://${slug}.polpo.localhost`;
  }
  return `https://${slug}.polpo.cloud`;
}

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Fetch project + Autumn integration status in parallel server-side. The
  // integration status is hydrated into the dashboard's TanStack Query cache
  // so the Integrations tab renders the connection state on first paint
  // without flashing a "Loading…" spinner.
  let project: Project | null = null;
  let autumnStatus: AutumnStatusResponse | null = null;
  try {
    const [projectRes, autumnRes] = await Promise.all([
      api<Project>(`/v1/projects/${id}`).catch(() => null),
      api<{ ok: boolean; data: AutumnStatusResponse | null }>(
        `/v1/integrations/${id}/autumn`,
      ).catch(() => null),
    ]);
    project = projectRes;
    autumnStatus = autumnRes?.data ?? null;
  } catch {}

  const apiEndpoint = tenantApiUrl(project?.slug);

  return (
    <SettingsForm
      projectId={id}
      projectName={project?.name ?? ""}
      projectSlug={project?.slug ?? ""}
      apiEndpoint={apiEndpoint}
      initialSettings={project?.settings}
      initialAutumnStatus={autumnStatus}
    />
  );
}
