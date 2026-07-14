"use client";

import { useEffect, useState } from "react";
import { useRouter } from "../host";
import { useQueryClient } from "../host";
import { X } from "@phosphor-icons/react/dist/ssr";
import { BuilderChat } from "../host";
import { DASHBOARD_API_URL } from "../host";

const API_URL = DASHBOARD_API_URL;

/**
 * Edit-with-AI panel for the agent detail — a right-docked card (not a full
 * overlay) that runs the v1 `BuilderChat` (@lumea-labs/chat kit) scoped to a
 * single agent via `agentName`. Editing the agent by talking; when the Meta
 * Agent mutates it, `onMutation` invalidates the same react-query keys the
 * Model / Tools / Skills tabs use, so the open detail view re-syncs.
 *
 * The `.builder-scope` wrapper (see v2.css) fixes the third-party composer's
 * focus ring and tightens its lateral gutters.
 */
export function AgentEditPanel({
  projectId,
  agentName,
  open,
  onClose,
}: {
  projectId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [render, setRender] = useState(open);

  // Keep the card mounted through the exit animation, then unmount.
  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    const t = setTimeout(() => setRender(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  // Close on Escape while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!render) return null;

  return (
    <aside
      className={`builder-scope fixed right-4 top-16 z-40 flex h-[calc(100vh-5rem)] w-[min(440px,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl duration-200 ease-out ${
        open
          ? "animate-in fade-in-0 slide-in-from-right-6"
          : "animate-out fade-out-0 slide-out-to-right-6"
      }`}
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-foreground">
          Edit agent
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {agentName}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
        >
          <X size={15} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <BuilderChat
          projectId={projectId}
          apiUrl={API_URL}
          agentName={agentName}
          persistKey={`polpo:agent-edit:${projectId}:${agentName}`}
          onMutation={() => {
            queryClient.invalidateQueries({ queryKey: ["agent", projectId, agentName] });
            queryClient.invalidateQueries({ queryKey: ["agents", projectId] });
            router.refresh();
          }}
        />
      </div>
    </aside>
  );
}
