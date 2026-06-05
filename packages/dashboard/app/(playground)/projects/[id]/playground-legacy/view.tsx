"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { PolpoProvider } from "@polpo-ai/react";
import { Chat } from "@polpo-ai/chat";
import type { AgentConfig } from "@polpo-ai/core";
import { ArrowLeft, Plus } from "lucide-react";
import { AgentModelSelector } from "../../../../../components/dashboard/agent-model-selector";

interface Props {
  projectId: string;
  apiUrl: string;
  projectName: string;
  initialAgents: AgentConfig[];
}

/**
 * Standalone playground surface — rendered inside `(playground)/layout.tsx`,
 * which strips the project sidebar and dashboard chrome. Opened in a new
 * browser tab so the user clearly sees this is an isolated chat sandbox,
 * not an embedded panel inside the project.
 */
export default function PlaygroundView({
  projectId,
  apiUrl,
  projectName,
  initialAgents,
}: Props) {
  const baseUrl = `${apiUrl}/v1/projects/${projectId}/data`;


  const [selectedAgent, setSelectedAgent] = useState<string | undefined>(
    initialAgents[0]?.name,
  );

  // Resume an existing chat across reloads + make the URL shareable.
  // The Chat component creates a fresh session when `sessionId` is
  // omitted, so without this the playground silently leaked a new
  // session every refresh. `router.replace` (no `push`) is intentional:
  // the back button shouldn't accumulate one entry per stream chunk.
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionParam = searchParams.get("session") ?? undefined;

  // Capture sessionParam only at the initial render. After that we
  // never re-pass a new sessionId prop to <Chat>, because:
  //   1. useChat already keeps the session alive internally — its
  //      sessionIdRef gets set from the response x-session-id during
  //      the first stream (line 92 of use-chat.js). The second
  //      sendMessage call reads that ref and sends the right header.
  //   2. Re-passing sessionId to <Chat> would change its prop, which
  //      triggers useChat's effect at line 22 to call
  //      client.getSessionMessages(id) → setMessages(server's view),
  //      causing a visible skeleton flash right after onFinish.
  //
  // Refresh / share-link works because on a fresh page mount this ref
  // captures whatever ?session= is in the URL at that moment.
  const initialSessionIdRef = useRef<string | undefined>(sessionParam);

  // Park the new id mid-stream, commit it to the URL on onFinish. We
  // never put it back into a React prop or state — only the URL — so
  // <Chat> doesn't see anything change.
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

  // cookieFetch stays minimal — we don't read x-session-id here anymore
  // since the SDK already exposes it via Chat's onSessionCreated. Empty
  // deps keep the fetch identity stable so PolpoProvider doesn't
  // rebuild the client on every render.
  const cookieFetch = useMemo<typeof globalThis.fetch>(
    () =>
      ((input, init) =>
        globalThis.fetch(input, {
          ...init,
          credentials: "include",
        })) as typeof globalThis.fetch,
    [],
  );

  // Switching agent unmounts the Chat (via `key`) — keeping the old
  // session id in the URL would resume the wrong agent's history.
  // Clear the param when the user picks a different agent so a fresh
  // session is created on the next message. We also reset the
  // initial-session ref so the re-mounted Chat starts fresh.
  const handleSelectAgent = useCallback(
    (name: string) => {
      setSelectedAgent(name);
      initialSessionIdRef.current = undefined;
      pendingSessionIdRef.current = null;
      if (searchParams.get("session")) {
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        params.delete("session");
        const qs = params.toString();
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      }
    },
    [router, searchParams],
  );

  return (
    <>
      <TopBar
        projectId={projectId}
        projectName={projectName}
        agents={initialAgents}
        selectedAgent={selectedAgent}
        onSelectAgent={handleSelectAgent}
      />

      <main className="flex flex-1 flex-col overflow-hidden">
        {initialAgents.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-4 py-8">
            <EmptyState projectId={projectId} />
          </div>
        ) : (
          <PolpoProvider
            baseUrl={baseUrl}
            apiPrefix="/v1"
            fetch={cookieFetch}
            autoConnect={false}
          >
            <Chat
              key={selectedAgent}
              sessionId={initialSessionIdRef.current}
              agent={selectedAgent}
              onSessionCreated={handleSessionCreated}
              onFinish={handleFinish}
              className="flex-1"
            />
          </PolpoProvider>
        )}
      </main>
    </>
  );
}

function TopBar({
  projectId,
  projectName,
  agents,
  selectedAgent,
  onSelectAgent,
}: {
  projectId: string;
  projectName: string;
  agents: AgentConfig[];
  selectedAgent: string | undefined;
  onSelectAgent: (name: string) => void;
}) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-4">
      <div className="flex items-center gap-3 min-w-0">
        <Link
          href={`/projects/${projectId}`}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to dashboard
        </Link>

        <div className="hidden md:block h-5 w-px bg-border" />

        <div className="hidden md:flex items-center gap-2 min-w-0">
          <Image
            src="/polpo-logo.svg"
            alt="Polpo"
            width={72}
            height={16}
            priority
            className="h-4 w-auto opacity-70"
          />
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Playground
          </span>
          <span className="text-muted-foreground/50">·</span>
          <span className="truncate text-sm font-medium text-foreground/80 font-mono">
            {projectName}
          </span>
        </div>
      </div>

      {agents.length > 0 && (
        <AgentModelSelector
          agents={agents}
          selected={selectedAgent}
          onSelect={onSelectAgent}
        />
      )}
    </header>
  );
}

function EmptyState({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border p-12 text-center max-w-md">
      <div className="flex h-10 w-10 items-center justify-center border border-border">
        <Plus className="h-5 w-5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-sm font-medium">No agents yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Create an agent from the dashboard, or deploy one from your CLI with{" "}
          <span className="font-mono">polpo deploy</span>.
        </p>
      </div>
      <Link
        href={`/projects/${projectId}/agents`}
        className="mt-2 bg-foreground text-background px-3 py-1.5 text-xs font-medium transition-all hover:bg-brand hover:text-brand-foreground"
      >
        Go to Agents
      </Link>
    </div>
  );
}
