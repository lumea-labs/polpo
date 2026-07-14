"use client";

import { useCallback, useState } from "react";
import { CaretLeft, CaretRight, DownloadSimple } from "@phosphor-icons/react";
import { usePolpoClient, useQuery } from "./host.js";
import {
  EntryIcon,
  type FileEntry,
  fileUrl,
  formatSize,
} from "./file-browser-primitives.js";

function joinPath(base: string, name: string) {
  return `${base.replace(/\/$/, "")}/${name}`;
}

export function FileDirectoryBrowser({
  projectId,
  rootPath,
  compact = false,
  initialEntries,
  onFileSelect,
  emptyLabel = "Empty directory",
}: {
  projectId: string;
  rootPath: string;
  compact?: boolean;
  initialEntries?: FileEntry[];
  onFileSelect?: (filePath: string, fileName: string) => void;
  emptyLabel?: string;
}) {
  const polpo = usePolpoClient(projectId);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [pathStack, setPathStack] = useState<string[]>([]);

  const { data: listing, isLoading } = useQuery({
    queryKey: ["files-list", projectId, currentPath],
    queryFn: () =>
      polpo.listFiles(currentPath) as unknown as Promise<{
        path: string;
        entries: FileEntry[];
      }>,
    initialData:
      initialEntries && currentPath === rootPath
        ? { path: rootPath, entries: initialEntries }
        : undefined,
    staleTime: 60_000,
  });

  const entries = listing?.entries ?? [];
  const isAtRoot = pathStack.length === 0;
  const displayPath =
    currentPath.replace(rootPath, "").replace(/^\//, "") || "Files";
  const rowPadding = compact ? "px-3 py-2" : "px-3.5 py-2.5";
  const nameSize = compact ? "text-[12px]" : "text-[13px]";

  const navigateTo = useCallback(
    (dirName: string) => {
      const next = joinPath(currentPath, dirName);
      setPathStack((prev) => [...prev, currentPath]);
      setCurrentPath(next);
    },
    [currentPath],
  );

  const navigateBack = useCallback(() => {
    const previous = pathStack[pathStack.length - 1] ?? rootPath;
    setPathStack((prev) => prev.slice(0, -1));
    setCurrentPath(previous);
  }, [pathStack, rootPath]);

  function open(entry: FileEntry) {
    const fullPath = joinPath(currentPath, entry.name);
    if (entry.type === "directory") {
      navigateTo(entry.name);
      return;
    }
    if (onFileSelect) {
      onFileSelect(fullPath, entry.name);
      return;
    }
    window.open(fileUrl(projectId, fullPath), "_blank", "noopener,noreferrer");
  }

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border py-8 text-center text-[13px] text-muted-foreground">
        Loading files...
      </div>
    );
  }

  return (
    <div className="min-w-0">
      {!isAtRoot && (
        <button
          type="button"
          onClick={navigateBack}
          className="mb-2 inline-flex max-w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <CaretLeft size={12} />
          <span className="truncate">{displayPath}</span>
        </button>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        {entries.length === 0 ? (
          <div className="py-8 text-center text-[13px] text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          entries.map((entry) => {
            const fullPath = joinPath(currentPath, entry.name);
            return (
              <div
                key={`${entry.type}:${entry.name}`}
                className={`group flex items-center gap-2.5 border-b border-border transition-colors last:border-0 hover:bg-secondary/50 ${rowPadding}`}
              >
                <button
                  type="button"
                  onClick={() => open(entry)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  <EntryIcon entry={entry} />
                  <span
                    className={`min-w-0 flex-1 truncate font-mono ${nameSize} text-foreground`}
                  >
                    {entry.name}
                  </span>
                </button>
                {entry.type === "file" ? (
                  <>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
                      {formatSize(entry.size)}
                    </span>
                    <a
                      href={fileUrl(projectId, fullPath, true)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Download ${entry.name}`}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground/50 opacity-0 transition-opacity hover:bg-secondary hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <DownloadSimple size={14} />
                    </a>
                  </>
                ) : (
                  <CaretRight size={14} className="shrink-0 text-muted-foreground" />
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
