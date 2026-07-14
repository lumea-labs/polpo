"use client";

import { useMemo } from "react";
import { usePolpo } from "@polpo-ai/react";
import type { DriveVolume, FileEntry } from "./file-browser-primitives.js";

export { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
export { Button } from "../ui/button.js";
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
export { DataTable, type ColumnMeta } from "../ui/data-table.js";
export { PageBody, PageHeader } from "../ui/page-header.js";
export { RefreshButton } from "../ui/refresh-button.js";
export { Skeleton } from "../ui/skeleton.js";

export const toast = {
  success(message: string) {
    window.dispatchEvent(
      new CustomEvent("polpo:notification", {
        detail: { type: "success", message },
      }),
    );
  },
  error(message: string) {
    window.dispatchEvent(
      new CustomEvent("polpo:notification", {
        detail: { type: "error", message },
      }),
    );
  },
};

function normalizeEntry(entry: {
  name: string;
  isDirectory?: boolean;
  type?: "file" | "directory";
  size?: number;
  mimeType?: string;
  modifiedAt?: string | Date;
}): FileEntry {
  return {
    name: entry.name,
    type: entry.type ?? (entry.isDirectory ? "directory" : "file"),
    size: entry.size,
    mimeType: entry.mimeType,
    modifiedAt:
      entry.modifiedAt instanceof Date
        ? entry.modifiedAt.toISOString()
        : entry.modifiedAt,
  };
}

export function usePolpoClient(_projectId: string) {
  const { client } = usePolpo();
  return useMemo(
    () => ({
      async getVolumes(): Promise<{
        volumes: DriveVolume[];
        defaults: { volume?: string };
      }> {
        const { roots } = await client.getFileRoots();
        const volumes = roots.map((root) => ({
          id: root.id,
          name: root.id,
          label: root.name,
          mode:
            root.id === "workspace"
              ? ("code-drive" as const)
              : ("file-drive" as const),
          mountPath: root.path,
          path: root.path,
          absolutePath: root.absolutePath,
          totalFiles: root.totalFiles,
          totalSize: root.totalSize,
        }));
        return { volumes, defaults: { volume: volumes[0]?.name } };
      },
      async saveVolume(_volume: {
        name: string;
        label: string | null;
        mode: DriveVolume["mode"];
        mountPath: string | null;
      }): Promise<DriveVolume> {
        throw new Error(
          "Drive management is not available in the self-hosted dashboard",
        );
      },
      async removeVolume(_name: string): Promise<void> {
        throw new Error(
          "Drive management is not available in the self-hosted dashboard",
        );
      },
      async listFiles(path: string) {
        const result = await client.listFiles(path);
        return {
          path: result.path,
          entries: result.entries.map(normalizeEntry),
        };
      },
      createDirectory: (path: string) => client.createDirectory(path),
      uploadFile: (path: string, file: File, name: string) =>
        client.uploadFile(path, file, name),
      deleteFile: (path: string) => client.deleteFile(path),
    }),
    [client],
  );
}
