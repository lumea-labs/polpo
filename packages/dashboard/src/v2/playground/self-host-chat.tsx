"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { PolpoProvider } from "@polpo-ai/react";
import { usePolpoChatAdapter, PolpoChatCapabilitiesMenu, usePolpoChatSlashItems } from "@lumea-labs/chat-polpo";
import {
  Chat,
  ChatAskUser,
  ChatProvider,
  ChatTriggerMenu,
  ToolCallVariantProvider,
  useChatContext,
  useChatTriggerMenu,
  useSubmitHandler,
  type AskUserQuestion,
  type PromptInputMessage,
} from "@lumea-labs/chat";
import { ToolFileOpenProvider } from "@lumea-labs/tool-calls";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";

export function SelfHostPolpoChat({
  agent,
  loop,
  onSession,
  landing,
  composerControls,
  gutter,
}: {
  baseUrl: string;
  agent: string | undefined;
  loop: string | undefined;
  onSession: (sessionId: string | undefined) => void;
  landing: ReactNode;
  composerControls: ReactNode;
  gutter: "none";
}) {
  const initialSession = useRef<string | undefined>(
    typeof window === "undefined" ? undefined : new URLSearchParams(window.location.search).get("session") ?? undefined,
  );
  const pendingSession = useRef<string | undefined>(initialSession.current);
  const previous = useRef({ agent, loop });

  useEffect(() => { onSession(initialSession.current); }, [onSession]);
  useEffect(() => {
    if (previous.current.agent === agent && previous.current.loop === loop) return;
    previous.current = { agent, loop };
    initialSession.current = undefined;
    pendingSession.current = undefined;
    onSession(undefined);
  }, [agent, loop, onSession]);

  return (
    <PolpoProvider baseUrl="" apiPrefix="/api/polpo" autoConnect={false}>
      <SelfHostChatSurface
        agent={agent}
        loop={loop}
        sessionId={initialSession.current}
        landing={landing}
        composerControls={composerControls}
        gutter={gutter}
        onSessionCreated={(id) => { pendingSession.current = id; onSession(id); }}
        onFinish={() => {
          const id = pendingSession.current;
          if (!id) return;
          const params = new URLSearchParams(window.location.search);
          params.set("session", id);
          window.history.replaceState(null, "", `?${params.toString()}`);
        }}
      />
    </PolpoProvider>
  );
}

function SelfHostChatSurface({ agent, loop, sessionId, landing, composerControls, gutter, onSessionCreated, onFinish }: {
  agent: string | undefined;
  loop: string | undefined;
  sessionId: string | undefined;
  landing: ReactNode;
  composerControls: ReactNode;
  gutter: "none";
  onSessionCreated: (id: string) => void;
  onFinish: () => void;
}) {
  const adapter = usePolpoChatAdapter({
    sessionId,
    agent,
    loop,
    onSessionCreated,
    onUpdate: () => window.dispatchEvent(new CustomEvent("polpo:trace-activity")),
    onFinish: () => { onFinish(); window.dispatchEvent(new CustomEvent("polpo:trace-activity")); },
  });
  return (
    <ChatProvider adapter={adapter}>
      <ToolFileOpenProvider onOpenFile={(path) => window.open(`/api/polpo/v1/files/read?path=${encodeURIComponent(path)}`, "_blank", "noopener,noreferrer")}>
        <ToolCallVariantProvider variant="task">
          <Chat className="flex-1" gutter={gutter}>
            {({ hasMessages }) => hasMessages ? <InputBar agent={agent} controls={composerControls} /> : landing}
          </Chat>
        </ToolCallVariantProvider>
      </ToolFileOpenProvider>
    </ChatProvider>
  );
}

function InputBar({ agent, controls }: { agent: string | undefined; controls?: ReactNode }) {
  const { sendMessage, isStreaming, abort, uploadFile, isUploading, pendingToolCall } = useChatContext();
  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const submit = useSubmitHandler(sendMessage, uploadFile);
  const askUserQuestions = pendingToolCall?.toolName === "ask_user_question" ? (pendingToolCall.arguments?.questions ?? []) as AskUserQuestion[] : null;
  const slash = usePolpoChatSlashItems({ agent, skillsScope: "assigned" });
  const slashMenu = useChatTriggerMenu({ triggers: slash.triggers, onSelect: (item) => { void slash.onSelect(item); } });

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    const message: PromptInputMessage = { text: trimmed, files: pendingFiles.map((file) => ({ url: URL.createObjectURL(file), filename: file.name })) };
    setText("");
    setPendingFiles([]);
    try { await submit(message); } finally { message.files.forEach((file) => URL.revokeObjectURL(file.url)); }
  }, [pendingFiles, submit, text]);

  if (askUserQuestions?.length) {
    return <div className="shrink-0"><div className="mx-auto max-w-3xl px-4 py-3"><ChatAskUser variant="command" questions={askUserQuestions} onSubmit={(answers) => void sendMessage(JSON.stringify({ answers }))} /></div></div>;
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isStreaming) abort(); else void handleSend();
  }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    slashMenu.onKeyDown(event);
    if (!event.defaultPrevented && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void handleSend(); }
  }

  return (
    <form onSubmit={handleSubmit} className="shrink-0">
      <div className="mx-auto max-w-3xl px-4 py-3">
        {pendingFiles.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{pendingFiles.map((file, index) => <span key={`${file.name}-${index}`} className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-xs font-mono">{file.name}<button type="button" onClick={() => setPendingFiles((items) => items.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${file.name}`} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button></span>)}</div>}
        <div className="relative rounded-2xl border border-border bg-card shadow-sm transition-colors focus-within:border-foreground/20">
          <textarea
            ref={slashMenu.inputRef as React.Ref<HTMLTextAreaElement>}
            value={text}
            onChange={(event) => { setText(event.target.value); slashMenu.onChange(event); }}
            onKeyDown={handleKeyDown}
            placeholder="Send a message…"
            rows={2}
            className="block max-h-[200px] min-h-[58px] w-full resize-none overflow-y-auto bg-transparent px-4 py-3.5 text-sm placeholder:text-muted-foreground/50 [field-sizing:content] focus:outline-none"
          />
          <ChatTriggerMenu {...slashMenu.menuProps} />
          <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
            {controls && <>{controls}<div className="mx-1 h-4 w-px bg-border" /></>}
            <input ref={fileInputRef} type="file" multiple hidden onChange={(event) => { if (event.target.files) setPendingFiles((items) => [...items, ...Array.from(event.target.files!)]); event.target.value = ""; }} />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50" aria-label="Attach file"><Paperclip className="h-4 w-4" /></button>
            <PolpoChatCapabilitiesMenu agent={agent} label="Skills" variant="icon" searchable />
            <span aria-hidden className="ml-1 hidden items-center gap-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground sm:inline-flex"><kbd className="rounded border border-border bg-card px-1.5 py-px font-mono text-[10px] text-muted-foreground">/</kbd>skills</span>
            <button type="submit" disabled={!isStreaming && !text.trim() && pendingFiles.length === 0} className="ml-auto inline-flex size-8 items-center justify-center rounded-lg bg-foreground text-background transition-colors hover:bg-foreground/90 disabled:opacity-40" aria-label={isStreaming ? "Stop" : "Send"}>{isStreaming ? <Square className="h-3.5 w-3.5" /> : <ArrowUp className="h-3.5 w-3.5" />}</button>
          </div>
        </div>
      </div>
    </form>
  );
}
