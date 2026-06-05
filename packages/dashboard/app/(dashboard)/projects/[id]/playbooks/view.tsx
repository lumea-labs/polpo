"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { RefreshCw, Search, Play, Loader2, Trash2, Workflow, AlertTriangle } from "lucide-react";
import { usePolpoClient } from "#/lib/polpo-client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "#/components/ui/dialog";

interface PlaybookParam {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

interface Playbook {
  name: string;
  description: string;
  mission: {
    prompt?: string;
    tasks: { title: string; assignTo: string; description?: string; dependsOn?: string[] }[];
  };
  parameters?: PlaybookParam[];
  version?: string;
  author?: string;
  tags?: string[];
}

export default function PlaybooksView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const polpo = usePolpoClient(id);
  const { data: playbooks = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ["playbooks", id],
    queryFn: () => polpo.getPlaybooks() as unknown as Promise<Playbook[]>,
  });

  const deleteMutation = useMutation({
    mutationFn: (name: string) => polpo.deletePlaybook(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playbooks", id] });
      setDeleteTarget(null);
    },
  });

  const filtered = useMemo(() => {
    if (!search) return playbooks;
    const q = search.toLowerCase();
    return playbooks.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.description?.toLowerCase().includes(q)
    );
  }, [playbooks, search]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-20 rounded-lg bg-secondary/30 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Playbooks</h2>
          <p className="mt-1 text-xs text-muted-foreground">{playbooks.length} total</p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {/* Search */}
      {playbooks.length > 0 && (
        <div className="mt-3 relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search playbooks..."
            className="h-8 w-full max-w-xs rounded-md border border-border bg-transparent pl-8 pr-3 text-xs focus:border-foreground/30 focus:outline-none transition-colors"
          />
        </div>
      )}

      {/* List */}
      {filtered.length > 0 ? (
        <div className="mt-4 space-y-2">
          {filtered.map((playbook) => {
            const params = playbook.parameters ?? [];
            const taskCount = playbook.mission?.tasks?.length ?? 0;

            return (
              <div
                key={playbook.name}
                className="border border-border bg-card px-4 py-3 hover:border-foreground/10 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    {/* Name + badges */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <Workflow className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <Link href={`/projects/${id}/playbooks/${encodeURIComponent(playbook.name)}`} className="font-mono text-sm font-semibold hover:underline underline-offset-2">{playbook.name}</Link>
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                        {taskCount} task{taskCount !== 1 ? "s" : ""}
                      </span>
                      {params.length > 0 && (
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                          {params.length} param{params.length !== 1 ? "s" : ""}
                        </span>
                      )}
                      {playbook.version && (
                        <span className="text-[10px] text-muted-foreground/50">v{playbook.version}</span>
                      )}
                    </div>
                    {/* Description */}
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                      {playbook.description}
                    </p>
                    {/* Param tags */}
                    {params.length > 0 && (
                      <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                        {params.map(p => (
                          <span
                            key={p.name}
                            className="rounded border border-border px-1.5 py-0.5 text-[9px] font-mono text-muted-foreground"
                          >
                            {p.required && <span className="text-red-400 mr-0.5">*</span>}
                            {p.name}
                            {p.default !== undefined && (
                              <span className="text-muted-foreground/40">={String(p.default)}</span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Tags */}
                    {playbook.tags && playbook.tags.length > 0 && (
                      <div className="mt-1.5 flex gap-1">
                        {playbook.tags.map(t => (
                          <span key={t} className="rounded bg-foreground/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                </div>
              </div>
            );
          })}
        </div>
      ) : playbooks.length > 0 ? (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          No playbooks match your search.
        </div>
      ) : (
        <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
          <Workflow className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
          No playbooks yet.
        </div>
      )}
      {/* Delete dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <DialogTitle>Delete playbook</DialogTitle>
            </div>
            <DialogDescription>
              Are you sure you want to delete <span className="font-mono font-medium text-foreground">{deleteTarget}</span>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<button className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" />}
            >
              Cancel
            </DialogClose>
            <button
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget)}
              disabled={deleteMutation.isPending}
              className="inline-flex items-center gap-2 bg-destructive text-destructive-foreground px-4 py-1.5 text-xs font-medium transition-all hover:opacity-90 disabled:opacity-50 rounded-md"
            >
              {deleteMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
