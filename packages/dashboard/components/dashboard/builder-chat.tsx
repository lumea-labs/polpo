"use client";

/**
 * Builder chat — the Meta Agent surface. Implements the `@lumea-labs/chat`
 * `ChatAdapter` against the control-plane `POST /v1/builder/chat` SSE
 * endpoint (gateway loop + data-plane tools), and renders it with the same
 * `<Chat>` UI the playground uses. When the Meta Agent mutates an agent
 * (create/update/delete/assign_skill), `onMutation` fires so the right pane
 * can refresh.
 *
 * SSE protocol (see packages/server/src/routes/builder.ts):
 *   event: text         data: { delta }
 *   event: tool-call    data: { toolCallId, toolName, args }
 *   event: tool-result  data: { toolCallId, toolName, result }
 *   event: ask-user     data: { questions }   ← human-in-the-loop pause
 *   event: error        data: { message }
 *   event: done         data: {}
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatAskUser,
  ChatInput,
  useChatContext,
  type AskUserQuestion,
  type ChatMessageData,
  type ChatStatus,
  type ContentPart,
  type PendingToolCall,
} from "@lumea-labs/chat";
import type { ToolCallEvent } from "@lumea-labs/tool-calls";
import { ChatShell } from "@/components/dashboard/chat-shell";
import type { BuilderContext, NavigateTarget } from "@/lib/builder-context";

/**
 * A tool-call mutated project data → trigger a refresh. The builder's data
 * tools are the MCP tools (`polpo_<resource>_<action>`); anything that isn't
 * a pure read (`_list`/`_get`/`_read`) changes state. Local tools
 * (search_web/http_fetch/navigate/ask_user_question) are never mutating.
 */
function isMutatingTool(name: string): boolean {
  return name.startsWith("polpo_") && !/_(list|get|read)$/.test(name);
}

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Math.round(performance.now() * 1000)}`;
  }
}

function contentToText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("")
    .trim();
}

function useBuilderChatAdapter({
  projectId,
  apiUrl,
  agentName,
  context,
  onMutation,
  onNavigate,
  persistKey,
}: {
  projectId: string;
  apiUrl: string;
  /** localStorage key — when set, the conversation persists across reloads
   *  (scoped by whatever the caller keys it on, e.g. project). */
  persistKey?: string;
  /** Agent currently open in the builder — sent so the server injects it
   *  into the Meta Agent's system context. */
  agentName?: string;
  /** Route-derived page context (global copilot) — sent so the server
   *  scopes the Meta Agent to what the user is looking at. */
  context?: BuilderContext;
  onMutation?: (tool: string) => void;
  /** Client-side navigation requested by the Meta Agent (navigate tool). */
  onNavigate?: (target: NavigateTarget) => void;
}) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const didPersist = useRef(false);

  // Hydrate the conversation from localStorage once on mount.
  useEffect(() => {
    if (!persistKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(persistKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) setMessages(parsed as ChatMessageData[]);
      }
    } catch {
      /* ignore corrupt storage */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey]);

  // Persist on change. Skip the mount commit so we don't clobber stored
  // history with the empty initial state before hydration runs.
  useEffect(() => {
    if (!persistKey || typeof window === "undefined") return;
    if (!didPersist.current) {
      didPersist.current = true;
      return;
    }
    try {
      window.localStorage.setItem(persistKey, JSON.stringify(messages));
    } catch {
      /* quota / serialization — best effort */
    }
  }, [persistKey, messages]);

  /** Patch the in-flight assistant message by id. */
  const patch = useCallback(
    (id: string, fn: (m: ChatMessageData) => ChatMessageData) => {
      setMessages((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
    },
    [],
  );

  const sendMessage = useCallback(
    async (content: string | ContentPart[]) => {
      const text = contentToText(content);
      if (!text) return;

      const userMsg: ChatMessageData = {
        id: uid(),
        role: "user",
        content: text,
        ts: new Date().toISOString(),
      };
      const assistantId = uid();
      const assistantMsg: ChatMessageData = {
        id: assistantId,
        role: "assistant",
        content: "",
        ts: new Date().toISOString(),
        segments: [],
      };

      // History sent to the server (role + text). Stateless re-run.
      // Drop empty-text messages: an assistant turn that only emitted tool
      // calls (update_agent, navigate, ask_user_question, …) has no text,
      // and Anthropic 400s on empty text content blocks. We replay text-only
      // history anyway, so those carry nothing.
      const history = [...messages, userMsg]
        .map((m) => ({ role: m.role, content: contentToText(m.content) }))
        .filter((m) => m.content.trim().length > 0);

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setStatus("streaming");
      setError(null);
      setPendingToolCall(null);

      const controller = new AbortController();
      abortRef.current = controller;

      // Stream in the background and resolve sendMessage immediately, so the
      // composer clears the input on submit instead of waiting for the whole
      // stream to finish (it awaits this promise before clearing).
      void (async () => {
       try {
        const res = await fetch(`${apiUrl}/v1/builder/chat`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, agentName, context, messages: history }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`Builder chat failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Parse SSE frames: blocks separated by \n\n, lines `event:`/`data:`.
        const handleFrame = (frame: string) => {
          let event = "message";
          const dataLines: string[] = [];
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length === 0) return;
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(dataLines.join("\n"));
          } catch {
            return;
          }

          if (event === "text") {
            const delta = String(payload.delta ?? "");
            if (!delta) return;
            patch(assistantId, (m) => {
              const segments = [...(m.segments ?? [])];
              const last = segments[segments.length - 1];
              if (last && last.type === "text") {
                segments[segments.length - 1] = {
                  type: "text",
                  content: last.content + delta,
                };
              } else {
                segments.push({ type: "text", content: delta });
              }
              return {
                ...m,
                content: contentToText(m.content) + delta,
                segments,
              };
            });
          } else if (event === "tool-call") {
            const ev: ToolCallEvent = {
              id: String(payload.toolCallId ?? uid()),
              name: String(payload.toolName ?? "tool"),
              arguments: (payload.args as Record<string, unknown>) ?? {},
              state: "calling",
            };
            patch(assistantId, (m) => ({
              ...m,
              toolCalls: [...(m.toolCalls ?? []), ev],
              segments: [...(m.segments ?? []), { type: "tool_call", toolCall: ev }],
            }));
          } else if (event === "tool-result") {
            const tcId = String(payload.toolCallId ?? "");
            const toolName = String(payload.toolName ?? "");
            const result =
              typeof payload.result === "string"
                ? payload.result
                : JSON.stringify(payload.result ?? null);
            patch(assistantId, (m) => ({
              ...m,
              toolCalls: (m.toolCalls ?? []).map((t) =>
                t.id === tcId ? { ...t, state: "completed", result } : t,
              ),
              segments: (m.segments ?? []).map((s) =>
                s.type === "tool_call" && s.toolCall.id === tcId
                  ? { ...s, toolCall: { ...s.toolCall, state: "completed", result } }
                  : s,
              ),
            }));
            if (isMutatingTool(toolName)) onMutation?.(toolName);
          } else if (event === "navigate") {
            const section = payload.section as NavigateTarget["section"];
            const name = (payload.name as string | null) ?? null;
            const tab = (payload.tab as string | null) ?? null;
            // Render it as a completed tool-call chip so the user sees the
            // agent navigated, then perform the navigation.
            const where = [section, name].filter(Boolean).join("/") + (tab ? ` · ${tab}` : "");
            const ev: ToolCallEvent = {
              id: String(payload.toolCallId ?? uid()),
              name: "navigate",
              arguments: { section, name, tab },
              result: `Opened ${where}`,
              state: "completed",
            };
            patch(assistantId, (m) => ({
              ...m,
              toolCalls: [...(m.toolCalls ?? []), ev],
              segments: [...(m.segments ?? []), { type: "tool_call", toolCall: ev }],
            }));
            onNavigate?.({ section, name, tab });
          } else if (event === "ask-user") {
            // Human-in-the-loop: the loop paused. Surface the questions via
            // pendingToolCall so the composer swaps to the ask-user panel.
            // Drop the in-flight assistant bubble if it never produced text.
            setMessages((prev) =>
              prev.filter(
                (m) =>
                  m.id !== assistantId ||
                  contentToText(m.content).length > 0 ||
                  (m.segments?.length ?? 0) > 0,
              ),
            );
            setPendingToolCall({
              toolCallId: uid(),
              toolName: "ask_user_question",
              arguments: { questions: (payload.questions as unknown[]) ?? [] },
            });
          } else if (event === "error") {
            throw new Error(String(payload.message ?? "stream error"));
          }
        };

        // Stream loop.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (frame.trim()) handleFrame(frame);
          }
        }
        setStatus("idle");
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setStatus("idle");
          return;
        }
        setError(err as Error);
        setStatus("error");
       } finally {
        abortRef.current = null;
       }
      })();
    },
    [apiUrl, projectId, agentName, context, messages, patch, onMutation, onNavigate],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStatus("idle");
  }, []);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setStatus("idle");
    setError(null);
    setPendingToolCall(null);
    if (persistKey && typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(persistKey);
      } catch {
        /* ignore */
      }
    }
  }, [persistKey]);

  return useMemo(
    () => ({
      messages,
      status,
      isStreaming: status === "streaming",
      error,
      sessionId: null,
      pendingToolCall,
      sendMessage,
      sendToolResult: async () => {},
      setSessionId: async () => {},
      newSession,
      abort,
    }),
    [messages, status, error, pendingToolCall, sendMessage, newSession, abort],
  );
}

/**
 * Builder composer — swaps between the normal input and the ask-user
 * panel when the meta-agent calls ask_user_question (same UX as the
 * playground). Answers go back as a `{ answers }` message, which the
 * server feeds to the next turn.
 */
function BuilderComposer() {
  const { pendingToolCall, sendMessage } = useChatContext();

  if (pendingToolCall?.toolName === "ask_user_question") {
    const questions = (pendingToolCall.arguments?.questions ?? []) as AskUserQuestion[];
    return (
      <ChatAskUser
        variant="command"
        questions={questions}
        onSubmit={(answers) => void sendMessage(JSON.stringify({ answers }))}
      />
    );
  }

  return <ChatInput placeholder="Tell the builder what to change…" />;
}

export function BuilderChat({
  projectId,
  apiUrl,
  agentName,
  context,
  onMutation,
  onNavigate,
  persistKey,
}: {
  projectId: string;
  apiUrl: string;
  agentName?: string;
  context?: BuilderContext;
  onMutation?: (tool: string) => void;
  onNavigate?: (target: NavigateTarget) => void;
  persistKey?: string;
}) {
  const adapter = useBuilderChatAdapter({
    projectId,
    apiUrl,
    agentName,
    context,
    onMutation,
    onNavigate,
    persistKey,
  });
  return (
    <ChatShell adapter={adapter}>
      <BuilderComposer />
    </ChatShell>
  );
}
