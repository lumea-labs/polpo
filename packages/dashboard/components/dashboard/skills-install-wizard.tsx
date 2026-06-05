"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookMarked,
  Check,
  Download,
  FilePlus2,
  Link2,
  Loader2,
  Search,
} from "lucide-react";
import { usePolpoClient } from "../../lib/polpo-client";
import {
  SkillsProvider,
  SkillCreateForm,
  type SkillsAdapter,
  type SkillCreateInput,
  type Skill,
} from "@lumea-labs/skills";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";

/**
 * SkillsInstallWizard — replaces the old read-only "how to install" dialog
 * with a real, guided stepper that ACTUALLY installs skills, dogfooding the
 * public SDK end to end:
 *   - registry browse  → the Mastra `skills-api` / skills.sh registry (the
 *     browse surface Polpo itself doesn't expose) → client.installSkills(url)
 *   - from a URL        → client.installSkills(githubUrl)
 *   - paste / create    → @lumea-labs/skills <SkillCreateForm> over the
 *     Polpo-wired adapter (adapter.createSkill)
 *
 * The wizard lives inside <SkillsProvider adapter={polpoAdapter}> so the
 * lumea-agents skills UI (SkillCreateForm here, more later) is wired to Polpo.
 */

const SKILLS_API = "https://skills.sh/api/skills";

type Source = "registry" | "url" | "paste";

interface RegistrySkill {
  id?: string;
  name: string;
  description?: string;
  owner?: string;
  repo?: string;
  repository?: string;
  repositoryUrl?: string;
  installs?: number;
}

/** Best-effort GitHub source for a skills.sh registry record. */
function sourceFor(s: RegistrySkill): string {
  if (s.repositoryUrl) return s.repositoryUrl;
  if (s.repository?.startsWith("http")) return s.repository;
  if (s.owner && s.repo) return `https://github.com/${s.owner}/${s.repo}`;
  return s.repository ?? s.name;
}

export function SkillsInstallWizard() {
  return <WizardDialog />;
}

function WizardDialog() {
  const { id } = useParams<{ id: string }>();
  const client = usePolpoClient(id);
  const qc = useQueryClient();

  // Minimal SkillsAdapter built directly on the PolpoClient (the same seam
  // usePolpoClient resolves: OSS direct, cloud session-proxy). Avoids
  // @polpo-ai/react's <PolpoProvider>. Only createSkill is needed here —
  // registry/URL installs go through client.installSkills directly.
  const adapter = useMemo<SkillsAdapter>(
    () => ({
      createSkill: async (input: SkillCreateInput): Promise<Skill> => {
        const res = await client.createSkill({
          name: input.name,
          description: input.description,
          content: input.body,
          allowedTools: (input.frontmatter as { allowedTools?: string[] })?.allowedTools,
        });
        return { id: res.name, name: res.name, description: input.description, installed: true } as Skill;
      },
    }),
    [client],
  );

  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [search, setSearch] = useState("");
  const [url, setUrl] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const reset = () => {
    setSource(null);
    setSearch("");
    setUrl("");
    setDone(null);
    install.reset();
  };

  const { data: registry = [], isFetching, error: regError } = useQuery({
    queryKey: ["skills-registry", search],
    queryFn: async (): Promise<RegistrySkill[]> => {
      const u = new URL(SKILLS_API);
      u.searchParams.set("sortBy", "installs");
      u.searchParams.set("pageSize", "30");
      if (search.trim()) u.searchParams.set("query", search.trim());
      const res = await fetch(u.toString());
      if (!res.ok) throw new Error(`registry ${res.status}`);
      const json = await res.json();
      return (json.skills ?? json.data ?? json.results ?? json) as RegistrySkill[];
    },
    enabled: open && source === "registry",
    staleTime: 60_000,
  });

  const install = useMutation({
    mutationFn: (src: string) => client.installSkills(src),
    onSuccess: (_res, src) => {
      qc.invalidateQueries({ queryKey: ["skills", id] });
      setDone(src);
    },
  });

  const afterCreate = () => {
    qc.invalidateQueries({ queryKey: ["skills", id] });
    setDone("created");
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger className="inline-flex items-center gap-1.5 border border-foreground bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-colors hover:bg-foreground/90">
        <Download className="h-3.5 w-3.5" strokeWidth={2} />
        Install skills
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Install skills</DialogTitle>
          <DialogDescription>
            Skills inject domain knowledge into your agents&apos; prompts — no code
            changes. Pick a source, install, then assign to agents.
          </DialogDescription>
        </DialogHeader>

        {/* ── Result ─────────────────────────────────────────── */}
        {done ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <div className="grid h-10 w-10 place-items-center rounded-full bg-emerald-500/15 text-emerald-500">
              <Check className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">Skill installed</p>
            <p className="max-w-sm font-mono text-[11px] text-muted-foreground break-all">{done}</p>
            <div className="mt-2 flex gap-2">
              <button onClick={reset} className="border border-border px-3 py-1.5 text-xs hover:border-foreground/30">
                Install another
              </button>
              <button onClick={() => setOpen(false)} className="border border-foreground bg-foreground px-3 py-1.5 text-xs text-background hover:bg-foreground/90">
                Done
              </button>
            </div>
          </div>
        ) : !source ? (
          /* ── Step 1: choose a source ──────────────────────── */
          <div className="grid gap-2 pt-1">
            <SourceCard
              icon={<BookMarked className="h-4 w-4" />}
              title="Browse the registry"
              desc="34k+ skills from skills.sh — search and install."
              onClick={() => setSource("registry")}
            />
            <SourceCard
              icon={<Link2 className="h-4 w-4" />}
              title="From a URL"
              desc="Any public GitHub repo with a skill pack."
              onClick={() => setSource("url")}
            />
            <SourceCard
              icon={<FilePlus2 className="h-4 w-4" />}
              title="Paste / create"
              desc="Author a skill inline from its contents."
              onClick={() => setSource("paste")}
            />
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1">
            <button onClick={() => { setSource(null); install.reset(); }} className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> Back
            </button>

            {/* ── Registry ──────────────────────────────────── */}
            {source === "registry" && (
              <>
                <div className="flex items-center gap-2 border border-border px-2.5">
                  <Search className="h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search skills…"
                    className="w-full bg-transparent py-2 text-sm outline-none"
                  />
                </div>
                {isFetching ? (
                  <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> loading registry…</div>
                ) : regError ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">Registry unavailable. Try the URL option.</p>
                ) : (
                  <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
                    {registry.map((s) => (
                      <li key={s.id ?? `${s.owner}/${s.repo}/${s.name}`} className="flex items-center justify-between gap-3 border border-border px-3 py-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{s.name}</div>
                          {s.description && <div className="truncate text-[11px] text-muted-foreground">{s.description}</div>}
                        </div>
                        <button
                          disabled={install.isPending}
                          onClick={() => install.mutate(sourceFor(s))}
                          className="shrink-0 border border-foreground bg-foreground px-2.5 py-1 text-[11px] text-background hover:bg-foreground/90 disabled:opacity-50"
                        >
                          {install.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Install"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {/* ── URL ────────────────────────────────────────── */}
            {source === "url" && (
              <form
                onSubmit={(e) => { e.preventDefault(); if (url.trim()) install.mutate(url.trim()); }}
                className="flex flex-col gap-2"
              >
                <input
                  value={url}
                  autoFocus
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://github.com/you/your-skills"
                  className="border border-border px-3 py-2 text-sm outline-none focus:border-foreground/30"
                />
                <button
                  type="submit"
                  disabled={!url.trim() || install.isPending}
                  className="inline-flex items-center justify-center gap-1.5 border border-foreground bg-foreground px-3 py-2 text-xs text-background hover:bg-foreground/90 disabled:opacity-50"
                >
                  {install.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  Install
                </button>
                {install.isError && <p className="text-xs text-destructive">{(install.error as Error).message}</p>}
              </form>
            )}

            {/* ── Paste / create (dogfood lumea-agents UI) ──── */}
            {source === "paste" && (
              <SkillsProvider adapter={adapter}>
                <SkillCreateForm onCreated={afterCreate} onCancel={() => setSource(null)} />
              </SkillsProvider>
            )}

            {install.isError && source === "registry" && (
              <p className="text-xs text-destructive">{(install.error as Error).message}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({ icon, title, desc, onClick }: { icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-start gap-3 border border-border px-4 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-secondary/30"
    >
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{desc}</span>
      </span>
    </button>
  );
}
