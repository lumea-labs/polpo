"use client";

import {
  Code,
  File as FileIcon,
  FilePdf,
  FileText,
  FileZip,
  FolderOpen,
  ImageSquare,
  MusicNotes,
  VideoCamera,
} from "@phosphor-icons/react";

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

export interface DriveVolume {
  id: string;
  name: string;
  label: string | null;
  strategy: "mounted" | "hydrated";
  mountPath: string | null;
  path: string;
  absolutePath: string;
  totalFiles: number;
  totalSize: number;
  sync?: {
    ignore?: string[];
  } | null;
}

/**
 * File URL on the data plane. A top-level navigation to this carries the
 * cross-subdomain session cookie, so the browser can render files natively.
 */
export function fileUrl(projectId: string, path: string, download = false) {
  void projectId;
  return `/api/polpo/files/read?path=${encodeURIComponent(
    path,
  )}${download ? "&download=1" : ""}`;
}

export function strategyLabel(strategy?: DriveVolume["strategy"]) {
  switch (strategy) {
    case "hydrated":
      return "Hydrated";
    case "mounted":
      return "Mounted";
    default:
      return "Mounted";
  }
}

export function driveLabel(drive: DriveVolume) {
  return drive.label?.trim() || drive.name;
}

export function VolumeStrategyIcon({
  strategy,
  size = 16,
  className,
}: {
  strategy?: DriveVolume["strategy"];
  size?: number;
  className?: string;
}) {
  switch (strategy) {
    case "hydrated":
      return <Code size={size} className={className} />;
    case "mounted":
      return <FolderOpen size={size} className={className} weight="fill" />;
    default:
      return <FolderOpen size={size} className={className} weight="fill" />;
  }
}

export function strategyDescription(strategy?: DriveVolume["strategy"]) {
  switch (strategy) {
    case "hydrated":
      return "Copies persistent contents into local sandbox storage before the run and synchronizes according to the writeback policy.";
    case "mounted":
      return "Attaches persistent storage live at the configured sandbox path for the duration of the lease.";
    default:
      return "Project volume.";
  }
}

export function formatSize(bytes?: number) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === "directory")
    return <FolderOpen size={16} weight="fill" className="text-brand/70" />;
  const m = entry.mimeType ?? "";
  const cls = "text-muted-foreground";
  if (m.startsWith("image/")) return <ImageSquare size={16} className={cls} />;
  if (m.startsWith("audio/")) return <MusicNotes size={16} className={cls} />;
  if (m.startsWith("video/")) return <VideoCamera size={16} className={cls} />;
  if (m === "application/pdf") return <FilePdf size={16} className={cls} />;
  if (m.includes("zip") || m.includes("tar"))
    return <FileZip size={16} className={cls} />;
  if (m.startsWith("text/") || m === "application/json")
    return <FileText size={16} className={cls} />;
  return <FileIcon size={16} className={cls} />;
}
