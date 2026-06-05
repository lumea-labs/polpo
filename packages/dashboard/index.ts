/**
 * Public surface of @polpo-ai/dashboard — the per-project views plus the
 * data-client seam, for a host app (e.g. the cloud dashboard) to render inside
 * its own shell with its own transport injected via <DataClientProvider>.
 *
 * Phase-2 pilot: the agents view. The remaining views follow the same shape
 * (default-exported `<XView>` + a server `page.tsx` that fetches initial data).
 */

export { DataClientProvider, createPolpoClient } from "./lib/polpo-client";
export type { PolpoClientFactory } from "./lib/polpo-client";

export { default as AgentsView } from "./app/(dashboard)/projects/[id]/agents/view";
export type { Team } from "./app/(dashboard)/projects/[id]/agents/view";

export { default as SkillsView } from "./app/(dashboard)/projects/[id]/skills/view";
export type { SkillInfo } from "./app/(dashboard)/projects/[id]/skills/view";
