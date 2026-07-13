"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowClockwise, CaretRight, File, FolderOpen } from "@phosphor-icons/react";
import { useFiles } from "@polpo-ai/react";
import type { FileEntry } from "@polpo-ai/sdk";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, IconButton, LoadingRows, PageHeader, type ColumnMeta } from "../components.js";

function joinPath(base: string, name: string) { return base ? `${base.replace(/\/$/, "")}/${name}` : name; }

export function FilesView() {
  const rootsState = useFiles();
  const [path, setPath] = useState<string | undefined>();
  const filesState = useFiles(path);
  useEffect(() => { if (!path && rootsState.roots[0]) setPath(rootsState.roots[0].path); }, [path, rootsState.roots]);
  const columns = useMemo<ColumnDef<FileEntry, unknown>[]>(() => [
    { id: "name", header: "Name", accessorFn: (item) => item.name, cell: ({ row }) => <div className="pd-file-name">{row.original.isDirectory ? <FolderOpen size={17} weight="duotone" /> : <File size={17} />}<span>{row.original.name}</span></div>, meta: { width: 520 } satisfies ColumnMeta },
    { id: "type", header: "Type", accessorFn: (item) => item.isDirectory ? "Folder" : "File", meta: { width: 130, hideOnMobile: true } satisfies ColumnMeta },
    { id: "size", header: "Size", accessorFn: (item) => item.size ?? 0, cell: ({ getValue, row }) => row.original.isDirectory ? "-" : `${Math.max(1, Math.round(Number(getValue()) / 1024))} KB`, meta: { width: 110, align: "right", hideOnMobile: true } satisfies ColumnMeta },
    { id: "open", header: "", enableSorting: false, cell: ({ row }) => row.original.isDirectory ? <CaretRight size={14} /> : null, meta: { width: 44, align: "right" } satisfies ColumnMeta },
  ], []);
  const rootPath = rootsState.roots[0]?.path ?? ".";
  const relativePath = path && path !== "." ? path.replace(/^\.\/?/, "") : "";
  const crumbs = relativePath.split("/").filter(Boolean);
  const loading = rootsState.isLoading || filesState.isLoading;
  return <div className="pd-view-stack"><PageHeader title="Files" description="Browse files available to this Polpo runtime." /><div className="pd-breadcrumb"><button type="button" onClick={() => setPath(rootPath)}>Home</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}><CaretRight size={12} /><button type="button" onClick={() => setPath(joinPath(rootPath === "." ? "" : rootPath, crumbs.slice(0, index + 1).join("/")) || ".")}>{crumb}</button></span>)}</div>{loading && filesState.entries.length === 0 ? <LoadingRows /> : <DataTable columns={columns} data={filesState.entries} getRowId={(item) => joinPath(path ?? "", item.name)} onRowClick={(item) => { if (item.isDirectory) setPath(joinPath(path ?? ".", item.name)); }} searchPlaceholder="Search files..." searchFn={(item, query) => item.name.toLowerCase().includes(query)} rightSlot={<IconButton label="Refresh files" onClick={() => { if (path) void filesState.listFiles(path); else void rootsState.refetchRoots(); }}><ArrowClockwise size={15} /></IconButton>} />}</div>;
}
