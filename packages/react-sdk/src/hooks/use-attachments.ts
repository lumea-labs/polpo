import { useCallback, useEffect, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import { useMutation } from "./use-mutation.js";
import type { Attachment } from "@polpo-ai/sdk";

export interface UseAttachmentsReturn {
  attachments: Attachment[];
  isLoading: boolean;
  error: Error | null;
  uploadAttachment: (file: File | Blob, filename: string) => Promise<Attachment>;
  isUploading: boolean;
  deleteAttachment: (id: string) => Promise<void>;
  isDeleting: boolean;
  refetch: () => Promise<void>;
}

export function useAttachments(sessionId: string | undefined): UseAttachmentsReturn {
  const { client } = usePolpoContext();

  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    if (!sessionId) return;
    try {
      const data = await client.listAttachments(sessionId);
      setAttachments(data);
    } catch (err) {
      setError(err as Error);
    }
  }, [client, sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setAttachments([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    refetch().finally(() => setIsLoading(false));
  }, [refetch, sessionId]);

  const { mutate: uploadAttachment, isPending: isUploading } = useMutation(
    useCallback(
      async (file: File | Blob, filename: string) => {
        if (!sessionId) throw new Error("sessionId is required");
        const attachment = await client.uploadAttachment(sessionId, file, filename);
        setAttachments((prev) => [...prev, attachment]);
        return attachment;
      },
      [client, sessionId],
    ),
  );

  const { mutate: deleteAttachment, isPending: isDeleting } = useMutation(
    useCallback(
      async (id: string) => {
        await client.deleteAttachment(id);
        setAttachments((prev) => prev.filter((a) => a.id !== id));
      },
      [client],
    ),
  );

  return {
    attachments,
    isLoading,
    error,
    uploadAttachment,
    isUploading,
    deleteAttachment,
    isDeleting,
    refetch,
  };
}
