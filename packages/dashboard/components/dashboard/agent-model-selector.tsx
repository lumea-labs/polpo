"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";

/**
 * Agent picker with the model shown on a second line inside the same
 * control. One bordered block, two-line items: agent display name on
 * top, model id (monospace, muted) below. Selected item gets a brand
 * accent bar in the dropdown.
 *
 * Shared between the /playground page and the inline playground tab
 * inside the onboarding checklist.
 */
export function AgentModelSelector({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentConfig[];
  selected: string | undefined;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const selectedConfig =
    agents.find((a) => a.name === selected) ?? agents[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex items-center gap-3 border border-border bg-card px-3 py-2 text-left transition-colors hover:border-foreground/30"
      >
        <AgentAvatar name={selectedConfig?.name ?? "?"} />
        <AgentModelPair
          name={selectedConfig?.identity?.displayName ?? selectedConfig?.name ?? "—"}
          model={selectedConfig?.model}
        />
        <ChevronDown
          className={`ml-2 size-3.5 text-muted-foreground transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 min-w-[240px] border border-border bg-card py-1 shadow-lg">
          {agents.map((a) => {
            const isSelected = a.name === selected;
            return (
              <button
                key={a.name}
                type="button"
                onClick={() => {
                  onSelect(a.name);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors hover:bg-accent ${
                  isSelected
                    ? "border-l-brand bg-accent/40"
                    : "border-l-transparent"
                }`}
              >
                <AgentAvatar name={a.name} />
                <AgentModelPair
                  name={a.identity?.displayName ?? a.name}
                  model={a.model}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentModelPair({
  name,
  model,
}: {
  name: string;
  model?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-medium leading-tight text-foreground">
        {name}
      </span>
      {model && (
        <span className="mt-0.5 truncate font-mono text-[10px] leading-none text-muted-foreground">
          {model}
        </span>
      )}
    </div>
  );
}

function AgentAvatar({ name }: { name: string }) {
  const letter = name.charAt(0).toUpperCase();
  return (
    <span className="flex size-6 shrink-0 items-center justify-center border border-border bg-background text-[10px] font-semibold text-foreground">
      {letter}
    </span>
  );
}
