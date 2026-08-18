import { useCallback, useEffect, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatCompletionMessage,
  ContentPart,
  AskUserPayload,
  MissionPreviewPayload,
  VaultPreviewPayload,
  OpenFilePayload,
  NavigateToPayload,
  OpenTabPayload,
  ToolCallEvent,
  MessageSegment,
  ChatSuggestion,
  RuntimeSandboxOptions,
} from "@polpo-ai/sdk";
import { ChatCompletionStream } from "@polpo-ai/sdk";

// ── Types ────────────────────────────────────────────────

export interface UseChatOptions {
  /** Target a specific agent for direct conversation. Omit for orchestrator mode. */
  agent?: string;
  /** Target a project-level loop assigned to the selected agent. */
  loop?: string;
  /** Optional per-request model override for the selected agent. */
  model?: string;
  /** Optional runtime sandbox policy for chat requests. */
  sandbox?: RuntimeSandboxOptions;
  /** Keep execution alive and resume automatically when its SSE connection drops. */
  durable?: boolean;
  /** Resume an existing session by ID. If omitted, the server auto-creates or reuses one (30-min window). */
  sessionId?: string;
  /** Called on each streaming text chunk. */
  onChunk?: (chunk: ChatCompletionChunk) => void;
  /** Called when the stream completes. */
  onFinish?: (text: string) => void;
  /** Called on error. */
  onError?: (error: Error) => void;
  /** Called after each stream update — useful for scroll-to-bottom. */
  onUpdate?: () => void;
  /** Called when a new session is created (first message in a new chat). */
  onSessionCreated?: (sessionId: string) => void;
  /** Called when the agent asks clarifying questions (legacy orchestrator mode). */
  onAskUser?: (payload: AskUserPayload) => void;
  /** Called when suggested next messages are available. */
  onSuggestions?: (suggestions: ChatSuggestion[]) => void;
  /** Called when the agent proposes a mission for review. */
  onMissionPreview?: (payload: MissionPreviewPayload) => void;
  /** Called when the agent proposes a vault entry. */
  onVaultPreview?: (payload: VaultPreviewPayload) => void;
  /** Called when the agent wants to open a file. */
  onOpenFile?: (payload: OpenFilePayload) => void;
  /** Called when the agent wants to navigate the UI. */
  onNavigateTo?: (payload: NavigateToPayload) => void;
  /** Called when the agent wants to open a URL. */
  onOpenTab?: (payload: OpenTabPayload) => void;
  /** Called when a tool call event is emitted. */
  onToolCall?: (toolCall: ToolCallEvent) => void;
}

export type ChatStatus = "idle" | "streaming" | "reconnecting" | "loading" | "error";

export interface SendMessageOptions {
  /** Assigned skills to apply explicitly to this message. Additive, not restrictive. */
  skills?: string[];
}

/** A pending client-side tool call that needs a result from the client. */
export interface PendingToolCall {
  /** Tool call ID from the LLM. */
  toolCallId: string;
  /** Tool name (e.g. "ask_user_question"). */
  toolName: string;
  /** Parsed arguments from the LLM. */
  arguments: Record<string, unknown>;
}

export interface UseChatReturn {
  /**
   * All messages in the current session (user + assistant).
   * During streaming, the last assistant message updates in-place with accumulating
   * content and tool calls — no separate `streamingText` needed.
   */
  messages: ChatMessage[];
  /** Send a message (text or multimodal content parts). Streams the response automatically. */
  sendMessage: (
    content: string | ContentPart[],
    options?: SendMessageOptions,
  ) => Promise<void>;
  /** Send a tool result back to the server. Used for client-side tools (e.g. ask_user_question). */
  sendToolResult: (toolCallId: string, toolName: string, result: string) => Promise<void>;
  /** Current session ID. `null` until the first response from the server. */
  sessionId: string | null;
  /** Set the session ID manually (e.g. to resume a different session). Loads its messages. */
  setSessionId: (id: string | null) => Promise<void>;
  /** Start a new session. Clears messages and session ID. */
  newSession: () => void;
  /** Current status. */
  status: ChatStatus;
  /** Last error, if any. */
  error: Error | null;
  /** Whether a response is currently streaming. */
  isStreaming: boolean;
  /** Client-side tool call awaiting a result (e.g. ask_user_question). null when none pending. */
  pendingToolCall: PendingToolCall | null;
  /** Suggested next messages for the latest assistant response. */
  suggestions: ChatSuggestion[];
  /** Active durable run identifier, once accepted by the server. */
  runId: string | null;
  /** Last fully processed durable stream cursor. */
  lastEventId: string | null;
  /** Explicitly cancel the active run. */
  abort: () => void;
  /** Close this subscriber while allowing a durable run to continue. */
  detach: () => void;
  /** Explicitly cancel the active run and wait for acknowledgement. */
  cancel: (reason?: string) => Promise<void>;
}

function activeSuggestionsFromHistory(messages: ChatMessage[]): ChatSuggestion[] {
  const latestMessage = messages.at(-1);
  if (latestMessage?.role !== "assistant") return [];
  return latestMessage.suggestions ?? [];
}

// ── Hook ─────────────────────────────────────────────────

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { client, store } = usePolpoContext();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionIdState] = useState<string | null>(options.sessionId ?? null);
  const [status, setStatus] = useState<ChatStatus>(options.sessionId ? "loading" : "idle");
  const [error, setError] = useState<Error | null>(null);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const [suggestions, setSuggestions] = useState<ChatSuggestion[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [lastEventId, setLastEventId] = useState<string | null>(null);

  const streamRef = useRef<ChatCompletionStream | null>(null);
  const isStreamingRef = useRef(false);
  const sessionIdRef = useRef<string | null>(options.sessionId ?? null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const applySessionMessages = useCallback((nextMessages: ChatMessage[]) => {
    const activeSuggestions = activeSuggestionsFromHistory(nextMessages);
    setMessages(nextMessages);
    setSuggestions(activeSuggestions);
    if (activeSuggestions.length > 0) {
      optionsRef.current.onSuggestions?.(activeSuggestions);
    }
  }, []);

  // ── Auto-load session messages on mount ──
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!options.sessionId || loadedRef.current) return;
    loadedRef.current = true;
    client.getSessionMessages(options.sessionId)
      .then((data) => {
        applySessionMessages(data.messages);
        setStatus("idle");
        requestAnimationFrame(() => optionsRef.current.onUpdate?.());
      })
      .catch(() => {
        applySessionMessages([]);
        setStatus("idle");
      });
  }, [options.sessionId, client, applySessionMessages]);

  // ── Set session ID (manual) ──
  const setSessionId = useCallback(
    async (id: string | null) => {
      setSessionIdState(id);
      sessionIdRef.current = id;
      if (id) {
        setStatus("loading");
        try {
          const data = await client.getSessionMessages(id);
          applySessionMessages(data.messages);
        } catch {
          applySessionMessages([]);
        }
        setStatus("idle");
        requestAnimationFrame(() => optionsRef.current.onUpdate?.());
      } else {
        applySessionMessages([]);
        setStatus("idle");
      }
      setError(null);
      setPendingToolCall(null);
    },
    [client, applySessionMessages],
  );

  const newSession = useCallback(() => {
    streamRef.current?.abort();
    setSessionIdState(null);
    sessionIdRef.current = null;
    setMessages([]);
    setStatus("idle");
    setError(null);
    setPendingToolCall(null);
    setSuggestions([]);
    isStreamingRef.current = false;
  }, []);

  const abort = useCallback(() => {
    streamRef.current?.abort();
  }, []);

  const detach = useCallback(() => {
    streamRef.current?.detach();
    isStreamingRef.current = false;
    setStatus("idle");
  }, []);

  const cancel = useCallback(async (reason?: string) => {
    await streamRef.current?.cancel(reason);
    isStreamingRef.current = false;
    setStatus("idle");
  }, []);

  useEffect(() => () => {
    const stream = streamRef.current;
    if (!stream) return;
    if (optionsRef.current.durable) stream.detach();
    else stream.abort();
  }, []);

  // ── Shared streaming logic ──
  const streamResponse = useCallback(
    async (
      historyMessages: ChatCompletionMessage[],
      requestOptions: SendMessageOptions = {},
    ) => {
      const stream = client.chatCompletionsStream({
        messages: historyMessages,
        sessionId: sessionIdRef.current ?? undefined,
        agent: optionsRef.current.agent,
        loop: optionsRef.current.loop,
        model: optionsRef.current.model,
        sandbox: optionsRef.current.sandbox,
        polpo: {
          ...(requestOptions.skills?.length
            ? { skills: [...requestOptions.skills] }
            : {}),
          capabilities: {
            ask_user_question: true,
            suggestions: true,
          },
          ...(optionsRef.current.durable
            ? { delivery: { onDisconnect: "continue" as const } }
            : {}),
        },
      });
      streamRef.current = stream;

      // Add empty assistant message that will be updated in-place
      const assistantId = `msg-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", ts: new Date().toISOString() },
      ]);

      let fullText = "";
      const toolCalls = new Map<string, ToolCallEvent>();
      const segments: MessageSegment[] = [];

      for await (const chunk of stream) {
        setRunId(stream.runId);
        setLastEventId(stream.lastEventId);
        // Capture session ID
        if (stream.sessionId && !sessionIdRef.current) {
          sessionIdRef.current = stream.sessionId;
          setSessionIdState(stream.sessionId);
          // Push the new session into the shared store so any other consumer
          // of `useSessions()` (sidebar, switcher, etc.) sees it without a
          // manual refetch — fixes #41. We don't have the server's authoritative
          // ChatSession object here, but a minimal optimistic record is enough
          // to render in the list; a `refetch()` will reconcile titles/counts
          // on next mount.
          if (!store.getSnapshot().sessions.has(stream.sessionId)) {
            const now = new Date().toISOString();
            store.upsertSession({
              id: stream.sessionId,
              createdAt: now,
              updatedAt: now,
              messageCount: 1,
              agent: optionsRef.current.agent,
            });
          }
          optionsRef.current.onSessionCreated?.(stream.sessionId);
        }

        if (chunk.polpo?.suggestions) {
          const nextSuggestions = chunk.polpo.suggestions;
          setSuggestions(nextSuggestions);
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.id !== assistantId) return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, suggestions: nextSuggestions },
            ];
          });
          optionsRef.current.onSuggestions?.(nextSuggestions);
          optionsRef.current.onUpdate?.();
        }

        const choice = chunk.choices[0];
        if (!choice) continue;
        let updated = false;

        // Text content — append to last text segment or create new one
        if (choice.delta.content) {
          fullText += choice.delta.content;
          const lastSeg = segments[segments.length - 1];
          if (lastSeg?.type === "text") {
            lastSeg.content += choice.delta.content;
          } else {
            segments.push({ type: "text", content: choice.delta.content });
          }
          updated = true;
        }

        // Tool call events (server-side tool execution). Merge across the
        // lifecycle (preparing → calling → completed) instead of replacing:
        // each event carries only the fields relevant to its state
        // (argumentsText while streaming, arguments at "calling", result at
        // "completed"), so a plain overwrite would drop the input once the
        // result arrives. Merging keeps the full picture as the call evolves.
        if (choice.tool_call) {
          const incoming = choice.tool_call;
          const prev = toolCalls.get(incoming.id);
          const merged: ToolCallEvent = prev
            ? { ...prev, ...incoming, state: incoming.state }
            : incoming;
          toolCalls.set(merged.id, merged);
          // Update existing segment or add new one
          const existing = segments.find(
            (s) => s.type === "tool_call" && s.toolCall.id === merged.id,
          );
          if (existing && existing.type === "tool_call") {
            existing.toolCall = merged;
          } else {
            segments.push({ type: "tool_call", toolCall: merged });
          }
          updated = true;
          optionsRef.current.onToolCall?.(merged);
        }

        // Update assistant message in-place
        if (updated) {
          const content = fullText;
          const tc = toolCalls.size > 0 ? Array.from(toolCalls.values()) : undefined;
          const segs = segments.length > 0 ? [...segments] : undefined;
          setMessages((prev) => [
            ...prev.slice(0, -1),
            { id: assistantId, role: "assistant", content, ts: new Date().toISOString(), toolCalls: tc, segments: segs },
          ]);
          optionsRef.current.onUpdate?.();
        }

        // Client-side tool calls (finish_reason: "tool_calls")
        if (choice.finish_reason === "tool_calls" && choice.delta.tool_calls?.length) {
          const tc = choice.delta.tool_calls[0];
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
          setPendingToolCall({
            toolCallId: tc.id,
            toolName: tc.function.name,
            arguments: args,
          });
        }

        // Legacy special finish reasons
        if (choice.finish_reason === "ask_user" && choice.ask_user) optionsRef.current.onAskUser?.(choice.ask_user);
        if (choice.finish_reason === "mission_preview" && choice.mission_preview) optionsRef.current.onMissionPreview?.(choice.mission_preview);
        if (choice.finish_reason === "vault_preview" && choice.vault_preview) optionsRef.current.onVaultPreview?.(choice.vault_preview);
        if (choice.finish_reason === "open_file" && choice.open_file) optionsRef.current.onOpenFile?.(choice.open_file);
        if (choice.finish_reason === "navigate_to" && choice.navigate_to) optionsRef.current.onNavigateTo?.(choice.navigate_to);
        if (choice.finish_reason === "open_tab" && choice.open_tab) optionsRef.current.onOpenTab?.(choice.open_tab);

        optionsRef.current.onChunk?.(chunk);
      }

      streamRef.current = null;
      setRunId(stream.runId);
      setLastEventId(stream.lastEventId);
      isStreamingRef.current = false;
      setStatus("idle");
      optionsRef.current.onFinish?.(fullText);
    },
    [client],
  );

  // ── Send message ──
  const sendMessage = useCallback(
    async (
      content: string | ContentPart[],
      requestOptions: SendMessageOptions = {},
    ) => {
      if (isStreamingRef.current) return;

      // Optimistic: add user message immediately
      const userMsg: ChatMessage = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content,
        ts: new Date().toISOString(),
      };

      const allMessages = [...messagesRef.current, userMsg];
      setMessages(allMessages);

      setStatus("streaming");
      isStreamingRef.current = true;
      setError(null);
      setPendingToolCall(null);
      setSuggestions([]);

      try {
        const historyMessages: ChatCompletionMessage[] = allMessages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

        await streamResponse(historyMessages, requestOptions);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") {
          // Keep partial message as-is
          isStreamingRef.current = false;
          setStatus("idle");
          return;
        }
        setError(err as Error);
        setStatus("error");
        isStreamingRef.current = false;
        // Remove the empty assistant message on error
        setMessages((prev) => prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev);
        optionsRef.current.onError?.(err as Error);
      }
    },
    [streamResponse],
  );

  // ── Send tool result ──
  const sendToolResult = useCallback(
    async (toolCallId: string, toolName: string, result: string) => {
      setPendingToolCall(null);
      setSuggestions([]);
      setStatus("streaming");
      isStreamingRef.current = true;
      setError(null);

      try {
        // Build history — include tool_calls on the assistant message that triggered the client-side tool
        const historyMessages: ChatCompletionMessage[] = messagesRef.current.map((m) => {
          const msg: ChatCompletionMessage = {
            role: m.role as "user" | "assistant",
            content: m.content,
          };
          // If this assistant message has toolCalls that match the pending tool, include them
          if (m.role === "assistant" && m.toolCalls) {
            const clientToolCall = m.toolCalls.find(
              (tc) => tc.id === toolCallId || tc.name === toolName,
            );
            if (clientToolCall) {
              msg.tool_calls = [{
                id: clientToolCall.id,
                type: "function",
                function: {
                  name: clientToolCall.name,
                  arguments: JSON.stringify(clientToolCall.arguments ?? {}),
                },
              }];
            }
          }
          return msg;
        });

        // Add tool result message
        historyMessages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCallId,
          name: toolName,
        });

        await streamResponse(historyMessages);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") {
          isStreamingRef.current = false;
          setStatus("idle");
          return;
        }
        setError(err as Error);
        setStatus("error");
        isStreamingRef.current = false;
        optionsRef.current.onError?.(err as Error);
      }
    },
    [streamResponse],
  );

  return {
    messages,
    sendMessage,
    sendToolResult,
    sessionId,
    setSessionId,
    newSession,
    status,
    error,
    isStreaming: status === "streaming",
    pendingToolCall,
    suggestions,
    runId,
    lastEventId,
    abort,
    detach,
    cancel,
  };
}
