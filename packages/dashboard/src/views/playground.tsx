"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ArrowUp, ChatCircleText, Plus, Stop } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import { useAgents, useChat } from "@polpo-ai/react";
import type { ChatMessage, ContentPart } from "@polpo-ai/sdk";
import { Button, IconButton, PageHeader } from "../components.js";

function messageText(content: string | ContentPart[]) {
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text : `[${part.type}]`).join("\n");
}

export function PlaygroundView({ initialAgent }: { initialAgent?: string }) {
  const { agents, isLoading } = useAgents();
  const [agent, setAgent] = useState(initialAgent ?? "");
  useEffect(() => {
    if (!agent && agents[0]) setAgent(agents[0].name);
  }, [agent, agents]);
  const chat = useChat({ agent: agent || undefined });
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [chat.messages]);
  const selected = useMemo(() => agents.find((item) => item.name === agent), [agents, agent]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("message") as HTMLTextAreaElement;
    const value = input.value.trim();
    if (!value || chat.isStreaming || !agent) return;
    input.value = "";
    await chat.sendMessage(value);
  }

  return (
    <div className="pd-playground">
      <PageHeader title="Playground" description="Call an agent through the same API your application uses." actions={<Button variant="secondary" onClick={chat.newSession}><Plus size={15} />New chat</Button>} />
      <div className="pd-playground-toolbar">
        <label><span>Agent</span><select value={agent} disabled={isLoading} onChange={(event) => { setAgent(event.target.value); chat.newSession(); }}>{agents.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
        {selected?.model ? <code>{selected.model}</code> : null}
      </div>
      <div className="pd-chat-frame">
        <div className="pd-messages">
          {chat.messages.length === 0 ? <div className="pd-chat-empty"><ChatCircleText size={30} weight="duotone" /><strong>{agent ? `Talk to ${agent}` : "Create an agent first"}</strong><span>Messages stream from your local Polpo runtime.</span></div> : null}
          {chat.messages.map((message: ChatMessage) => <MessageBubble key={message.id} message={message} />)}
          {chat.error ? <div className="pd-error">{chat.error.message}</div> : null}
          <div ref={bottomRef} />
        </div>
        <form className="pd-composer" onSubmit={(event) => void submit(event)}>
          <textarea name="message" rows={2} placeholder={agent ? `Message ${agent}...` : "Create an agent first"} disabled={!agent} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          {chat.isStreaming ? <IconButton label="Stop response" type="button" onClick={chat.abort}><Stop size={15} weight="fill" /></IconButton> : <IconButton label="Send message" type="submit" disabled={!agent}><ArrowUp size={16} weight="bold" /></IconButton>}
        </form>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const text = messageText(message.content);
  return (
    <article className="pd-message" data-role={message.role}>
      <div className="pd-message-role">{message.role === "assistant" ? "Agent" : "You"}</div>
      <div className="pd-markdown"><ReactMarkdown>{text || (message.role === "assistant" ? "Thinking..." : "")}</ReactMarkdown></div>
      {message.segments?.filter((segment) => segment.type === "tool_call").map((segment) => segment.type === "tool_call" ? <div className="pd-tool-call" key={segment.toolCall.id}><span>{segment.toolCall.name}</span><code>{segment.toolCall.state}</code></div> : null)}
    </article>
  );
}
