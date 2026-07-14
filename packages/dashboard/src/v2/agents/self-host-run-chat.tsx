"use client";

import { useEffect, useRef } from "react";
import { SelfHostPolpoChat } from "../playground/self-host-chat.js";

export function PolpoChat({
  agent,
  initialMessage,
  seedKey,
  onRawDone,
}: {
  baseUrl: string;
  agent: string | undefined;
  initialMessage?: string;
  seedKey?: string;
  onRawChunk?: (chunk: string) => void;
  onRawDone?: () => void;
  onRawError?: () => void;
}) {
  const done = useRef(onRawDone);
  done.current = onRawDone;
  useEffect(() => {
    if (!initialMessage) return;
    try {
      window.sessionStorage.setItem(
        `polpo:run-seed:${seedKey ?? agent ?? "agent"}`,
        initialMessage,
      );
    } catch {}
  }, [agent, initialMessage, seedKey]);

  return (
    <SelfHostPolpoChat
      baseUrl=""
      agent={agent}
      loop={undefined}
      onSession={() => {}}
      landing={
        <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
          Send a message to test this agent.
        </div>
      }
      composerControls={null}
      gutter="none"
    />
  );
}
