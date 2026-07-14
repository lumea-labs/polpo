"use client";

import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "../host";
import type { ColumnDef } from "@tanstack/react-table";
import { GraduationCap, Plus } from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { decodeTextEntities } from "../host";
import { Button } from "../ui/button";
import { PageHeader } from "../ui/page-header";
import { DataTable, type ColumnMeta } from "../ui/data-table";
import { RefreshButton } from "../ui/refresh-button";
import { SelfHostCreateSkillDialog } from "../skills/self-host-create-skill-dialog.js";

export type Skill = {
  name: string;
  description?: string;
  source?: "project" | "global";
  tags?: string[];
  assignedTo?: string[];
};

export function SkillsCatalog({
  projectId,
  initial,
  renderCreateDialog,
}: {
  projectId: string;
  initial: Skill[];
  renderCreateDialog?: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}) {
  const polpo = usePolpoClient(projectId);
  const { data: skills = initial, refetch, isFetching } = useQuery({
    queryKey: ["skills", projectId],
    queryFn: () => polpo.getSkills() as unknown as Promise<Skill[]>,
    initialData: initial,
  });

  const [addOpen, setAddOpen] = useState(false);

  const columns = useMemo<ColumnDef<Skill, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Skill",
        accessorFn: (s) => s.name,
        cell: ({ row }) => {
          const s = row.original;
          return (
            <div className="min-w-0">
              <div className="truncate font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-brand">
                {s.name}
              </div>
              {s.description && (
                <div className="min-w-0 truncate text-[12px] text-muted-foreground">
                  {decodeTextEntities(s.description)}
                </div>
              )}
            </div>
          );
        },
        meta: { cellClassName: "max-w-0" } satisfies ColumnMeta,
      },
      {
        id: "assigned",
        header: "Agents",
        accessorFn: (s) => s.assignedTo?.length ?? 0,
        cell: ({ getValue }) => {
          const n = getValue() as number;
          return (
            <span
              className={`text-[13px] ${n > 0 ? "text-foreground" : "text-muted-foreground/40"}`}
              data-tabular
            >
              {n}
            </span>
          );
        },
        meta: { width: 72, align: "center" } satisfies ColumnMeta,
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Skills"
        description={`${skills.length} ${skills.length === 1 ? "skill" : "skills"} installed · assign them to agents`}
        actions={
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus size={15} />
            Add skill
          </Button>
        }
      />

      {renderCreateDialog ? (
        renderCreateDialog({ open: addOpen, onOpenChange: setAddOpen })
      ) : (
        <SelfHostCreateSkillDialog
          projectId={projectId}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}

      <DataTable
        columns={columns}
        data={skills}
        getRowId={(s) => s.name}
        rowHref={(s) => `/projects/${projectId}/skills/${encodeURIComponent(s.name)}`}
        searchPlaceholder="Search skills…"
        searchFn={(s, q) =>
          [s.name, s.description, ...(s.tags ?? [])].some((v) =>
            (v ?? "").toLowerCase().includes(q),
          )
        }
        rightSlot={<RefreshButton onClick={() => refetch()} busy={isFetching} />}
        empty={
          <div className="flex flex-col items-center gap-3 py-8">
            <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
              <GraduationCap size={20} className="text-muted-foreground" />
            </span>
            <div className="text-center">
              <div className="text-sm font-medium text-foreground">
                No skills installed
              </div>
              <div className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                Add one with{" "}
                <code className="rounded bg-secondary px-1 py-0.5 text-[12px]">
                  polpo skills add
                </code>
                .
              </div>
            </div>
          </div>
        }
      />
    </div>
  );
}

export const SkillsView = SkillsCatalog;
