"use client";

/**
 * Add-a-skill surface — mirrors the "New agent" pattern so the two read the
 * same. Two starting points:
 *   • Install — pull an Open Skills / GitHub-compatible source into the project.
 *   • Describe — hand a custom skill off to the side builder (same mechanism as
 *     New agent: opens the builder and sends the message, which builds it).
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "../host";
import { toast } from "../host";
import {
  CircleNotch,
  DownloadSimple,
  Sparkle,
  ArrowRight,
  ArrowSquareOut,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { useCopilot } from "../host";

export function CreateSkillDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const polpo = usePolpoClient(projectId);
  const queryClient = useQueryClient();
  const { openChat } = useCopilot();
  const [tab, setTab] = useState<"install" | "describe">("install");
  const [source, setSource] = useState("");
  const [desc, setDesc] = useState("");

  const install = useMutation({
    mutationFn: () =>
      polpo.installSkills(source.trim()) as Promise<{ installed?: unknown[] }>,
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ["skills", projectId] });
      const n = r.installed?.length ?? 0;
      toast.success(`Installed ${n} skill${n === 1 ? "" : "s"}`);
      setSource("");
      onOpenChange(false);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Failed to install"),
  });

  // Custom skill → same handoff as New agent: open the builder, send the brief.
  const describe = () => {
    const t = desc.trim();
    if (!t) return;
    onOpenChange(false);
    openChat({
      kind: "skill",
      prompt: `Create a custom skill for this project and install it.\n\nWhat it should do:\n${t}`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[18px] font-semibold tracking-tight text-foreground">
            Add a skill
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Install one from a source, or describe a custom one and let the
            builder create it.
          </DialogDescription>
        </DialogHeader>

        {/* segmented control — same idiom as New agent */}
        <div className="inline-flex rounded-md border border-border p-0.5 text-[13px]">
          {(["install", "describe"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`rounded px-3 py-1 font-medium transition-colors ${
                tab === t
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t === "install" ? "Install" : "Describe"}
            </button>
          ))}
        </div>

        {tab === "install" ? (
          <div className="flex flex-col gap-2.5">
            <input
              autoFocus
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && source.trim()) install.mutate();
              }}
              placeholder="owner/repo, a GitHub URL, or a skill source"
              className="h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
            />
            <Button
              onClick={() => install.mutate()}
              disabled={!source.trim() || install.isPending}
              className="gap-1.5"
            >
              {install.isPending ? (
                <>
                  <CircleNotch size={15} className="animate-spin" /> Installing…
                </>
              ) : (
                <>
                  <DownloadSimple size={15} /> Install skill
                </>
              )}
            </Button>
            {install.isError && (
              <p className="text-[12px] text-destructive">
                {install.error instanceof Error
                  ? install.error.message
                  : "Install failed"}
              </p>
            )}
            <p className="text-[12px] leading-5 text-muted-foreground">
              Compatible with{" "}
              <a
                href="https://skills.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-medium text-brand underline-offset-2 hover:underline"
              >
                Open Skills <ArrowSquareOut size={11} />
              </a>{" "}
              — any GitHub-compatible skill source works. It can take a few
              seconds.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <textarea
              autoFocus
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") describe();
              }}
              placeholder="Summarize a GitHub PR into release notes, formatted for our changelog."
              className="min-h-[112px] w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[13px] leading-6 text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
            />
            <Button onClick={describe} disabled={!desc.trim()} className="gap-1.5">
              <Sparkle size={15} weight="fill" /> Create it in the builder
              <ArrowRight size={15} weight="bold" />
            </Button>
            <p className="text-[12px] leading-5 text-muted-foreground">
              Opens the builder and sends your brief — it writes the skill and
              installs it, ready to assign to agents.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
