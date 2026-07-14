"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Plus,
  Wrench,
  Trash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { Link, useMutation, useQuery, useQueryClient } from "../host.js";
import { useDashboardApi } from "../../host.js";
import { Button } from "../ui/button.js";
import { PageHeader } from "../ui/page-header.js";
import { DataTable, type ColumnMeta } from "../ui/data-table.js";
import { RefreshButton } from "../ui/refresh-button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { ToolEditorDialog } from "./tool-editor-dialog.js";

export type ToolRow = { name: string; description?: string | null };

/**
 * Project-level Tools. v2 port of app/(dashboard)/projects/[id]/tools/*.
 *
 * Kept: browse the built-in catalog (read-only reference), the project's
 * custom-tools list from GET /v1/projects/:id/tools, and create/edit/delete.
 *
 * Trimmed from v1 (heaviest extras): the AI test/eval generators, the "Try it"
 * runner + AI-example endpoints, and the raw-JSON/guided-form args builder.
 * Authoring is a single Monaco editor + streaming deploy (see
 * tool-editor-dialog.tsx). The runtime endpoints (/generate, /run, /example)
 * are left untouched server-side.
 */
export function ToolsView({
  projectId,
  initialTools,
}: {
  projectId: string;
  initialTools: ToolRow[];
}) {
  const api = useDashboardApi();
  const queryClient = useQueryClient();
  const queryKey = ["custom-tools", projectId];

  const { data: tools = initialTools, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () =>
      api.fetchControlPlane<{ ok: boolean; data: ToolRow[] }>(
        `/v1/projects/${projectId}/tools`,
      ).then((r) => r.data ?? []),
    initialData: initialTools,
  });

  const [editor, setEditor] = useState<
    { mode: "create" } | { mode: "edit"; name: string } | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<ToolRow | null>(null);

  const del = useMutation({
    mutationFn: (name: string) =>
      api.mutateControlPlane(
        `/v1/projects/${projectId}/tools/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
      setConfirmDelete(null);
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const columns = useMemo<ColumnDef<ToolRow, unknown>[]>(
    () => [
      {
        id: "name",
        header: "Tool",
        accessorFn: (t) => t.name,
        cell: ({ row }) => (
          <Link
            href={`/projects/${projectId}/tools/${encodeURIComponent(row.original.name)}`}
            className="flex items-center gap-2 font-mono text-[13px] font-medium text-foreground transition-colors hover:text-brand"
          >
            <Wrench size={13} className="shrink-0 text-muted-foreground" />
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "description",
        header: "Description",
        enableSorting: false,
        accessorFn: (t) => t.description ?? "",
        cell: ({ getValue }) => {
          const d = getValue() as string;
          return d ? (
            <span className="block min-w-0 truncate text-[12px] text-muted-foreground">
              {d}
            </span>
          ) : (
            <span className="text-[12px] text-muted-foreground/40">—</span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${row.original.name}`}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => setConfirmDelete(row.original)}
            >
              <Trash size={15} />
            </Button>
          </div>
        ),
        meta: { align: "right", width: 96 } satisfies ColumnMeta,
      },
    ],
    [projectId],
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Tool Functions"
        description="Custom tools you author — your agents can call them. Built-in tools are enabled per agent, under Agents → Tools."
        actions={
          <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
            <Plus size={15} weight="bold" /> New tool
          </Button>
        }
      />

      <DataTable
          columns={columns}
          data={tools}
          getRowId={(t) => t.name}
          searchPlaceholder="Search tools…"
          searchFn={(t, q) =>
            [t.name, t.description].some((v) => (v ?? "").toLowerCase().includes(q))
          }
          rightSlot={<RefreshButton onClick={() => refetch()} busy={isFetching} />}
          empty={
            <div className="flex flex-col items-center gap-3 py-6">
              <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
                <Wrench size={20} className="text-muted-foreground" />
              </span>
              <div className="text-center">
                <div className="text-sm font-medium text-foreground">
                  No custom tools yet
                </div>
                <div className="mt-1 text-[13px] text-muted-foreground">
                  Author a <code>defineTool</code> file — your agents can call it.
                </div>
              </div>
              <Button size="sm" onClick={() => setEditor({ mode: "create" })}>
                <Plus size={15} weight="bold" /> New tool
              </Button>
            </div>
          }
        />

      {editor && (
        <ToolEditorDialog
          projectId={projectId}
          mode={editor.mode}
          initialName={editor.mode === "edit" ? editor.name : undefined}
          open
          onOpenChange={(o) => {
            if (!o) setEditor(null);
          }}
          onDeployed={refresh}
        />
      )}

      {/* Delete confirmation */}
      <Dialog
        open={!!confirmDelete}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <DialogContent showCloseButton={false} className="v2">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <WarningCircle size={16} className="text-destructive" weight="fill" />
              <DialogTitle>Delete tool</DialogTitle>
            </div>
            <DialogDescription>
              Delete{" "}
              <span className="font-mono font-medium text-foreground">
                {confirmDelete?.name}
              </span>
              ? Agents that reference it will no longer be able to call it. This
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {del.isError && (
            <p className="text-[12px] text-destructive">
              {del.error instanceof Error ? del.error.message : "Failed to delete"}
            </p>
          )}
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>
              Cancel
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              disabled={del.isPending}
              onClick={() => confirmDelete && del.mutate(confirmDelete.name)}
            >
              {del.isPending ? "Deleting…" : "Delete tool"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
