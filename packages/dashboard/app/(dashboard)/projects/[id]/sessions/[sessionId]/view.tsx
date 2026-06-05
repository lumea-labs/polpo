import Link from "next/link";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { ManualRefreshButton } from "@/components/dashboard/manual-refresh-button";
import RawView from "./raw-view";

export interface Attachment {
  id: string;
  sessionId: string;
  messageId?: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  state: string;
}

export interface ContentPart {
  type: "text" | "image_url" | "file";
  text?: string;
  image_url?: { url: string };
  file?: { path: string; filename?: string; mimeType?: string };
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string | ContentPart[];
  ts: string;
  toolCalls?: ToolCallInfo[];
}

export interface Session {
  id: string;
  title?: string;
  agent?: string;
  createdAt: string;
  messageCount: number;
}

export default function SessionDetailView({
  projectId,
  session,
  messages,
  attachments,
}: {
  projectId: string;
  session: Session | null;
  messages: Message[];
  attachments: Attachment[];
}) {
  if (!session) {
    return (
      <div data-testid="session-not-found" className="mt-4 border border-border p-8 text-center text-sm text-muted-foreground">
        Session not found.
      </div>
    );
  }

  return (
    <div>
      {/* Back link */}
      <Link
        href={`/projects/${projectId}/sessions`}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="h-3 w-3" />
        Sessions
      </Link>

      {/* Header */}
      <div className="mt-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight truncate">
            {session.title ?? "Untitled session"}
          </h2>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span className="font-mono">{session.id}</span>
            {session.agent && (
              <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono">
                {session.agent}
              </span>
            )}
            <span>{new Date(session.createdAt).toLocaleString()}</span>
            <span>{messages.length} messages</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ManualRefreshButton />
          {/* Resume in playground — opens a new tab with ?session=<id>.
              Lets the user continue an existing conversation interactively
              from the read-only session detail. */}
          <Link
            href={`/projects/${projectId}/playground?session=${session.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open in playground
          </Link>
        </div>
      </div>

      {/* Content */}
      {messages.length > 0 ? (
        <div data-testid="session-messages" className="mt-5">
          <RawView messages={messages} attachments={attachments} projectId={projectId} />
        </div>
      ) : (
        <div data-testid="session-messages-empty" className="mt-6 border border-border p-8 text-center text-sm text-muted-foreground">
          No messages in this session.
        </div>
      )}
    </div>
  );
}
