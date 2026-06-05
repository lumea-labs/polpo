"use client";

import { useCallback, useMemo, useState } from "react";
import { CopyCard } from "@/components/dashboard/copy-card";
import { AgentPickerCard } from "@/components/dashboard/agent-picker-card";
import { TabToggle } from "@/components/dashboard/tab-toggle";
import { AgentModelSelector } from "@/components/dashboard/agent-model-selector";
import { PolpoProvider } from "@polpo-ai/react";
import { Chat } from "@polpo-ai/chat";
import type { AgentConfig } from "@polpo-ai/core";

type SnippetTab = "curl" | "ts" | "playground";

/**
 * SDK snippet panel — agent picker + language toggle (curl / TS /
 * Playground) + copy-able code snippet. Shared between ConnectDialog
 * SDK tab and OnboardingChecklist "Chat with your agent" step.
 *
 * When `projectId` and `apiUrl` are provided, a third "Playground"
 * tab appears that renders the same <Chat> UI against the session-
 * authenticated proxy — the user can fire a real chat completion
 * without leaving the panel.
 */
export function SdkSnippetPanel({
  baseUrl,
  agents,
  agentConfigs,
  defaultAgent,
  sdkKey = "$POLPO_API_KEY",
  compact = false,
  projectId,
  apiUrl,
}: {
  baseUrl: string;
  agents: string[] | null;
  /** Full agent configs — enables the Playground tab to show model info
   *  next to the agent name. When omitted, Playground shows name only. */
  agentConfigs?: AgentConfig[];
  defaultAgent: string;
  sdkKey?: string;
  compact?: boolean;
  projectId?: string;
  apiUrl?: string;
}) {
  const [agent, setAgent] = useState(defaultAgent);
  const canUsePlayground = !!projectId && !!apiUrl;
  const [lang, setLang] = useState<SnippetTab>(
    canUsePlayground ? "playground" : "curl",
  );

  // If `sdkKey` looks like a real key (starts with sk_), inline it in the
  // snippet so a freshly-generated key is immediately copy-pasteable.
  // Otherwise fall back to the $POLPO_API_KEY env-var placeholder.
  const isRealKey = sdkKey.startsWith("sk_");
  const tsKeyExpr = isRealKey ? `"${sdkKey}"` : "process.env.POLPO_API_KEY!";
  const curlAuthKey = isRealKey ? sdkKey : "$POLPO_API_KEY";

  const tsSnippet = `import { PolpoClient } from "@polpo-ai/sdk";

const polpo = new PolpoClient({
  apiKey: ${tsKeyExpr},
  baseUrl: "${baseUrl}",
});

const res = await polpo.chatCompletions({
  model: "polpo",
  agent: "${agent}",
  stream: true,
  messages: [{ role: "user", content: "Hello" }],
});`;

  const curlPreamble = isRealKey
    ? ""
    : `# Load your API key from .env.local (created by polpo link)
export POLPO_API_KEY=$(grep POLPO_API_KEY .env.local | cut -d= -f2)

`;

  const curlSnippet = `${curlPreamble}curl ${baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer ${curlAuthKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "polpo",
    "agent": "${agent}",
    "stream": true,
    "messages": [{"role":"user","content":"Hello"}]
  }'`;

  const options: { value: SnippetTab; label: string }[] = [
    ...(canUsePlayground
      ? [{ value: "playground" as const, label: "Playground" }]
      : []),
    { value: "curl", label: "curl" },
    { value: "ts", label: "TypeScript" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <TabToggle value={lang} onChange={setLang} options={options} />

      {!compact && lang !== "playground" && (
        <AgentPickerCard
          agents={agents}
          agent={agent}
          onChange={setAgent}
          show={agents !== null && agents.length > 0}
        />
      )}

      {lang === "playground" && canUsePlayground && (
        <InlinePlayground
          projectId={projectId!}
          apiUrl={apiUrl!}
          agent={agent}
          onAgentChange={setAgent}
          agentConfigs={agentConfigs}
        />
      )}

      {lang !== "playground" && (
        <CopyCard
          label={lang === "ts" ? "@polpo-ai/sdk" : "curl"}
          value={lang === "ts" ? tsSnippet : curlSnippet}
          lang={lang}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inline playground — same wiring as the /playground page, but       */
/*  constrained to a small panel for use inside onboarding / dialogs.  */
/* ------------------------------------------------------------------ */

function InlinePlayground({
  projectId,
  apiUrl,
  agent,
  onAgentChange,
  agentConfigs,
}: {
  projectId: string;
  apiUrl: string;
  agent: string;
  onAgentChange: (name: string) => void;
  agentConfigs?: AgentConfig[];
}) {
  const baseUrl = `${apiUrl}/v1/projects/${projectId}/data`;
  const [sessionState, setSessionState] = useState<{ agent: string; id: string } | null>(null);
  const sessionId = sessionState?.agent === agent ? sessionState.id : undefined;
  const setCurrentSessionId = useCallback((id: string) => setSessionState({ agent, id }), [agent]);

  const cookieFetch = useMemo<typeof globalThis.fetch>(
    () =>
      (async (input, init) => {
        const res = await globalThis.fetch(input, {
          ...init,
          credentials: "include",
        });
        const id = res.headers.get("x-session-id");
        if (id) setCurrentSessionId(id);
        return res;
      }) as typeof globalThis.fetch,
    [setCurrentSessionId],
  );

  return (
    <div className="flex flex-col gap-2">
      {agentConfigs && agentConfigs.length > 0 && (
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60">
            Chatting with
          </span>
          <AgentModelSelector
            agents={agentConfigs}
            selected={agent}
            onSelect={onAgentChange}
          />
        </div>
      )}
      <div className="flex h-[420px] flex-col border border-border bg-card">
        <PolpoProvider
          baseUrl={baseUrl}
          apiPrefix="/v1"
          fetch={cookieFetch}
          autoConnect={false}
        >
          <Chat key={agent} sessionId={sessionId} agent={agent} onSessionCreated={setCurrentSessionId} className="flex-1" />
        </PolpoProvider>
      </div>
    </div>
  );
}
