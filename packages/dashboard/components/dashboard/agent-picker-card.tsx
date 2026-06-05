"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "#/components/ui/select";

/**
 * Agent picker styled as a card: pill label + select dropdown.
 * Shared across ConnectDialog SDK tab and OnboardingChecklist chat step.
 */
export function AgentPickerCard({
  agents,
  agent,
  onChange,
  show,
}: {
  agents: string[] | null;
  agent: string;
  onChange: (v: string) => void;
  show: boolean;
}) {
  if (!show) return null;
  return (
    <div className="flex flex-col gap-2 border border-border bg-background p-3">
      <span className="inline-flex h-5 w-fit items-center rounded bg-secondary px-2 text-[11px] font-medium text-muted-foreground">
        agent
      </span>
      {agents && agents.length > 1 ? (
        <Select value={agent} onValueChange={(v) => { if (v) onChange(v); }}>
          <SelectTrigger className="w-full font-mono text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p className="font-mono text-sm leading-6 text-foreground">
          {agents === null ? "Loading…" : agent}
        </p>
      )}
    </div>
  );
}
