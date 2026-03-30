import { useCallback, useRef, useState } from "react";
import { usePolpoContext } from "../provider/polpo-context.js";
import type {
  ChatMessage,
  ChatCompletionChunk,
  ChatCompletionMessage,
  AskUserPayload,
  MissionPreviewPayload,
  VaultPreviewPayload,
  OpenFilePayload,
  NavigateToPayload,
  OpenTabPayload,
  ToolCallEvent,
} from "@polpo-ai/sdk";
import { ChatCompletionStream } from "@polpo-ai/sdk";

// ── Types ────────────────────────────────────────────────

export interface UseChatOptions {
  /** Target a specific agent for direct conversation. Omit for orchestrator mode. */
  agent?: string;
  /** Resume an existing session by ID. If omitted, the server auto-creates or reuses one (30-min window). */
  sessionId?: string;
  /** Called on each streaming text chunk. */
  onChunk?: (chunk: ChatCompletionChunk) => void;
  /** Called when the stream completes. */
  onFinish?: (text: string) => void;
  /** Called on error. */
  onError?: (error: Error) => void;
  /** Called when the agent asks clarifying questions. */
  onAskUser?: (payload: AskUserPayload) => void;
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

export type ChatStatus = "idle" | "streaming" | "error";

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
  /** All messages in the current session (user + assistant). */
  messages: ChatMessage[];
  /** Send a message (text or multimodal content parts). Streams the response automatically. */
  sendMessage: (content: string | import("@polpo-ai/sdk").ContentPart[]) => Promise<void>;
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
  /** The text being streamed for the current assistant response. */
  streamingText: string;
  /** Active tool calls during the current response. */
  activeToolCalls: ToolCallEvent[];
  /** Client-side tool call awaiting a result (e.g. ask_user_question). null when none pending. */
  pendingToolCall: PendingToolCall | null;
  /** Abort the current streaming response. */
  abort: () => void;
}

// ── Hook ─────────────────────────────────────────────────

export function useChat(options: UseChatOptions = {}): UseChatReturn {
  const { client } = usePolpoContext();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionIdState] = useState<string | null>(options.sessionId ?? null);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallEvent[]>([]);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);

  const streamRef = useRef<ChatCompletionStream | null>(null);
  const sessionIdRef = useRef<string | null>(options.sessionId ?? null);
  /** Track the last assistant message content for tool call context. */
  const lastAssistantTextRef = useRef<string>("");

  const setSessionId = useCallback(
    async (id: string | null) => {
      setSessionIdState(id);
      sessionIdRef.current = id;
      if (id) {
        try {
          const data = await client.getSessionMessages(id);
          setMessages(data.messages);
        } catch {
          setMessages([]);
        }
      } else {
        setMessages([]);
      }
      setStatus("idle");
      setError(null);
      setStreamingText("");
      setActiveToolCalls([]);
    },
    [client],
  );

  const newSession = useCallback(() => {
    streamRef.current?.abort();
    setSessionIdState(null);
    sessionIdRef.current = null;
    setMessages([]);
    setStatus("idle");
    setError(null);
    setStreamingText("");
    setActiveToolCalls([]);
  }, []);

  const abort = useCallback(() => {
    streamRef.current?.abort();
  }, []);

  const sendMessage = useCallback(
    async (content: string | import("@polpo-ai/sdk").ContentPart[]) => {
      const userText = typeof content === "string" ? content : content.filter(p => p.type === "text").map(p => (p as any).text).join(" ");

      // Optimistic: add user message immediately
      const userMsg: ChatMessage = {
        id: `tmp-${Date.now()}`,
        role: "user",
        content: userText,
        ts: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStatus("streaming");
      setError(null);
      setStreamingText("");
      setActiveToolCalls([]);

      try {
        // Build messages array: full history + new message
        const historyMessages: ChatCompletionMessage[] = messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));
        historyMessages.push({
          role: "user",
          content: typeof content === "string" ? content : content,
        });

        const stream = client.chatCompletionsStream({
          messages: historyMessages,
          sessionId: sessionIdRef.current ?? undefined,
          agent: options.agent,
        });
        streamRef.current = stream;

        let fullText = "";

        for await (const chunk of stream) {
          // Capture session ID from the stream (set after first chunk)
          if (stream.sessionId && !sessionIdRef.current) {
            sessionIdRef.current = stream.sessionId;
            setSessionIdState(stream.sessionId);
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          // Text content
          if (choice.delta.content) {
            fullText += choice.delta.content;
            setStreamingText(fullText);
          }

          // Tool calls
          if (choice.tool_call) {
            setActiveToolCalls((prev) => {
              const idx = prev.findIndex((tc) => tc.id === choice.tool_call!.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = choice.tool_call!;
                return next;
              }
              return [...prev, choice.tool_call!];
            });
            options.onToolCall?.(choice.tool_call);
          }

          // Standard client-side tool calls (finish_reason: "tool_calls")
          if (choice.finish_reason === "tool_calls" && choice.delta.tool_calls?.length) {
            const tc = choice.delta.tool_calls[0];
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
            setPendingToolCall({
              toolCallId: tc.id,
              toolName: tc.function.name,
              arguments: args,
            });
            lastAssistantTextRef.current = fullText;
          }

          // Legacy special finish reasons (orchestrator mode)
          if (choice.finish_reason === "ask_user" && choice.ask_user) {
            options.onAskUser?.(choice.ask_user);
          }
          if (choice.finish_reason === "mission_preview" && choice.mission_preview) {
            options.onMissionPreview?.(choice.mission_preview);
          }
          if (choice.finish_reason === "vault_preview" && choice.vault_preview) {
            options.onVaultPreview?.(choice.vault_preview);
          }
          if (choice.finish_reason === "open_file" && choice.open_file) {
            options.onOpenFile?.(choice.open_file);
          }
          if (choice.finish_reason === "navigate_to" && choice.navigate_to) {
            options.onNavigateTo?.(choice.navigate_to);
          }
          if (choice.finish_reason === "open_tab" && choice.open_tab) {
            options.onOpenTab?.(choice.open_tab);
          }

          options.onChunk?.(chunk);
        }

        // Stream finished — add assistant message
        if (fullText) {
          const assistantMsg: ChatMessage = {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: fullText,
            ts: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMsg]);
        }

        setStreamingText("");
        setActiveToolCalls([]);
        setStatus("idle");
        streamRef.current = null;
        options.onFinish?.(fullText);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") {
          // User aborted — keep partial text as message if any
          const partial = streamingText;
          if (partial) {
            setMessages((prev) => [
              ...prev,
              { id: `msg-${Date.now()}`, role: "assistant", content: partial, ts: new Date().toISOString() },
            ]);
          }
          setStreamingText("");
          setActiveToolCalls([]);
          setStatus("idle");
          return;
        }
        setError(err as Error);
        setStatus("error");
        options.onError?.(err as Error);
      }
    },
    [client, messages, options, streamingText],
  );

  const sendToolResult = useCallback(
    async (toolCallId: string, toolName: string, result: string) => {
      setPendingToolCall(null);
      setStatus("streaming");
      setError(null);
      setStreamingText("");
      setActiveToolCalls([]);

      try {
        // Build messages: full history + assistant message with tool_calls + tool result
        const historyMessages: ChatCompletionMessage[] = messages.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

        // Add the assistant message that triggered the tool call (with tool_calls field)
        if (lastAssistantTextRef.current) {
          historyMessages.push({
            role: "assistant",
            content: lastAssistantTextRef.current,
          });
        }

        // Add the tool result
        historyMessages.push({
          role: "tool" as any,
          content: result,
          tool_call_id: toolCallId,
          name: toolName,
        } as any);

        const stream = client.chatCompletionsStream({
          messages: historyMessages,
          sessionId: sessionIdRef.current ?? undefined,
          agent: options.agent,
        });
        streamRef.current = stream;

        let fullText = "";

        for await (const chunk of stream) {
          if (stream.sessionId && !sessionIdRef.current) {
            sessionIdRef.current = stream.sessionId;
            setSessionIdState(stream.sessionId);
          }

          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.delta.content) {
            fullText += choice.delta.content;
            setStreamingText(fullText);
          }

          if (choice.tool_call) {
            setActiveToolCalls((prev) => {
              const idx = prev.findIndex((tc) => tc.id === choice.tool_call!.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = choice.tool_call!;
                return next;
              }
              return [...prev, choice.tool_call!];
            });
            options.onToolCall?.(choice.tool_call);
          }

          // Handle another client-side tool call in the resumed stream
          if (choice.finish_reason === "tool_calls" && choice.delta.tool_calls?.length) {
            const tc = choice.delta.tool_calls[0];
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
            setPendingToolCall({
              toolCallId: tc.id,
              toolName: tc.function.name,
              arguments: args,
            });
            lastAssistantTextRef.current = fullText;
          }

          options.onChunk?.(chunk);
        }

        if (fullText) {
          setMessages((prev) => [
            ...prev,
            { id: `msg-${Date.now()}`, role: "assistant", content: fullText, ts: new Date().toISOString() },
          ]);
        }

        setStreamingText("");
        setActiveToolCalls([]);
        setStatus("idle");
        streamRef.current = null;
        options.onFinish?.(fullText);
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") {
          setStreamingText("");
          setActiveToolCalls([]);
          setStatus("idle");
          return;
        }
        setError(err as Error);
        setStatus("error");
        options.onError?.(err as Error);
      }
    },
    [client, messages, options],
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
    streamingText,
    activeToolCalls,
    pendingToolCall,
    abort,
  };
}
