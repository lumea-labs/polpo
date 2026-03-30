/**
 * Attachment metadata store — tracks uploaded files.
 *
 * Files can be uploaded without a session (OpenAI-compatible flow:
 * upload first, then reference in a message content part).
 * The sessionId is set later when the file is first referenced
 * in a completions request.
 *
 * The actual file content is managed by the FileSystem abstraction.
 * This store only persists metadata (filename, mimeType, size, path).
 */

/**
 * @deprecated Attachment metadata is no longer used. Files are referenced by workspace path.
 * This interface is retained for backward compatibility with existing drizzle stores and DB schemas.
 */
export interface Attachment {
  id: string;
  /** Session this file belongs to. Optional — files can be uploaded before a session exists. */
  sessionId?: string;
  /** Message this attachment belongs to (optional — set when attached to a specific message) */
  messageId?: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Relative path within the workspace (e.g. "attachments/{sessionId}/{filename}") */
  path: string;
  createdAt: string;
}

/**
 * @deprecated AttachmentStore is no longer used. Files are referenced by workspace path.
 * This interface is retained for backward compatibility with existing drizzle stores and DB schemas.
 */
export interface AttachmentStore {
  save(attachment: Attachment): Promise<void>;
  getBySession(sessionId: string): Promise<Attachment[]>;
  get(id: string): Promise<Attachment | undefined>;
  delete(id: string): Promise<boolean>;
  deleteBySession(sessionId: string): Promise<number>;
  /** Bind a loose file (no session) to a session. Called when the file is first referenced in a completions request. */
  updateSessionId?(id: string, sessionId: string): Promise<void>;
}
