"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { usePolpoClient } from "@/lib/polpo-client";
import {
  Folder, FileText, File, Image, Music, Video, Archive,
  ChevronRight, ChevronLeft, Download, Search,
  RefreshCw, HardDrive, FolderOpen, Upload, Pencil, Trash2, MoreHorizontal,
} from "lucide-react";

// ── Types ──
interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string;
}

interface FileRoot {
  id: string;
  name: string;
  path: string;
  description: string;
  totalFiles: number;
  totalSize: number;
}

// ── Helpers ──
function formatSize(bytes?: number) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function fileIcon(entry: FileEntry) {
  if (entry.type === "directory") return <Folder className="h-5 w-5 text-blue-500" />;
  const m = entry.mimeType ?? "";
  if (m.startsWith("image/")) return <Image className="h-5 w-5 text-amber-500" />;
  if (m.startsWith("audio/")) return <Music className="h-5 w-5 text-purple-500" />;
  if (m.startsWith("video/")) return <Video className="h-5 w-5 text-red-500" />;
  if (m === "application/pdf") return <FileText className="h-5 w-5 text-red-500" />;
  if (m.startsWith("text/") || m === "application/json") return <FileText className="h-5 w-5 text-muted-foreground" />;
  if (m.includes("zip") || m.includes("tar") || m.includes("gzip")) return <Archive className="h-5 w-5 text-muted-foreground" />;
  return <File className="h-5 w-5 text-muted-foreground" />;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Main View ──
export default function StorageView() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [currentPath, setCurrentPath] = useState(".");
  const [pathStack, setPathStack] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const polpo = usePolpoClient(id);

  // Roots — `.polpo` is an internal runtime directory; filter it out so
  // users only see the meaningful ones (agent volumes, shared storage).
  const { data: rawRoots = [] } = useQuery({
    queryKey: ["files-roots", id],
    queryFn: async () => {
      const r = await polpo.getFileRoots();
      return (r.roots ?? []) as unknown as FileRoot[];
    },
  });
  const roots = rawRoots.filter(
    (r) => !r.path.endsWith(".polpo") && !r.path.endsWith("/.polpo") && r.name !== ".polpo",
  );

  // If filtering leaves a single root, drop the user straight into it —
  // no reason to show a one-item root picker.
  useEffect(() => {
    if (currentPath === "." && roots.length === 1) {
      setCurrentPath(roots[0].path);
    }
  }, [roots, currentPath]);

  // Directory listing
  const { data: listing, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["files-list", id, currentPath],
    queryFn: () => polpo.listFiles(currentPath) as unknown as Promise<{ path: string; entries: FileEntry[] }>,
  });

  const entries = listing?.entries ?? [];
  const filtered = searchQuery
    ? entries.filter((e) => e.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : entries;

  const navigateTo = useCallback((dirName: string) => {
    const newPath = currentPath === "." ? dirName : `${currentPath}/${dirName}`;
    setPathStack((prev) => [...prev, currentPath]);
    setCurrentPath(newPath);
    setSearchQuery("");
  }, [currentPath]);

  const navigateBack = useCallback(() => {
    const prev = pathStack[pathStack.length - 1] ?? ".";
    setPathStack((ps) => ps.slice(0, -1));
    setCurrentPath(prev);
    setSearchQuery("");
  }, [pathStack]);

  const navigateToRoot = useCallback((root: FileRoot) => {
    setPathStack(["."]);
    setCurrentPath(root.path);
    setSearchQuery("");
  }, []);

  const getDownloadUrl = (filePath: string) =>
    `${API_URL}/v1/projects/${id}/data/v1/files/read?path=${encodeURIComponent(filePath)}&download=1`;

  const handleRowClick = (entry: FileEntry) => {
    if (entry.type === "directory") {
      navigateTo(entry.name);
    } else {
      // Direct download
      const filePath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
      window.open(getDownloadUrl(filePath), "_blank");
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      // SDK uploads one file at a time; the dashboard supports multi-select,
      // so we loop. Each upload is independent — a failure mid-batch
      // leaves earlier files uploaded (intentional, same as the raw-fetch
      // implementation that preceded this).
      for (const file of Array.from(files)) {
        await polpo.uploadFile(currentPath, file, file.name);
      }
      queryClient.invalidateQueries({ queryKey: ["files-list", id, currentPath] });
      queryClient.invalidateQueries({ queryKey: ["files-roots", id] });
      refetch();
    } catch (err) {
      console.error("Upload error:", err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleRename = async (oldName: string) => {
    if (!renameValue.trim() || renameValue === oldName) {
      setRenaming(null);
      return;
    }
    const filePath = currentPath === "." ? oldName : `${currentPath}/${oldName}`;
    try {
      await polpo.renameFile(filePath, renameValue.trim());
      queryClient.invalidateQueries({ queryKey: ["files-list", id, currentPath] });
      refetch();
    } catch (err) {
      console.error("Rename error:", err);
    }
    setRenaming(null);
  };

  const handleDelete = async (entryName: string) => {
    const filePath = currentPath === "." ? entryName : `${currentPath}/${entryName}`;
    if (!confirm(`Delete "${entryName}"?`)) return;
    try {
      await polpo.deleteFile(filePath);
      queryClient.invalidateQueries({ queryKey: ["files-list", id, currentPath] });
      queryClient.invalidateQueries({ queryKey: ["files-roots", id] });
      refetch();
    } catch (err) {
      console.error("Delete error:", err);
    }
    setMenuOpen(null);
  };

  const isRoot = pathStack.length === 0 && currentPath === ".";
  // With a single (non-.polpo) root the user is auto-dropped into it; the
  // back button would only surface the one-item root picker, which is dead
  // weight. Hide back whenever the stack is empty.
  const canNavigateBack = pathStack.length > 0;
  const breadcrumb = currentPath === "." ? "Files" : currentPath;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {canNavigateBack && (
            <button onClick={navigateBack} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex items-center gap-2">
            <HardDrive className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-bold">{breadcrumb}</h2>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-48 border border-border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {/* Upload */}
          <input ref={fileInputRef} type="file" multiple hidden onChange={handleUpload} />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || isRoot}
            className="inline-flex items-center gap-1.5 border border-border px-3 py-2 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            <Upload className={`h-3.5 w-3.5 ${uploading ? "animate-spin" : ""}`} />
            {uploading ? "Uploading..." : "Upload"}
          </button>
          {/* Refresh */}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="p-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Root chips */}
      {isRoot && roots.length > 0 && (
        <div className="flex gap-3">
          {roots.map((root) => (
            <button
              key={root.id}
              onClick={() => navigateToRoot(root)}
              className="flex items-center gap-2 border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted"
            >
              <FolderOpen className="h-5 w-5 text-brand" />
              <div>
                <p className="text-sm font-semibold">{root.name}</p>
                <p className="text-xs text-muted-foreground">
                  {root.totalFiles} files · {formatSize(root.totalSize)}
                </p>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* File list */}
      {isLoading ? (
        <div className="mt-4 border border-border overflow-hidden">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border last:border-0 px-4 py-3">
              <div className="h-4 w-4 bg-secondary rounded animate-pulse" />
              <div className="h-3.5 bg-secondary rounded animate-pulse" style={{ width: `${100 + i * 30}px` }} />
              <div className="ml-auto h-3 w-16 bg-secondary/50 rounded animate-pulse" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FolderOpen className="h-10 w-10 mb-3" />
          <p className="text-sm">{searchQuery ? "No matching files" : "Empty directory"}</p>
        </div>
      ) : (
        <div className="border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                <th className="px-4 py-2.5 text-left font-medium">Name</th>
                <th className="px-4 py-2.5 text-left font-medium w-24">Size</th>
                <th className="px-4 py-2.5 text-left font-medium w-40 hidden md:table-cell">Modified</th>
                <th className="px-4 py-2.5 w-10" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr
                  key={entry.name}
                  onClick={() => { if (renaming !== entry.name) handleRowClick(entry); }}
                  className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors group"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      {fileIcon(entry)}
                      {renaming === entry.name ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => handleRename(entry.name)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRename(entry.name);
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="h-7 rounded border border-border bg-background px-2 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      ) : (
                        <span className="font-medium truncate max-w-xs">{entry.name}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {entry.type === "directory" ? "—" : formatSize(entry.size)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                    {formatDate(entry.modifiedAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="relative">
                      {entry.type === "directory" ? (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpen(menuOpen === entry.name ? null : entry.name); }}
                          className="p-1 rounded hover:bg-muted transition-colors"
                        >
                          <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                        </button>
                      )}
                      {/* Context menu */}
                      {menuOpen === entry.name && (
                        <div className="absolute right-0 top-8 z-20 w-36 border border-border bg-card shadow-lg py-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const filePath = currentPath === "." ? entry.name : `${currentPath}/${entry.name}`;
                              window.open(getDownloadUrl(filePath), "_blank");
                              setMenuOpen(null);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
                          >
                            <Download className="h-3.5 w-3.5" /> Download
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setRenaming(entry.name);
                              setRenameValue(entry.name);
                              setMenuOpen(null);
                            }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-xs hover:bg-muted transition-colors"
                          >
                            <Pencil className="h-3.5 w-3.5" /> Rename
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(entry.name); }}
                            className="flex w-full items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-muted transition-colors"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
