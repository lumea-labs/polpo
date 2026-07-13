"use client";

import { useMemo } from "react";
import { ArrowClockwise, CaretRight, ChatCircleText } from "@phosphor-icons/react";
import { useSessions } from "@polpo-ai/react";
import type { ChatSession } from "@polpo-ai/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, IconButton, LoadingRows, PageHeader, type ColumnMeta } from "../components.js";

export function SessionsView() {
  const { sessions, isLoading, error, refetch } = useSessions();
  const columns = useMemo<ColumnDef<ChatSession, unknown>[]>(() => [
    { id: "session", header: "Session", accessorFn: (item) => item.title || item.id, cell: ({ row }) => <div className="pd-primary-cell"><ChatCircleText size={17} weight="duotone" /><div><strong>{row.original.title || "Untitled session"}</strong><span>{row.original.agent || "Orchestrator"}</span></div></div>, meta: { width: 380 } satisfies ColumnMeta },
    { id: "messages", header: "Messages", accessorFn: (item) => item.messageCount ?? 0, meta: { width: 110, align: "center", hideOnMobile: true } satisfies ColumnMeta },
    { id: "updated", header: "Updated", accessorFn: (item) => item.updatedAt, cell: ({ getValue }) => <span>{new Date(String(getValue())).toLocaleString()}</span>, meta: { width: 210, hideOnMobile: true } satisfies ColumnMeta },
    { id: "open", header: "", enableSorting: false, cell: () => <CaretRight size={14} />, meta: { width: 44, align: "right" } satisfies ColumnMeta },
  ], []);
  return <div className="pd-view-stack"><PageHeader title="Sessions" description={`${sessions.length} recorded conversations`} />{error ? <div className="pd-error">{error.message}</div> : null}{isLoading && sessions.length === 0 ? <LoadingRows /> : <DataTable columns={columns} data={sessions} getRowId={(item) => item.id} rowHref={(item) => `/sessions/${encodeURIComponent(item.id)}`} searchPlaceholder="Search sessions..." searchFn={(item, query) => [item.id, item.title, item.agent].some((value) => value?.toLowerCase().includes(query))} rightSlot={<IconButton label="Refresh sessions" onClick={() => void refetch()}><ArrowClockwise size={15} /></IconButton>} />}</div>;
}
