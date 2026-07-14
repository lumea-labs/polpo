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
  mode: "file-drive" | "code-drive";
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

export function modeLabel(mode?: DriveVolume["mode"]) {
  switch (mode) {
    case "code-drive":
      return "Code Drive";
    case "file-drive":
      return "File Drive";
    default:
      return "File Drive";
  }
}

export function driveLabel(drive: DriveVolume) {
  return drive.label?.trim() || drive.name;
}

export function VolumeModeIcon({
  mode,
  size = 16,
  className,
}: {
  mode?: DriveVolume["mode"];
  size?: number;
  className?: string;
}) {
  switch (mode) {
    case "code-drive":
      return <Code size={size} className={className} />;
    case "file-drive":
      return <FolderOpen size={size} className={className} weight="fill" />;
    default:
      return <FolderOpen size={size} className={className} weight="fill" />;
  }
}

export function modeDescription(mode?: DriveVolume["mode"]) {
  switch (mode) {
    case "code-drive":
      return "For codebases and shell work. Polpo hydrates it into a real sandbox folder, then syncs useful changes back.";
    case "file-drive":
      return "For documents, uploaded assets, memory, skills, and files agents read or write on demand.";
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
