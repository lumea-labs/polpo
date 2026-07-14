"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "@lobehub/icons";
import { ChatAgentSelector, ChatLanding } from "@lumea-labs/chat";
import { useAgents, useSessions } from "@polpo-ai/react";
import { Link } from "../host.js";
import { FilesBrowser } from "../files/files-browser.js";
import { RefreshButton } from "../ui/refresh-button.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../ui/select.js";
import { PlaygroundView } from "../views/playground.js";
import type { PlaygroundHostAdapter } from "./host.js";
import { SelfHostPolpoChat } from "./self-host-chat.js";
import { useSelfHostSessionsAdapter } from "../sessions/self-host.js";

function HostImage({ priority: _priority, ...props }: { src: string; alt: string; width: number; height: number; priority?: boolean; className?: string }) {
  return <img {...props} />;
}

function useTrace({ sessionId, active }: { projectId: string; sessionId: string | undefined; active: boolean }) {
  const sessions = useSessions();
  const [messages, setMessages] = useState<unknown[]>([]);
  const [isLoading, setLoading] = useState(false);
  const [isFetching, setFetching] = useState(false);
  const refetch = useCallback(async () => {
    if (!sessionId) { setMessages([]); return; }
    setFetching(true);
    if (messages.length === 0) setLoading(true);
    try { setMessages(await sessions.getMessages(sessionId)); }
    finally { setLoading(false); setFetching(false); }
  }, [messages.length, sessionId, sessions.getMessages]);
  useEffect(() => { void refetch(); }, [sessionId]);
  useEffect(() => {
    if (!active || !sessionId) return;
    const timer = window.setInterval(() => void refetch(), 800);
    return () => window.clearInterval(timer);
  }, [active, refetch, sessionId]);
  return { messages, isLoading, isFetching, refetch };
}

function useSelfHostPlaygroundAdapter(): PlaygroundHostAdapter {
  const sessions = useSelfHostSessionsAdapter();
  return useMemo(() => ({
    sessions,
    showAvatars: false,
    logoSrc: "/polpo-logo.svg",
    data: { dataPlaneBaseUrl: () => "", useTrace },
    navigation: {
      searchEntries: () => new URLSearchParams(window.location.search).entries(),
      replace: (path: string) => window.history.replaceState(null, "", path),
    },
    routes: {
      projects: () => "/agents",
      agents: () => "/agents",
      agent: (_projectId: string, agentName: string) => `/agents/${encodeURIComponent(agentName)}`,
    },
    components: {
      Link,
      Image: HostImage,
      ProviderIcon,
      ChatAgentSelector,
      ChatLanding,
      PolpoChat: SelfHostPolpoChat,
      Select: Select as PlaygroundHostAdapter["components"]["Select"],
      SelectTrigger: SelectTrigger as PlaygroundHostAdapter["components"]["SelectTrigger"],
      SelectContent: SelectContent as PlaygroundHostAdapter["components"]["SelectContent"],
      SelectItem: SelectItem as PlaygroundHostAdapter["components"]["SelectItem"],
      FilesBrowser,
      RefreshButton,
    },
  }), [sessions]);
}

export function SelfHostPlaygroundView() {
  const { agents, isLoading } = useAgents();
  const host = useSelfHostPlaygroundAdapter();
  if (isLoading && agents.length === 0) {
    return <div className="v2 flex h-screen items-center justify-center bg-background"><div className="h-5 w-32 animate-pulse rounded bg-muted" /></div>;
  }
  return <div className="v2 flex h-screen flex-col overflow-hidden bg-background text-foreground"><PlaygroundView projectId="local" projectName="Local runtime" initialAgents={agents} host={host} /></div>;
}
