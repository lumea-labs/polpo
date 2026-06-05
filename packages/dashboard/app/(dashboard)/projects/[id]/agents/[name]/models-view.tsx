import type { AgentConfig } from "@polpo-ai/core";
import { AgentCapabilities } from "../../../../../../components/dashboard/agent-capabilities";

/** Models tab — the per-capability model grid (one row per modality). */
export default function AgentModelsView({
  agent,
  projectId,
  agentName,
}: {
  agent: AgentConfig | null;
  projectId: string;
  agentName: string;
}) {
  if (!agent) {
    return (
      <div
        data-testid="agent-not-found"
        className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground"
      >
        Agent not found.
      </div>
    );
  }

  return (
    <section className="pt-2">
      <AgentCapabilities agent={agent} projectId={projectId} agentName={agentName} />
    </section>
  );
}
