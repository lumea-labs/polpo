"use client";

import { useState, type FormEvent } from "react";
import { useAgents } from "@polpo-ai/react";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { Textarea } from "../ui/textarea.js";

export function SelfHostCreateAgentDialog({ open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { addAgent, isAddingAgent } = useAgents();
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    try {
      await addAgent({
        name: String(data.get("name") ?? "").trim(),
        role: String(data.get("role") ?? "").trim() || undefined,
        model: String(data.get("model") ?? "").trim() || undefined,
        systemPrompt: String(data.get("systemPrompt") ?? "").trim() || undefined,
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create agent");
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>Define a portable agent for this Polpo runtime.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Name<Input name="name" required placeholder="support-agent" pattern="[A-Za-z0-9_-]+" /></label>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Role<Input name="role" placeholder="Customer support specialist" /></label>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Model<Input name="model" placeholder="anthropic/claude-sonnet-4.5" /></label>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Instructions<Textarea name="systemPrompt" rows={7} placeholder="Explain what this agent should do…" /></label>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isAddingAgent}>{isAddingAgent ? "Creating…" : "Create agent"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
