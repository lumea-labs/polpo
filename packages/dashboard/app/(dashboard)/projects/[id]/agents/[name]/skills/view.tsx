import Link from "next/link";
import type { AgentConfig } from "@polpo-ai/core";
import { BookMarked, ExternalLink } from "lucide-react";
import { SectionHeader } from "#/components/dashboard/section-header";

export default function AgentSkillsView({
  agent,
  projectId,
}: {
  agent: AgentConfig | null;
  projectId: string;
}) {
  if (!agent) {
    return (
      <div
        data-testid="agent-not-found"
        className="border border-border p-8 text-center text-sm text-muted-foreground"
      >
        Agent not found.
      </div>
    );
  }

  const skills = agent.skills ?? [];

  return (
    <div>
      <SectionHeader
        description={
          <>
            Installed skills extend this agent with reusable procedures. Manage
            them with <span className="font-mono">polpo install</span> or in the
            agent config <span className="font-mono">skills</span> field.
          </>
        }
      />

      {skills.length === 0 ? (
        <div className="mt-4 border border-dashed border-border p-8 text-center">
          <BookMarked
            className="mx-auto h-5 w-5 text-muted-foreground/40"
            strokeWidth={1.5}
          />
          <p className="mt-2 text-sm text-muted-foreground">No skills installed.</p>
          <p className="mt-1 text-xs text-muted-foreground/60">
            Browse the catalog at{" "}
            <a
              href="https://docs.polpo.sh/docs/agents/skills"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
            >
              docs.polpo.sh
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <Link
              key={skill}
              href={`/projects/${projectId}/skills/${encodeURIComponent(skill)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-center gap-2.5 border border-border bg-card p-3 transition-colors hover:border-foreground/30"
            >
              <span className="grid size-7 shrink-0 place-items-center bg-secondary text-muted-foreground">
                <BookMarked className="h-3.5 w-3.5" strokeWidth={1.5} />
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">
                {skill}
              </span>
              <ExternalLink
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground"
                strokeWidth={1.5}
              />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
