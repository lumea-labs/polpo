"use client";

import { useMemo } from "react";
import { ArrowClockwise, GraduationCap } from "@phosphor-icons/react";
import { useSkills } from "@polpo-ai/react";
import type { SkillWithAssignment } from "@polpo-ai/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, IconButton, LoadingRows, PageHeader, type ColumnMeta } from "../components.js";

export function SkillsView() {
  const { skills, isLoading, error, refetch } = useSkills();
  const columns = useMemo<ColumnDef<SkillWithAssignment, unknown>[]>(() => [
    { id: "skill", header: "Skill", accessorFn: (item) => item.name, cell: ({ row }) => <div className="pd-primary-cell"><GraduationCap size={17} weight="duotone" /><div><strong>{row.original.name}</strong><span>{row.original.description || "Reusable agent capability"}</span></div></div>, meta: { width: 520 } satisfies ColumnMeta },
    { id: "source", header: "Source", accessorFn: (item) => item.source || "project", meta: { width: 160, hideOnMobile: true } satisfies ColumnMeta },
    { id: "agents", header: "Agents", accessorFn: (item) => item.assignedTo?.length ?? 0, meta: { width: 90, align: "center", hideOnMobile: true } satisfies ColumnMeta },
  ], []);
  return <div className="pd-view-stack"><PageHeader title="Skills" description={`${skills.length} installed ${skills.length === 1 ? "skill" : "skills"}`} />{error ? <div className="pd-error">{error.message}</div> : null}{isLoading && skills.length === 0 ? <LoadingRows /> : <DataTable columns={columns} data={skills} getRowId={(item) => item.name} searchPlaceholder="Search skills..." searchFn={(item, query) => [item.name, item.description, item.source].some((value) => value?.toLowerCase().includes(query))} rightSlot={<IconButton label="Refresh skills" onClick={() => void refetch()}><ArrowClockwise size={15} /></IconButton>} />}</div>;
}
