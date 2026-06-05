"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  RefreshCw,
  Users,
  ChevronRight,
  GitBranch,
  BookMarked,
  Terminal,
  Download,
} from "lucide-react";
import { usePolpoClient } from "@/lib/polpo-client";
import { CommandSnippet } from "@/components/dashboard/command-snippet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface SkillInfo {
  name: string;
  description: string;
  /** Scope — "project" on cloud (always), kept for back-compat. */
  source: string;
  assignedTo: string[];
  tags?: string[];
  category?: string;
}

export default function SkillsView({ initialSkills }: { initialSkills: SkillInfo[] }) {
  const { id } = useParams<{ id: string }>();

  const polpo = usePolpoClient(id);
  const { data: skills = [], isFetching, refetch } = useQuery({
    queryKey: ["skills", id],
    queryFn: () => polpo.getSkills() as unknown as Promise<SkillInfo[]>,
    initialData: initialSkills,
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Skills</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {skills.length} installed. Click a skill to view content.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <InstallSkillsDialog />
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Skills list */}
      {skills.length > 0 ? (
        <div className="mt-4 border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Skill</th>
                <th className="px-4 py-2.5 text-left font-medium w-48 hidden md:table-cell">Assigned to</th>
                <th className="px-4 py-2.5 text-left font-medium w-56 hidden lg:table-cell">Tags</th>
                <th className="px-4 py-2.5 w-8" />
              </tr>
            </thead>
            <tbody>
              {skills.map((skill) => (
                <tr key={skill.name} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="px-4 py-3">
                    <Link
                      href={`/projects/${id}/skills/${encodeURIComponent(skill.name)}`}
                      className="block"
                    >
                      <div>
                        <p className="font-medium">{skill.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                          {skill.description}
                        </p>
                      </div>
                    </Link>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    {skill.assignedTo.length > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                          {skill.assignedTo.join(", ")}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {skill.tags && skill.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {skill.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex h-5 items-center border border-border bg-muted/40 px-1.5 text-[10px] font-mono text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                        {skill.tags.length > 3 && (
                          <span className="text-[10px] text-muted-foreground/60">
                            +{skill.tags.length - 3}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground/40">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/projects/${id}/skills/${encodeURIComponent(skill.name)}`}>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-3 border border-dashed border-border p-10 text-center">
          <BookMarked className="h-5 w-5 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">No skills installed yet.</p>
          <InstallSkillsDialog />
        </div>
      )}
    </div>
  );
}

/**
 * Informational "how to install skills" dialog. Read-only for now — it
 * explains the install paths (registry / GitHub / SDK); wiring an in-app
 * installer comes later. Triggered by a button in the header and the
 * empty state.
 */
function InstallSkillsDialog() {
  return (
    <Dialog>
      <DialogTrigger className="inline-flex items-center gap-1.5 border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90">
        <Download className="h-3.5 w-3.5" strokeWidth={2} />
        Install skills
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install skills</DialogTitle>
          <DialogDescription>
            Skills inject domain knowledge into your agents&apos; prompts — no
            code changes. Install a pack, then assign it to agents.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 pt-1">
          {/* Registry */}
          <div>
            <div className="flex items-center gap-2">
              <BookMarked className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
              <h3 className="text-xs font-semibold uppercase tracking-wider">
                From the registry
              </h3>
            </div>
            <p className="mb-2 mt-1.5 text-xs text-muted-foreground">
              Clone a pre-built pack from{" "}
              <a
                href="https://skills.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                skills.sh
              </a>{" "}
              into <span className="font-mono">.polpo/skills/</span>.
            </p>
            <CommandSnippet command="git clone https://skills.sh/polpo-agents .polpo/skills/polpo-agents" />
          </div>

          {/* GitHub */}
          <div>
            <div className="flex items-center gap-2">
              <GitBranch className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
              <h3 className="text-xs font-semibold uppercase tracking-wider">
                From GitHub
              </h3>
            </div>
            <p className="mb-2 mt-1.5 text-xs text-muted-foreground">
              Any public repo with a skill pack works the same way.
            </p>
            <CommandSnippet command="git clone https://github.com/you/your-skills .polpo/skills/your-skills" />
          </div>

          {/* Deploy */}
          <div>
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
              <h3 className="text-xs font-semibold uppercase tracking-wider">
                Then deploy
              </h3>
            </div>
            <p className="mb-2 mt-1.5 text-xs text-muted-foreground">
              Sync the new skills, then assign them to agents.
            </p>
            <CommandSnippet command="polpo deploy" />
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground/60">
            Prefer code? Use{" "}
            <span className="font-mono">client.installSkills(url)</span> from the
            SDK.{" "}
            <a
              href="https://docs.polpo.sh/docs/ecosystem/skills-registry"
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              Full guide →
            </a>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
