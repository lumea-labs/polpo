import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { FileRoot, FileEntry, FilePreview } from "@polpo-ai/sdk";

export interface UseFilesReturn {
  roots: FileRoot[];
  entries: FileEntry[];
  currentPath: string | null;
  isLoading: boolean;
  error: Error | null;
  listFiles: (root: string, path?: string) => Promise<FileEntry[]>;
  isListing: boolean;
  previewFile: (root: string, path: string, maxLines?: number) => Promise<FilePreview>;
  isPreviewing: boolean;
  refetchRoots: () => Promise<void>;
}

export function useFiles(root?: string, path?: string): UseFilesReturn {
  const { client } = usePolpoContext();

  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetchRoots = useCallback(async () => {
    try {
      const data = await client.getFileRoots();
      setRoots(data.roots);
    } catch (err) {
      setError(err as Error);
    }
  }, [client]);

  // Fetch roots on mount
  useEffect(() => {
    setIsLoading(true);
    refetchRoots().finally(() => setIsLoading(false));
  }, [refetchRoots]);

  // Auto-fetch entries when root/path changes
  useEffect(() => {
    if (!root) {
      setEntries([]);
      setCurrentPath(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    client
      .listFiles(root, path)
      .then((data) => {
        if (!cancelled) {
          setEntries(data.entries);
          setCurrentPath(data.path);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err as Error);
          setIsLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [client, root, path]);

  const { mutate: listFiles, isPending: isListing } = useMutation(
    useCallback(
      async (listRoot: string, listPath?: string) => {
        const data = await client.listFiles(listRoot, listPath);
        setEntries(data.entries);
        setCurrentPath(data.path);
        return data.entries;
      },
      [client],
    ),
  );

  const { mutate: previewFile, isPending: isPreviewing } = useMutation(
    useCallback(
      async (previewRoot: string, previewPath: string, maxLines?: number) => {
        return client.previewFile(previewRoot, previewPath, maxLines);
      },
      [client],
    ),
  );

  return {
    roots,
    entries,
    currentPath,
    isLoading,
    error,
    listFiles,
    isListing,
    previewFile,
    isPreviewing,
    refetchRoots,
  };
}
