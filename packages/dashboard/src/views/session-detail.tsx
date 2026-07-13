"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft } from "@phosphor-icons/react";
import { useSessions } from "@polpo-ai/react";
import type { ChatMessage, ContentPart } from "@polpo-ai/sdk";
import { Button, LoadingRows, PageHeader } from "../components.js";
import { useDashboardHost } from "../host.js";

function contentText(content: string | ContentPart[]) { return typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n"); }

export function SessionDetailView({ sessionId }: { sessionId: string }) {
  const host = useDashboardHost();
  const { sessions, getMessages } = useSessions();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const session = sessions.find((item) => item.id === sessionId);
  useEffect(() => { let live = true; setLoading(true); getMessages(sessionId).then((data) => { if (live) setMessages(data); }).catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Could not load session"); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [getMessages, sessionId]);
  return <div className="pd-view-stack"><PageHeader title={session?.title || "Session"} description={session?.agent || sessionId} actions={<Button variant="secondary" onClick={() => host.navigate("/sessions")}><ArrowLeft size={15} />Sessions</Button>} />{error ? <div className="pd-error">{error}</div> : null}{loading ? <LoadingRows /> : <div className="pd-transcript">{messages.map((message) => <article key={message.id} data-role={message.role}><header>{message.role}</header><div className="pd-markdown"><ReactMarkdown>{contentText(message.content)}</ReactMarkdown></div></article>)}</div>}</div>;
}
