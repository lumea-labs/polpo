"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, FilePlus2, Link2, Loader2 } from "lucide-react";
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
 * SkillsInstallWizard — guided stepper that actually installs skills, dogfooding
 * the SDK end to end:
 *   - From a URL    → client.installSkills(githubUrl)
 *   - Paste/create  → @lumea-labs/skills <SkillCreateForm> over a minimal
 *     SkillsAdapter built on the PolpoClient (adapter.createSkill).
 *
 * (Registry browse via Mastra's @mastra/skills-api is a future addition — it's a
 * Node lib with bundled data, so it needs a server action, not a browser fetch.)
 */

type Source = "url" | "paste";

export function SkillsInstallWizard() {
  return <WizardDialog />;
}

function WizardDialog() {
  const { id } = useParams<{ id: string }>();
  const client = usePolpoClient(id);
  const qc = useQueryClient();

  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [url, setUrl] = useState("");
  const [done, setDone] = useState<string | null>(null);

  // Minimal SkillsAdapter on the PolpoClient (same de-dup seam usePolpoClient
  // resolves: OSS direct, cloud session-proxy). Only createSkill is needed.
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

  const install = useMutation({
    mutationFn: (src: string) => client.installSkills(src),
    onSuccess: (_res, src) => {
      qc.invalidateQueries({ queryKey: ["skills", id] });
      setDone(src);
    },
  });

  const reset = () => {
    setSource(null);
    setUrl("");
    setDone(null);
    install.reset();
  };

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
          <div className="grid gap-2 pt-1">
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
            <button
              onClick={() => { setSource(null); install.reset(); }}
              className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" /> Back
            </button>

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

            {source === "paste" && (
              <SkillsProvider adapter={adapter}>
                <SkillCreateForm onCreated={afterCreate} onCancel={() => setSource(null)} />
              </SkillsProvider>
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
