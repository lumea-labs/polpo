"use client";

import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePolpoClient } from "#/lib/polpo-client";
import {
  Folder, FileText, File, Image, Music, Video, Archive,
  ChevronRight, ChevronLeft, Download,
} from "lucide-react";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

function formatSize(bytes?: number) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(entry: FileEntry) {
  if (entry.type === "directory") return <Folder className="h-4 w-4 text-blue-500" />;
  const m = entry.mimeType ?? "";
  if (m.startsWith("image/")) return <Image className="h-4 w-4 text-amber-500" />;
  if (m.startsWith("audio/")) return <Music className="h-4 w-4 text-purple-500" />;
  if (m.startsWith("video/")) return <Video className="h-4 w-4 text-red-500" />;
  if (m === "application/pdf") return <FileText className="h-4 w-4 text-red-500" />;
  if (m.startsWith("text/") || m === "application/json") return <FileText className="h-4 w-4 text-muted-foreground" />;
  if (m.includes("zip") || m.includes("tar")) return <Archive className="h-4 w-4 text-muted-foreground" />;
  return <File className="h-4 w-4 text-muted-foreground" />;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Reusable file browser component.
 * Shows a navigable file listing for a given root path.
 */
export function FileBrowser({
  projectId,
  rootPath,
  compact = false,
  onFileSelect,
  initialEntries,
}: {
  projectId: string;
  rootPath: string;
  /** Compact mode: smaller text, no modified column */
  compact?: boolean;
  /** Called when a file is clicked. If provided, opens in-app instead of downloading. */
  onFileSelect?: (filePath: string, fileName: string) => void;
  /** Pre-fetched root-path entries (e.g. SSR'd alongside the page). Seeds
   *  the initial useQuery cache so the first render doesn't trigger a
   *  client-side refetch for content the parent already has. Navigating
   *  into a subdirectory refetches as usual. */
  initialEntries?: FileEntry[];
}) {
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [pathStack, setPathStack] = useState<string[]>([]);

  const polpo = usePolpoClient(projectId);
  const { data: listing, isLoading } = useQuery({
    queryKey: ["files-list", projectId, currentPath],
    queryFn: () => polpo.listFiles(currentPath) as unknown as Promise<{ path: string; entries: FileEntry[] }>,
    // Only seed for the root path (where initialEntries was captured);
    // subdirs fetch normally.
    initialData:
      initialEntries && currentPath === rootPath
        ? { path: rootPath, entries: initialEntries }
        : undefined,
    // File listings change when install/remove/upload happens.
    // 60s window keeps chatter down during navigation without
    // making the browser feel stale after the user just uploaded.
    staleTime: 60 * 1000,
  });

  const entries = listing?.entries ?? [];

  const navigateTo = useCallback((dirName: string) => {
    const newPath = `${currentPath}/${dirName}`;
    setPathStack((prev) => [...prev, currentPath]);
    setCurrentPath(newPath);
  }, [currentPath]);

  const navigateBack = useCallback(() => {
    const prev = pathStack[pathStack.length - 1] ?? rootPath;
    setPathStack((ps) => ps.slice(0, -1));
    setCurrentPath(prev);
  }, [pathStack, rootPath]);

  const getDownloadUrl = (filePath: string) =>
    `${API_URL}/v1/projects/${projectId}/data/v1/files/read?path=${encodeURIComponent(filePath)}&download=1`;

  const handleClick = (entry: FileEntry) => {
    if (entry.type === "directory") {
      navigateTo(entry.name);
    } else {
      const filePath = `${currentPath}/${entry.name}`;
      if (onFileSelect) {
        onFileSelect(filePath, entry.name);
      } else {
        window.open(getDownloadUrl(filePath), "_blank");
      }
    }
  };

  const isAtRoot = pathStack.length === 0;
  const displayPath = currentPath.replace(rootPath, "").replace(/^\//, "") || ".";

  if (isLoading) {
    return <div className="py-4 text-center text-xs text-muted-foreground">Loading...</div>;
  }

  if (entries.length === 0) {
    return <div className="py-4 text-center text-xs text-muted-foreground">Empty directory</div>;
  }

  const textSize = compact ? "text-xs" : "text-sm";

  return (
    <div>
      {/* Breadcrumb */}
      {!isAtRoot && (
        <button
          onClick={navigateBack}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2 transition-colors"
        >
          <ChevronLeft className="h-3 w-3" />
          {displayPath || "Back"}
        </button>
      )}

      {/* File list */}
      <div className="rounded-lg border border-border overflow-hidden">
        {entries.map((entry) => (
          <div
            key={entry.name}
            onClick={() => handleClick(entry)}
            className={`flex items-center gap-2.5 px-3 py-2 border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors ${textSize}`}
          >
            {fileIcon(entry)}
            <span className="font-medium flex-1 truncate font-mono">{entry.name}</span>
            {entry.type === "file" && entry.size != null && (
              <span className="text-muted-foreground/50 text-[11px] shrink-0">{formatSize(entry.size)}</span>
            )}
            {entry.type === "directory" ? (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <Download className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
