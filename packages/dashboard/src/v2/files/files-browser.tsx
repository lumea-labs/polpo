"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CaretRight,
  DownloadSimple,
  UploadSimple,
  FolderPlus,
  Trash,
  CircleNotch,
  PencilSimple,
  Plus,
  HardDrives,
} from "@phosphor-icons/react";
import {
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  PageHeader,
  RefreshButton,
  Skeleton,
  toast,
  useMutation,
  usePolpoClient,
  useQuery,
  useQueryClient,
  type ColumnMeta,
} from "./host.js";
import {
  driveLabel,
  EntryIcon,
  type DriveVolume,
  type FileEntry,
  fileUrl,
  formatSize,
  strategyDescription,
  strategyLabel,
  VolumeStrategyIcon,
} from "./file-browser-primitives.js";

/** A file to upload + its path relative to the drop/pick target (folders keep
 *  their structure). Flat files have `relPath === file.name`. */
type UploadEntry = { file: File; relPath: string };

/** Recursively read a dropped FileSystemEntry into upload entries. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: UploadEntry[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name });
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const dirPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    // readEntries yields in batches — loop until it returns empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, dirPrefix, out);
    }
  }
}

/** Collect a drop into upload entries — supports files AND folders (recursive).
 *  `dataTransfer.items` is captured synchronously (it's cleared after the
 *  event tick); the FileSystemEntry objects are traversed afterwards. */
async function entriesFromDrop(dt: DataTransfer): Promise<UploadEntry[]> {
  const roots: FileSystemEntry[] = [];
  for (let i = 0; i < dt.items.length; i++) {
    const e = dt.items[i].webkitGetAsEntry?.();
    if (e) roots.push(e);
  }
  if (roots.length === 0) {
    return Array.from(dt.files).map((file) => ({ file, relPath: file.name }));
  }
  const out: UploadEntry[] = [];
  for (const r of roots) await walkEntry(r, "", out);
  return out;
}

export function FilesBrowser({
  projectId,
  embedded,
}: {
  projectId: string;
  /** Rendered inside another panel (e.g. the playground canvas Drive tab) —
   *  drop the page header since the panel already has its own chrome. */
  embedded?: boolean;
}) {
  const polpo = usePolpoClient(projectId);
  const queryClient = useQueryClient();

  useEffect(() => {
    function handleFilesMutated(event: Event) {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      void queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["files-list", projectId],
      });
    }
    window.addEventListener("polpo:files-mutated", handleFilesMutated);
    return () =>
      window.removeEventListener("polpo:files-mutated", handleFilesMutated);
  }, [projectId, queryClient]);

  const { data: volumeState, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["file-volumes", projectId],
    queryFn: () => polpo.getVolumes(),
    staleTime: 60_000,
  });

  const drives = useMemo(() => volumeState?.volumes ?? [], [volumeState?.volumes]);
  const [activeDriveName, setActiveDriveName] = useState<string | null>(null);
  const activeDrive = useMemo(
    () => drives.find((drive) => drive.name === activeDriveName) ?? null,
    [activeDriveName, drives],
  );

  // Current directory — lifted here so the header Upload action targets it.
  const [path, setPath] = useState<string>("");
  const activePath = path || (activeDrive?.path ?? "");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (entries: UploadEntry[]) => {
      // Create the folder tree first — S3 has no real dirs, so each subfolder
      // needs a marker before uploads into it resolve. Shallow-first so every
      // parent exists before its children.
      const dirs = new Set<string>();
      for (const { relPath } of entries) {
        const slash = relPath.lastIndexOf("/");
        if (slash <= 0) continue;
        let d = relPath.slice(0, slash);
        while (d) {
          dirs.add(d);
          const s = d.lastIndexOf("/");
          d = s > 0 ? d.slice(0, s) : "";
        }
      }
      const ordered = [...dirs].sort(
        (a, b) => a.split("/").length - b.split("/").length,
      );
      for (const d of ordered) {
        await polpo.createDirectory(`${activePath}/${d}`).catch(() => {});
      }
      // Upload each file into its (relative) directory, preserving structure.
      for (const { file, relPath } of entries) {
        const slash = relPath.lastIndexOf("/");
        const dir =
          slash > 0 ? `${activePath}/${relPath.slice(0, slash)}` : activePath;
        await polpo.uploadFile(dir, file, file.name);
      }
      return entries.length;
    },
    onSuccess: async (n) => {
      await queryClient.invalidateQueries({
        queryKey: ["files-list", projectId, activePath],
      });
      await queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      toast.success(`Uploaded ${n} file${n === 1 ? "" : "s"}`);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Upload failed"),
  });

  // New folder — create a directory in the current path.
  const [createOpen, setCreateOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const createFolder = useMutation({
    mutationFn: (name: string) =>
      polpo.createDirectory(`${activePath}/${name}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["files-list", projectId, activePath],
      });
      await queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      toast.success("Folder created");
      setCreateOpen(false);
      setFolderName("");
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't create folder"),
  });

  // Files (flat) and folders (recursive) both pick via the same mapping —
  // `webkitRelativePath` carries the in-folder path for directory picks.
  const onPicked = (files: FileList | null) => {
    if (files?.length) {
      upload.mutate(
        Array.from(files).map((file) => ({
          file,
          relPath: file.webkitRelativePath || file.name,
        })),
      );
    }
  };

  type DriveDraft = {
    name: string;
    label: string;
    strategy: DriveVolume["strategy"];
    mountPath: string;
  };
  const [driveDialog, setDriveDialog] = useState<{
    mode: "create" | "edit";
    drive?: DriveVolume;
  } | null>(null);
  const [driveDraft, setDriveDraft] = useState<DriveDraft>({
    name: "",
    label: "",
    strategy: "mounted",
    mountPath: "",
  });
  const [deleteDrive, setDeleteDrive] = useState<DriveVolume | null>(null);

  function openCreateDrive() {
    setDriveDraft({
      name: "",
      label: "",
      strategy: "mounted",
      mountPath: "",
    });
    setDriveDialog({ mode: "create" });
  }

  function openEditDrive(drive: DriveVolume) {
    setDriveDraft({
      name: drive.name,
      label: drive.label ?? "",
      strategy: drive.strategy,
      mountPath: drive.mountPath ?? "",
    });
    setDriveDialog({ mode: "edit", drive });
  }

  const saveDrive = useMutation({
    mutationFn: async () => {
      if (!driveDialog) return;
      const isCreate = driveDialog.mode === "create";
      const name = driveDraft.name.trim();
      return polpo.saveVolume({
        ...(isCreate ? { name } : { name: driveDialog.drive!.name }),
        label: driveDraft.label.trim() || null,
        strategy: driveDraft.strategy,
        mountPath: driveDraft.mountPath.trim() || null,
      });
    },
    onSuccess: async (drive) => {
      await queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      if (driveDialog?.mode === "create" && drive) {
        setActiveDriveName(drive.name);
        setPath(drive.path);
      }
      toast.success(driveDialog?.mode === "create" ? "Drive created" : "Drive updated");
      setDriveDialog(null);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't save drive"),
  });

  const removeDrive = useMutation({
    mutationFn: async (drive: DriveVolume) => {
      await polpo.removeVolume(drive.name);
    },
    onSuccess: async (_, drive) => {
      await queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      if (activeDriveName === drive.name) {
        setActiveDriveName(null);
        setPath("");
      }
      toast.success("Drive deleted");
      setDeleteDrive(null);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Couldn't delete drive"),
  });

  return (
    <div className="flex flex-col gap-6">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onPicked(e.target.files);
          e.target.value = "";
        }}
      />
      {!embedded && (
      <PageHeader
        title="Drives"
        description="Browse the files and code workspaces your agents can use."
        actions={
          activeDrive ? (
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                disabled={upload.isPending}
                onClick={() => fileInputRef.current?.click()}
                className="gap-1.5"
              >
                {upload.isPending ? (
                  <CircleNotch size={13} className="animate-spin" />
                ) : (
                  <UploadSimple size={13} />
                )}
                Upload
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCreateOpen(true)}
                title="Create a folder here"
                className="gap-1.5"
              >
                <FolderPlus size={13} />
                New folder
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={openCreateDrive} className="gap-1.5">
              <Plus size={13} />
              New drive
            </Button>
          )
        }
      />
      )}

      {isLoading ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-[1.6fr_0.6fr_0.6fr] gap-4 border-b border-border bg-muted/40 px-3.5 py-2.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-16" />
          </div>
          {Array.from({ length: 7 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-[1.6fr_0.6fr_0.6fr] items-center gap-4 border-b border-border px-3.5 py-3 last:border-b-0"
            >
              <Skeleton className="h-3.5 w-44 max-w-full" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
      ) : drives.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
            <HardDrives size={20} className="text-muted-foreground" />
          </span>
          <span className="text-[13px] text-muted-foreground">
            No drives for this project yet.
          </span>
        </div>
      ) : activeDrive ? (
        <RootBrowser
          projectId={projectId}
          drive={activeDrive}
          path={activePath}
          setPath={setPath}
          onBack={() => {
            setActiveDriveName(null);
            setPath("");
          }}
          onUpload={(entries) => upload.mutate(entries)}
          uploading={upload.isPending}
        />
      ) : (
        <DrivesTable
          drives={drives}
          refreshing={isFetching}
          onRefresh={() => refetch()}
          onOpen={(drive) => {
            setActiveDriveName(drive.name);
            setPath(drive.path);
          }}
          onEdit={openEditDrive}
          onDelete={setDeleteDrive}
        />
      )}

      <DriveDialog
        open={driveDialog !== null}
        mode={driveDialog?.mode ?? "create"}
        draft={driveDraft}
        setDraft={setDriveDraft}
        saving={saveDrive.isPending}
        onOpenChange={(open) => {
          if (!open) setDriveDialog(null);
        }}
        onSubmit={() => saveDrive.mutate()}
      />

      <Dialog open={!!deleteDrive} onOpenChange={(open) => !open && setDeleteDrive(null)}>
        <DialogContent className="v2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold tracking-tight text-foreground">
              Delete drive
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Delete{" "}
              <span className="font-mono text-foreground">
                {deleteDrive?.name}
              </span>
              ? Metadata for this drive will be removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-1">
            <Button variant="ghost" size="sm" onClick={() => setDeleteDrive(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!deleteDrive || removeDrive.isPending}
              onClick={() => deleteDrive && removeDrive.mutate(deleteDrive)}
              className="gap-1.5"
            >
              {removeDrive.isPending ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Trash size={14} />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setFolderName("");
        }}
      >
        <DialogContent className="v2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold tracking-tight text-foreground">
              New folder
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Create a folder in the current directory.
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                folderName.trim() &&
                !createFolder.isPending
              )
                createFolder.mutate(folderName.trim());
            }}
            placeholder="Folder name"
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!folderName.trim() || createFolder.isPending}
              onClick={() => createFolder.mutate(folderName.trim())}
              className="gap-1.5"
            >
              {createFolder.isPending ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <FolderPlus size={14} />
              )}
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DrivesTable({
  drives,
  refreshing,
  onRefresh,
  onOpen,
  onEdit,
  onDelete,
}: {
  drives: DriveVolume[];
  refreshing: boolean;
  onRefresh: () => void;
  onOpen: (drive: DriveVolume) => void;
  onEdit: (drive: DriveVolume) => void;
  onDelete: (drive: DriveVolume) => void;
}) {
  const columns = useMemo<ColumnDef<DriveVolume, unknown>[]>(
    () => [
      {
        accessorKey: "label",
        header: "Drive",
        cell: ({ row }) => {
          const drive = row.original;
          return (
            <div className="flex min-w-0 items-center gap-2.5">
              <VolumeStrategyIcon
                strategy={drive.strategy}
                size={16}
                className={
                  drive.strategy === "hydrated"
                    ? "text-muted-foreground"
                    : "text-brand/70"
                }
              />
              <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
                {driveLabel(drive)}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: "strategy",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-[12px] text-muted-foreground">
            {strategyLabel(row.original.strategy)}
          </span>
        ),
        meta: { width: 130 } satisfies ColumnMeta,
      },
      {
        accessorKey: "mountPath",
        header: "Mount",
        cell: ({ row }) => (
          <span className="font-mono text-[12px] text-muted-foreground">
            {row.original.mountPath ?? row.original.path}
          </span>
        ),
      },
      {
        accessorKey: "totalSize",
        header: "Size",
        cell: ({ row }) => (
          <span className="text-[12px] tabular-nums text-muted-foreground">
            {formatSize(row.original.totalSize)}
          </span>
        ),
        meta: { align: "right", width: 110 } satisfies ColumnMeta,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const drive = row.original;
          const protectedDrive = drive.name === "workspace";
          return (
            <div className="flex items-center justify-end gap-1">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onEdit(drive);
                }}
                aria-label={`Edit ${drive.name}`}
                className="grid h-7 w-7 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-secondary hover:text-foreground"
              >
                <PencilSimple size={14} />
              </button>
              <button
                type="button"
                disabled={protectedDrive}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(drive);
                }}
                aria-label={`Delete ${drive.name}`}
                className="grid h-7 w-7 place-items-center rounded text-muted-foreground/50 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-20"
              >
                <Trash size={14} />
              </button>
              <CaretRight size={14} className="text-muted-foreground" />
            </div>
          );
        },
        meta: { align: "right", width: 112 } satisfies ColumnMeta,
      },
    ],
    [onDelete, onEdit],
  );

  return (
    <DataTable
      columns={columns}
      data={drives}
      getRowId={(drive) => drive.id}
      rowOnClick={onOpen}
      searchPlaceholder="Search drives…"
      searchFn={(drive, q) =>
        [
          drive.name,
          drive.label,
          drive.strategy,
          drive.mountPath,
          drive.path,
          drive.absolutePath,
        ].some((value) => (value ?? "").toLowerCase().includes(q))
      }
      rightSlot={<RefreshButton onClick={onRefresh} busy={refreshing} />}
      empty={
        <span className="text-sm text-muted-foreground">
          No drives for this project yet.
        </span>
      }
      emptyFiltered={
        <span className="text-sm text-muted-foreground">
          No drives match your search.
        </span>
      }
    />
  );
}

function DriveDialog({
  open,
  mode,
  draft,
  setDraft,
  saving,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  mode: "create" | "edit";
  draft: {
    name: string;
    label: string;
    strategy: DriveVolume["strategy"];
    mountPath: string;
  };
  setDraft: (draft: {
    name: string;
    label: string;
    strategy: DriveVolume["strategy"];
    mountPath: string;
  }) => void;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => void;
}) {
  const isCreate = mode === "create";
  const canSubmit =
    !saving &&
    (!isCreate || draft.name.trim().length > 0) &&
    draft.strategy.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold tracking-tight text-foreground">
            {isCreate ? "New drive" : "Edit drive"}
          </DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            Choose how agents access this mounted project drive.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              API name
            </label>
            <input
              value={draft.name}
              disabled={!isCreate}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  name: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
                })
              }
              placeholder="workspace"
              className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-60"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              Display label
            </label>
            <input
              value={draft.label}
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              placeholder="Workspace"
              className="h-9 w-full rounded-md border border-border bg-background px-3 text-[13px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              Type
            </label>
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
              {(["mounted", "hydrated"] as const).map((strategy) => {
                const active = draft.strategy === strategy;
                return (
                  <button
                    key={strategy}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setDraft({ ...draft, strategy })}
                    className={`flex min-h-[112px] flex-col gap-2 rounded-lg border p-3 text-left transition-colors ${
                      active
                        ? "border-brand/45 bg-brand/5"
                        : "border-border bg-card hover:border-ring/40 hover:bg-secondary/30"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={`grid h-7 w-7 place-items-center rounded-md border ${
                          active
                            ? "border-brand/25 bg-brand/10 text-brand"
                            : "border-border bg-secondary text-muted-foreground"
                        }`}
                      >
                        <VolumeStrategyIcon strategy={strategy} size={14} />
                      </span>
                      <span className="text-[13px] font-medium text-foreground">
                        {strategyLabel(strategy)}
                      </span>
                    </span>
                    <span className="text-[12px] leading-5 text-muted-foreground">
                      {strategyDescription(strategy)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              Mount path
            </label>
            <input
              value={draft.mountPath}
              onChange={(e) =>
                setDraft({ ...draft, mountPath: e.target.value })
              }
              placeholder={
                draft.name
                  ? `/home/daytona/project/${draft.name}`
                  : "/home/daytona/project/workspace"
              }
              className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-[12px] text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
            />
          </div>
        </div>
        <DialogFooter className="mt-1">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={onSubmit}
            className="gap-1.5"
          >
            {saving ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : isCreate ? (
              <Plus size={14} />
            ) : (
              <PencilSimple size={14} />
            )}
            {isCreate ? "Create" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RootBrowser({
  projectId,
  drive,
  path,
  setPath,
  onBack,
  onUpload,
  uploading,
}: {
  projectId: string;
  drive: DriveVolume;
  path: string;
  setPath: (path: string) => void;
  onBack: () => void;
  onUpload: (entries: UploadEntry[]) => void;
  uploading: boolean;
}) {
  const polpo = usePolpoClient(projectId);
  const queryClient = useQueryClient();
  const [dragOver, setDragOver] = useState(false);

  const { data: listing, isFetching, refetch } = useQuery({
    queryKey: ["files-list", projectId, path],
    queryFn: () =>
      polpo.listFiles(path) as unknown as Promise<{
        path: string;
        entries: FileEntry[];
      }>,
    staleTime: 30_000,
  });

  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const del = useMutation({
    mutationFn: (entry: FileEntry) =>
      polpo.deleteFile(`${path}/${entry.name}`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["files-list", projectId, path],
      });
      await queryClient.invalidateQueries({
        queryKey: ["file-volumes", projectId],
      });
      refetch();
      toast.success("Deleted");
      setDeleteTarget(null);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Delete failed"),
  });

  const entries = listing?.entries ?? [];
  const rel =
    path === drive.path ? "" : path.replace(`${drive.path}/`, "").replace(/^\//, "");
  const segments = rel ? rel.split("/") : [];

  // The summary describes the folder you're in. At the root that's the whole
  // tree (the root's precomputed recursive totals); in a subfolder it's the
  // files directly inside it.
  const atRoot = path === drive.path;
  const fileEntries = entries.filter((e) => e.type === "file");
  const folderFiles = atRoot
    ? drive.totalFiles ?? fileEntries.length
    : fileEntries.length;
  const folderSize = atRoot
    ? drive.totalSize ?? fileEntries.reduce((s, e) => s + (e.size ?? 0), 0)
    : fileEntries.reduce((s, e) => s + (e.size ?? 0), 0);

  function goTo(index: number) {
    setPath(
      index < 0
        ? drive.path
        : `${drive.path}/${segments.slice(0, index + 1).join("/")}`,
    );
  }

  function open(entry: FileEntry) {
    const full = `${path}/${entry.name}`;
    if (entry.type === "directory") {
      setPath(full);
      return;
    }
    // Let the browser render it (image / pdf / html / text) in a new tab.
    window.open(fileUrl(projectId, full), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-[13px]">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          Drives
        </button>
        <CaretRight size={12} className="text-muted-foreground/50" />
        <button
          type="button"
          onClick={() => goTo(-1)}
          className="inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <VolumeStrategyIcon
            strategy={drive.strategy}
            size={14}
            className="text-muted-foreground"
          />
          {driveLabel(drive)}
        </button>
        {segments.map((seg, i) => (
          <span key={i} className="flex items-center gap-1">
            <CaretRight size={12} className="text-muted-foreground/50" />
            <button
              type="button"
              onClick={() => goTo(i)}
              className={`rounded px-1.5 py-0.5 transition-colors hover:bg-secondary ${
                i === segments.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {seg}
            </button>
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3">
          <span className="text-[11px] tabular-nums text-muted-foreground/60">
            {folderFiles} {folderFiles === 1 ? "file" : "files"} ·{" "}
            {formatSize(folderSize)}
          </span>
          <RefreshButton onClick={() => refetch()} busy={isFetching} />
        </span>
      </div>

      {/* Listing — also a drop zone for the current directory */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          // Support files AND folders (recursive) — read entries synchronously.
          void entriesFromDrop(e.dataTransfer).then((entries) => {
            if (entries.length) onUpload(entries);
          });
        }}
        className={`overflow-hidden rounded-lg border transition-colors ${
          dragOver
            ? "border-brand bg-brand/5 ring-1 ring-brand/20"
            : "border-border"
        }`}
      >
        {entries.length === 0 && isFetching && !uploading && !dragOver ? (
          <div>
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 last:border-0"
              >
                <Skeleton className="h-4 w-4 shrink-0 rounded" />
                <Skeleton className="h-3.5 w-44 max-w-full" />
                <Skeleton className="ml-auto h-3 w-12 shrink-0" />
              </div>
            ))}
          </div>
        ) : entries.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-muted-foreground">
            {dragOver
              ? "Drop to upload here"
              : uploading
                ? "Uploading…"
                : "Empty directory — drop files here or use Upload."}
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.name}
              className="group flex items-center gap-2.5 border-b border-border px-3.5 py-2.5 transition-colors last:border-0 hover:bg-secondary/50"
            >
              <button
                type="button"
                onClick={() => open(entry)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
              >
                <EntryIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground underline-offset-2 group-hover:text-brand group-hover:underline">
                  {entry.name}
                </span>
              </button>
              {entry.type === "file" ? (
                <>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                    {formatSize(entry.size)}
                  </span>
                  <a
                    href={fileUrl(projectId, `${path}/${entry.name}`, true)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Download ${entry.name}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <DownloadSimple size={14} />
                  </a>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(entry);
                    }}
                    aria-label={`Delete ${entry.name}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash size={14} />
                  </button>
                </>
              ) : (
                <CaretRight size={14} className="shrink-0 text-muted-foreground" />
              )}
            </div>
          ))
        )}
      </div>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent className="v2 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-[16px] font-semibold tracking-tight text-foreground">
              Delete file
            </DialogTitle>
            <DialogDescription className="text-[13px] text-muted-foreground">
              Delete{" "}
              <span className="font-mono text-foreground">
                {deleteTarget?.name}
              </span>
              ? This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-1 flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={del.isPending}
              onClick={() => deleteTarget && del.mutate(deleteTarget)}
              className="gap-1.5"
            >
              {del.isPending ? (
                <CircleNotch size={14} className="animate-spin" />
              ) : (
                <Trash size={14} />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
