"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Play, Loader2, AlertTriangle, Workflow, Braces, Copy, Check, GitBranch, List } from "lucide-react";
import type { Task } from "@polpo-ai/core";
import { usePolpoClient } from "../../../../../../lib/polpo-client";
import { MissionGraph } from "../../../../../../components/dashboard/mission-graph";
import { ManualRefreshButton } from "../../../../../../components/dashboard/manual-refresh-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "../../../../../../components/ui/dialog";

interface PlaybookParam {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
}

interface PlaybookTask {
  title: string;
  assignTo: string;
  description?: string;
  dependsOn?: string[];
}

interface Playbook {
  name: string;
  description: string;
  mission: {
    prompt?: string;
    tasks: PlaybookTask[];
  };
  parameters?: PlaybookParam[];
  version?: string;
  author?: string;
  tags?: string[];
}

function highlightJson(json: string): string {
  return json.replace(
    /("(?:\\.|[^"\\])*")\s*(:)?|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, str, colon, bool, num) => {
      if (str) {
        if (colon) return `<span style="color:oklch(0.75 0.1 250)">${str}</span>:`;
        return `<span style="color:oklch(0.75 0.15 155)">${str}</span>`;
      }
      if (bool) return `<span style="color:oklch(0.7 0.15 30)">${bool}</span>`;
      if (num) return `<span style="color:oklch(0.8 0.12 80)">${num}</span>`;
      return match;
    },
  );
}

export default function PlaybookDetailView() {
  const { id, name } = useParams<{ id: string; name: string }>();
  const decodedName = decodeURIComponent(name);
  const router = useRouter();
  const queryClient = useQueryClient();

  const [view, setView] = useState<"graph" | "tasks" | "json">("graph");
  const [showRun, setShowRun] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const polpo = usePolpoClient(id);
  const { data: playbook = null, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["playbook", id, decodedName],
    queryFn: () => polpo.getPlaybook(decodedName) as unknown as Promise<Playbook | null>,
  });

  const runMutation = useMutation({
    mutationFn: (params: Record<string, string | number | boolean>) =>
      polpo.runPlaybook(decodedName, params),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["missions", id] });
      setShowRun(false);
      if (data?.mission?.id) {
        router.push(`/projects/${id}/missions/${data.mission.id}`);
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => polpo.deletePlaybook(decodedName),
    onSuccess: () => {
      router.push(`/projects/${id}/playbooks`);
    },
  });

  function handleRun() {
    if (!playbook) return;
    const params: Record<string, string | number | boolean> = {};
    for (const p of playbook.parameters ?? []) {
      const raw = paramValues[p.name];
      if (!raw && !p.required) continue;
      if (p.type === "number") params[p.name] = Number(raw);
      else if (p.type === "boolean") params[p.name] = raw === "true";
      else params[p.name] = raw;
    }
    runMutation.mutate(params);
  }

  const missingRequired = playbook
    ? (playbook.parameters ?? []).filter(p => p.required && !paramValues[p.name]?.trim())
    : [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => <div key={i} className="h-16 rounded-lg bg-secondary/30 animate-pulse" />)}
      </div>
    );
  }

  if (!playbook) {
    return (
      <div className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Playbook not found.
      </div>
    );
  }

  const params = playbook.parameters ?? [];
  const tasks = playbook.mission?.tasks ?? [];

  // Build fake Task objects for the graph
  const fakeTasks = tasks.map((t, i) => ({
    id: `pb-${i}`,
    title: t.title,
    assignTo: t.assignTo,
    description: t.description ?? "",
    status: "draft" as const,
    dependsOn: (t.dependsOn ?? []).map(dep => {
      const depIdx = tasks.findIndex(tt => tt.title === dep);
      return depIdx >= 0 ? `pb-${depIdx}` : dep;
    }),
    retries: 0,
    maxRetries: 3,
    expectations: [],
    metrics: [],
    createdAt: "",
    updatedAt: "",
  }));

  return (
    <div>
      {/* Back */}
      <Link
        href={`/projects/${id}/playbooks`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Playbooks
      </Link>

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Workflow className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-mono text-lg font-extrabold tracking-tight">{playbook.name}</h2>
            {playbook.version && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                v{playbook.version}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{playbook.description}</p>

          {/* Meta */}
          <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
            <span>{tasks.length} task{tasks.length !== 1 ? "s" : ""}</span>
            <span>{params.length} param{params.length !== 1 ? "s" : ""}</span>
            {playbook.author && <span>by {playbook.author}</span>}
          </div>

          {/* Tags */}
          {playbook.tags && playbook.tags.length > 0 && (
            <div className="mt-2 flex gap-1">
              {playbook.tags.map(t => (
                <span key={t} className="rounded bg-foreground/5 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <ManualRefreshButton onRefresh={() => refetch()} isRefreshing={isFetching} className="mt-1 shrink-0" />
      </div>

      {/* Parameters */}
      {params.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">Parameters</h3>
          <div className="border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium w-20">Type</th>
                  <th className="px-4 py-2 text-left font-medium w-16">Required</th>
                  <th className="px-4 py-2 text-left font-medium w-24">Default</th>
                  <th className="px-4 py-2 text-left font-medium hidden sm:table-cell">Description</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {params.map(p => (
                  <tr key={p.name} className="border-b border-border last:border-0">
                    <td className="px-4 py-2.5 font-medium">
                      {p.name}
                      {p.enum && (
                        <span className="text-muted-foreground/40 font-normal ml-1">
                          [{p.enum.join(", ")}]
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">{p.type ?? "string"}</td>
                    <td className="px-4 py-2.5">
                      {p.required ? <span className="text-red-400">yes</span> : <span className="text-muted-foreground/30">no</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground/60">
                      {p.default !== undefined ? String(p.default) : "\u2014"}
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground font-sans hidden sm:table-cell">{p.description ?? "\u2014"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Task view */}
      <section className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Mission template</h3>
          <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-1">
            {([
              { key: "graph" as const, icon: GitBranch, label: "Graph" },
              { key: "tasks" as const, icon: List, label: "Tasks" },
              { key: "json" as const, icon: Braces, label: "JSON" },
            ]).map(tab => (
              <button
                key={tab.key}
                onClick={() => setView(tab.key)}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  view === tab.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {view === "graph" ? (
          <MissionGraph tasks={fakeTasks as unknown as Task[]} projectId={id} readonly />
        ) : view === "json" ? (
          <div className="border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/40">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Playbook JSON</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(JSON.stringify(playbook, null, 2));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre
              className="p-4 text-xs font-mono overflow-y-auto max-h-[560px] whitespace-pre-wrap break-all"
              dangerouslySetInnerHTML={{ __html: highlightJson(JSON.stringify(playbook, null, 2)) }}
            />
          </div>
        ) : (
          <div className="border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium w-8">#</th>
                  <th className="px-4 py-2.5 text-left font-medium">Task</th>
                  <th className="px-4 py-2.5 text-left font-medium w-24">Agent</th>
                  <th className="px-4 py-2.5 text-left font-medium hidden sm:table-cell">Dependencies</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {tasks.map((task, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted-foreground/40">{i + 1}</td>
                    <td className="px-4 py-3">
                      <span className="font-medium">{task.title}</span>
                      {task.description && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 font-sans">{task.description}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{task.assignTo}</td>
                    <td className="px-4 py-3 text-muted-foreground/50 hidden sm:table-cell">
                      {task.dependsOn?.join(", ") ?? "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Run dialog */}
      <Dialog open={showRun} onOpenChange={setShowRun}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <Play className="h-4 w-4" />
              <DialogTitle>Run {playbook.name}</DialogTitle>
            </div>
            <DialogDescription>{playbook.description}</DialogDescription>
          </DialogHeader>

          {params.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">This playbook takes no parameters.</p>
          ) : (
            <div className="space-y-3 py-2">
              {params.map(p => (
                <div key={p.name}>
                  <label className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">
                    {p.name}
                    {p.required && <span className="text-red-400">*</span>}
                    <span className="text-muted-foreground/40 normal-case tracking-normal ml-1">{p.type ?? "string"}</span>
                  </label>
                  {p.type === "boolean" ? (
                    <select
                      value={paramValues[p.name] ?? ""}
                      onChange={(e) => setParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                      className="w-full h-8 rounded-md border border-border bg-background px-3 text-xs font-mono focus:border-foreground/30 focus:outline-none"
                    >
                      <option value="">Select...</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : p.enum && p.enum.length > 0 ? (
                    <select
                      value={paramValues[p.name] ?? ""}
                      onChange={(e) => setParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                      className="w-full h-8 rounded-md border border-border bg-background px-3 text-xs font-mono focus:border-foreground/30 focus:outline-none"
                    >
                      <option value="">Select...</option>
                      {p.enum.map(v => (
                        <option key={String(v)} value={String(v)}>{String(v)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={p.type === "number" ? "number" : "text"}
                      value={paramValues[p.name] ?? ""}
                      onChange={(e) => setParamValues(prev => ({ ...prev, [p.name]: e.target.value }))}
                      placeholder={p.default !== undefined ? `Default: ${p.default}` : p.description ?? p.name}
                      className="w-full h-8 rounded-md border border-border bg-transparent px-3 text-xs font-mono placeholder:text-muted-foreground/30 focus:border-foreground/30 focus:outline-none"
                    />
                  )}
                  {p.description && <p className="text-[10px] text-muted-foreground mt-0.5">{p.description}</p>}
                </div>
              ))}
            </div>
          )}

          <DialogFooter>
            {missingRequired.length > 0 && (
              <span className="text-[10px] text-red-400 mr-auto">
                {missingRequired.length} required param{missingRequired.length > 1 ? "s" : ""} missing
              </span>
            )}
            <DialogClose render={<button className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" />}>
              Cancel
            </DialogClose>
            <button
              onClick={handleRun}
              disabled={missingRequired.length > 0 || runMutation.isPending}
              className="inline-flex items-center gap-2 bg-foreground text-background px-4 py-1.5 text-xs font-medium transition-all hover:opacity-90 disabled:opacity-30 rounded-md"
            >
              {runMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              Run
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete dialog */}
      <Dialog open={showDelete} onOpenChange={setShowDelete}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <DialogTitle>Delete playbook</DialogTitle>
            </div>
            <DialogDescription>
              Are you sure you want to delete <span className="font-mono font-medium text-foreground">{playbook.name}</span>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<button className="px-4 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors" />}>
              Cancel
            </DialogClose>
            <button
              onClick={() => deleteMutation.mutate()}
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
