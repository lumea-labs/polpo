"use client";

/**
 * Shared Polpo chat surface — the single source of truth for the chat
 * composition used by BOTH the Playground and the Agent Builder so they
 * are guaranteed identical.
 *
 * Composition (mirrors lumea-agents components/screens/chat.tsx):
 *   PolpoProvider (session-cookie fetch, no API key in the browser)
 *     → FilesPanel (workspace files, slides in from the right)
 *     → ChatSurface = usePolpoChatAdapter + ChatProvider
 *          + ToolCallVariantProvider variant="task"
 *          + <Chat> with a custom <InputBar> (Skills menu, slash trigger,
 *            attachments, ask-user handoff)
 *
 * `<PolpoChat>` is the high-level wrapper: pass `baseUrl` + the selected
 * `agent`, it owns the session lifecycle (?session= persistence, reset on
 * agent switch) and the cookie fetch. Files panel open state is optional
 * (controlled) so a parent toolbar can toggle it.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PolpoProvider } from "@polpo-ai/react";
import {
  usePolpoChatAdapter,
  PolpoChatCapabilitiesMenu,
  usePolpoChatSlashItems,
} from "@lumea-labs/chat-polpo";
import {
  ChatAskUser,
  ChatTriggerMenu,
  useChatContext,
  useChatTriggerMenu,
  useSubmitHandler,
  type AskUserQuestion,
  type PromptInputMessage,
} from "@lumea-labs/chat";
import { ChatShell } from "@/components/dashboard/chat-shell";
import {
  FileManagerProvider,
  FileList,
  FileToolbar,
  FilePreviewDialog,
  FilePreviewRouter,
  defaultFmLabels,
} from "@lumea-labs/file-manager";
import {
  PolpoFilePreview,
  usePolpoFileAdapter,
} from "@lumea-labs/file-manager-polpo";
import { pdfHandler } from "@lumea-labs/file-manager-polpo/handlers/pdf-handler";
import { imageHandler } from "@lumea-labs/file-manager-polpo/handlers/image-handler";
import { audioHandler } from "@lumea-labs/file-manager-polpo/handlers/audio-handler";
import { videoHandler } from "@lumea-labs/file-manager-polpo/handlers/video-handler";
import { NextIntlClientProvider } from "next-intl";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

/* ------------------------------------------------------------------ */
/*  PolpoChat — high-level wrapper (providers + session lifecycle)      */
/* ------------------------------------------------------------------ */

export function PolpoChat({
  baseUrl,
  agent,
  filesOpen,
  onFilesOpenChange,
}: {
  baseUrl: string;
  agent: string | undefined;
  /** Controlled files-panel open state. Optional — defaults to internal. */
  filesOpen?: boolean;
  onFilesOpenChange?: (open: boolean) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Session lifecycle — capture ?session= at mount, never re-pass as
  // prop, commit new ids to the URL on stream finish so we don't trigger
  // a mid-stream reload. Reset on agent switch.
  const initialSessionIdRef = useRef<string | undefined>(
    searchParams.get("session") ?? undefined,
  );
  const pendingSessionIdRef = useRef<string | null>(null);

  const commitSession = useRef<(id: string) => void>(() => {});
  commitSession.current = (id: string) => {
    const current = searchParams.get("session");
    if (current === id) return;
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.set("session", id);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  const handleSessionCreated = useCallback((id: string) => {
    pendingSessionIdRef.current = id;
  }, []);

  const handleFinish = useCallback(() => {
    const id = pendingSessionIdRef.current;
    if (id) {
      pendingSessionIdRef.current = null;
      commitSession.current(id);
    }
  }, []);

  // On agent switch (not initial mount) clear the session so a fresh one
  // starts. The `key={agent}` on ChatSurface remounts the tier-2 wiring.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    initialSessionIdRef.current = undefined;
    pendingSessionIdRef.current = null;
    if (searchParams.get("session")) {
      const params = new URLSearchParams(Array.from(searchParams.entries()));
      params.delete("session");
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent]);

  const cookieFetch = useMemo<typeof globalThis.fetch>(
    () =>
      ((input, init) =>
        globalThis.fetch(input, {
          ...init,
          credentials: "include",
        })) as typeof globalThis.fetch,
    [],
  );

  const [internalFiles, setInternalFiles] = useState(false);
  const isOpen = filesOpen ?? internalFiles;
  const setOpen = onFilesOpenChange ?? setInternalFiles;

  return (
    <NextIntlClientProvider
      locale="en"
      messages={{}}
      onError={() => {}}
      getMessageFallback={({ key }) => key}
    >
      <PolpoProvider
        baseUrl={baseUrl}
        apiPrefix="/v1"
        fetch={cookieFetch}
        autoConnect={false}
      >
        <FilesPanel open={isOpen} onOpenChange={setOpen} />
        <ChatSurface
          key={agent}
          sessionId={initialSessionIdRef.current}
          agent={agent}
          onSessionCreated={handleSessionCreated}
          onFinish={handleFinish}
        />
      </PolpoProvider>
    </NextIntlClientProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  FilesPanel — workspace files (slides in from the right)            */
/* ------------------------------------------------------------------ */

export function FilesPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const adapter = usePolpoFileAdapter();

  return (
    <FileManagerProvider adapter={adapter} layout="compact" labels={defaultFmLabels}>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full sm:!w-[560px] sm:!max-w-[560px] lg:!w-[640px] lg:!max-w-[640px] p-0 gap-0 flex flex-col bg-card"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <SheetTitle className="text-sm font-semibold tracking-tight text-foreground">
              Files
            </SheetTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Project workspace — files written by agents and uploads
            </p>
          </div>
          <div className="shrink-0 border-b border-border px-2 py-1.5">
            <FileToolbar />
          </div>
          <div className="flex-1 min-h-0 overflow-auto">
            <FileList />
          </div>
        </SheetContent>
      </Sheet>

      <FilePreviewDialog>
        <FilePreviewRouter
          handlers={[pdfHandler, imageHandler, audioHandler, videoHandler]}
        >
          <PolpoFilePreview />
        </FilePreviewRouter>
      </FilePreviewDialog>
    </FileManagerProvider>
  );
}

/* ------------------------------------------------------------------ */
/*  ChatSurface — usePolpoChatAdapter + ChatProvider + Chat            */
/* ------------------------------------------------------------------ */

function ChatSurface({
  sessionId,
  agent,
  onSessionCreated,
  onFinish,
}: {
  sessionId: string | undefined;
  agent: string | undefined;
  onSessionCreated: (id: string) => void;
  onFinish: () => void;
}) {
  const adapter = usePolpoChatAdapter({
    sessionId,
    agent,
    onSessionCreated,
    onFinish,
  });
  return (
    <ChatShell adapter={adapter}>
      <InputBar agent={agent} />
    </ChatShell>
  );
}

/* ------------------------------------------------------------------ */
/*  InputBar — custom composer (skills, slash, attachments, ask-user)  */
/* ------------------------------------------------------------------ */

function InputBar({ agent }: { agent: string | undefined }) {
  const {
    sendMessage,
    isStreaming,
    abort,
    uploadFile,
    isUploading,
    pendingToolCall,
  } = useChatContext();

  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const askUserQuestions =
    pendingToolCall?.toolName === "ask_user_question"
      ? ((pendingToolCall.arguments?.questions ?? []) as AskUserQuestion[])
      : null;

  const submit = useSubmitHandler(sendMessage, uploadFile);

  // Scope the "/" skills menu to the selected agent's own skills.
  const slash = usePolpoChatSlashItems({ agent, skillsScope: "assigned" });
  const slashMenu = useChatTriggerMenu({
    triggers: slash.triggers,
    onSelect: (item) => {
      void slash.onSelect(item);
    },
  });

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;

    const message: PromptInputMessage = {
      text: trimmed,
      files: pendingFiles.map((f) => ({
        url: URL.createObjectURL(f),
        filename: f.name,
      })),
    };

    setText("");
    setPendingFiles([]);
    setSendError(null);

    try {
      await submit(message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSendError(msg || "Send failed");
      // eslint-disable-next-line no-console
      console.error("[polpo-chat] send failed:", err);
    } finally {
      message.files.forEach((f) => URL.revokeObjectURL(f.url));
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (isStreaming) {
      abort();
    } else {
      void handleSend();
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as FormEvent);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files) return;
    setPendingFiles((prev) => [...prev, ...Array.from(files)]);
  }

  if (askUserQuestions && askUserQuestions.length > 0) {
    return (
      <div className="shrink-0">
        <div className="mx-auto max-w-3xl px-4 py-3">
          <ChatAskUser
            variant="command"
            questions={askUserQuestions}
            onSubmit={(answers) => {
              void sendMessage(JSON.stringify({ answers }));
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="shrink-0">
      <div className="mx-auto max-w-3xl px-4 py-3">
        {sendError && (
          <div className="mb-2 flex items-start justify-between gap-2 border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="flex-1">
              <span className="font-semibold">Send failed.</span>{" "}
              <span className="opacity-80">{sendError}</span>
            </span>
            <button
              type="button"
              onClick={() => setSendError(null)}
              aria-label="Dismiss"
              className="shrink-0 text-destructive/70 hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingFiles.map((f, i) => (
              <span
                key={`${f.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs font-mono"
              >
                {f.name}
                <button
                  type="button"
                  onClick={() =>
                    setPendingFiles((prev) => prev.filter((_, j) => j !== i))
                  }
                  aria-label={`Remove ${f.name}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="relative rounded border border-border bg-card focus-within:border-foreground/40 transition-colors">
          <textarea
            ref={slashMenu.inputRef as React.Ref<HTMLTextAreaElement>}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              slashMenu.onChange(e);
            }}
            onKeyDown={(e) => {
              slashMenu.onKeyDown(e);
              if (!e.defaultPrevented) handleKeyDown(e);
            }}
            placeholder="Send a message…"
            rows={2}
            className="block w-full resize-none bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none"
          />

          <ChatTriggerMenu {...slashMenu.menuProps} />

          <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
              aria-label="Attach file"
            >
              <Paperclip className="h-4 w-4" />
            </button>

            <PolpoChatCapabilitiesMenu
              agent={agent}
              label="Skills"
              variant="icon"
              searchable
            />

            <span
              aria-hidden
              className="ml-1 hidden items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground sm:inline-flex"
            >
              <kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                /
              </kbd>
              skills
            </span>

            <button
              type="submit"
              disabled={!isStreaming && !text.trim() && pendingFiles.length === 0}
              className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded bg-foreground text-background transition-opacity hover:opacity-90 disabled:opacity-40"
              aria-label={isStreaming ? "Stop" : "Send"}
            >
              {isStreaming ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <ArrowUp className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}
