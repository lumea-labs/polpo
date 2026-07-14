"use client";

import { useMemo, useState } from "react";
import { useRouter } from "../host";
import { useMutation, useQuery, useQueryClient } from "../host";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  Minus,
  CircleNotch,
  DownloadSimple,
} from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { DataTable, type ColumnMeta } from "../ui/data-table";

type Skill = {
  name: string;
  description?: string;
  source?: "project" | "global";
  tags?: string[];
  assignedTo?: string[];
};

export function SkillsTab({
  projectId,
  agentName,
  fallbackSkills,
}: {
  projectId: string;
  agentName: string;
  fallbackSkills: string[];
}) {
  const polpo = usePolpoClient(projectId);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [installSource, setInstallSource] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const { data: skills = [], isLoading } = useQuery({
    queryKey: ["skills", projectId],
    queryFn: () => polpo.getSkills() as unknown as Promise<Skill[]>,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["skills", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
      queryClient.invalidateQueries({ queryKey: ["agent", projectId, agentName] }),
    ]);
    router.refresh();
  };

  const assign = useMutation({
    mutationFn: (name: string) => polpo.assignSkill(name, agentName),
    onSuccess: async () => {
      await refresh();
      setAddOpen(false);
    },
  });
  const unassign = useMutation({
    mutationFn: (name: string) => polpo.unassignSkill(name, agentName),
    onSuccess: refresh,
  });
  // Install from a source, then auto-assign the installed skills to this agent.
  // Same install path as the Skills page — DRY via polpo.installSkills.
  const install = useMutation({
    mutationFn: async (src: string) => {
      const r = await polpo.installSkills(src.trim());
      await Promise.all((r.installed ?? []).map((n) => polpo.assignSkill(n, agentName)));
      return r.installed?.length ?? 0;
    },
    onSuccess: async () => {
      setInstallSource("");
      await refresh();
      setAddOpen(false);
    },
  });

  const { assigned, available } = useMemo(() => {
    const assignedNames = new Set(
      skills.filter((s) => s.assignedTo?.includes(agentName)).map((s) => s.name),
    );
    for (const n of fallbackSkills) assignedNames.add(n);
    return {
      assigned: skills.filter((s) => assignedNames.has(s.name)),
      available: skills.filter((s) => !assignedNames.has(s.name)),
    };
  }, [skills, agentName, fallbackSkills]);

  const columns = useMemo<ColumnDef<Skill, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Skill",
        accessorFn: (s) => s.name,
        cell: ({ getValue }) => (
          <span
            className="font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-brand"
            data-mono
          >
            {getValue() as string}
          </span>
        ),
        meta: { width: 240 } satisfies ColumnMeta,
      },
      {
        id: "description",
        header: "Description",
        enableSorting: false,
        accessorFn: (s) => s.description ?? "",
        cell: ({ getValue }) => {
          const v = getValue() as string;
          return v ? (
            <span className="block min-w-0 truncate text-[12px] text-muted-foreground">
              {v}
            </span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          );
        },
        meta: { cellClassName: "max-w-0" } satisfies ColumnMeta,
      },
      {
        id: "remove",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const s = row.original;
          const pending =
            unassign.isPending && unassign.variables === s.name;
          return (
            <span
              data-reveal={pending ? undefined : ""}
              className="flex justify-end"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  unassign.mutate(s.name);
                }}
                onKeyDown={(e) => e.stopPropagation()}
                disabled={pending}
                aria-label="Remove skill"
                className="grid h-7 w-7 place-items-center rounded-md border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
              >
                {pending ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <Minus size={14} weight="bold" />
                )}
              </button>
            </span>
          );
        },
        meta: { width: 56, align: "right" } satisfies ColumnMeta,
      },
    ],
    [unassign],
  );

  return (
    <div>
      <p className="mb-4 text-[13px] text-muted-foreground">
        Skills give this agent reusable, packaged capabilities — assign ones from
        your project or install a new one.
      </p>
      <DataTable
        columns={columns}
        data={assigned}
        getRowId={(s) => s.name}
        rowHref={(s) =>
          `/projects/${projectId}/skills/${encodeURIComponent(s.name)}`
        }
        searchPlaceholder="Search skills…"
        searchFn={(s, q) =>
          [s.name, s.description].some((v) =>
            (v ?? "").toLowerCase().includes(q),
          )
        }
        rightSlot={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus size={14} weight="bold" />
            Add skill
          </Button>
        }
        empty={
          isLoading ? (
            <span className="text-sm text-muted-foreground">Loading skills…</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              No skills assigned to this agent yet.
            </span>
          )
        }
        emptyFiltered={
          <span className="text-sm text-muted-foreground">
            No skills match your search.
          </span>
        }
      />

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="v2 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[14px] font-semibold">Add a skill</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">
                Assign one already in this project
              </span>
              <Select
                value=""
                onValueChange={(v) => {
                  if (v) assign.mutate(v);
                }}
                disabled={available.length === 0 || assign.isPending}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue
                    placeholder={
                      available.length === 0
                        ? "All project skills are assigned"
                        : assign.isPending
                          ? "Assigning…"
                          : "Choose a skill…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {available.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-[11px] uppercase tracking-[0.06em] text-muted-foreground/50">
                or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">
                Install a new one
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={installSource}
                  onChange={(e) => setInstallSource(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && installSource.trim())
                      install.mutate(installSource);
                  }}
                  placeholder="owner/repo, a GitHub URL, or a skill source"
                  className="h-8 min-w-[240px] flex-1 rounded-md border border-border bg-background px-3 font-mono text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none"
                />
                <Button
                  size="sm"
                  disabled={!installSource.trim() || install.isPending}
                  onClick={() => install.mutate(installSource)}
                >
                  {install.isPending ? (
                    <>
                      <CircleNotch size={14} className="animate-spin" />
                      Installing…
                    </>
                  ) : (
                    <>
                      <DownloadSimple size={14} />
                      Install
                    </>
                  )}
                </Button>
              </div>
              {install.isError ? (
                <p className="text-[12px] text-destructive">
                  {install.error instanceof Error
                    ? install.error.message
                    : "Install failed"}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground/60">
                  Installs the skill and assigns it to this agent automatically.
                </p>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
