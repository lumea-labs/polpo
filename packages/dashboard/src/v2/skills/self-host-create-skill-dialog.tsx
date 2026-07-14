"use client";

import { useState, type FormEvent } from "react";
import { useSkills } from "@polpo-ai/react";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { Textarea } from "../ui/textarea.js";

export function SelfHostCreateSkillDialog({ open, onOpenChange }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { createSkill, isCreating } = useSkills();
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    try {
      const name = String(data.get("name") ?? "").trim();
      await createSkill({ name, description: `Custom skill: ${name}`, content: String(data.get("content") ?? "").trim() });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create skill");
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="v2 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create custom skill</DialogTitle>
          <DialogDescription>Add a reusable SKILL.md definition to this project.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Name<Input name="name" required placeholder="customer-support" /></label>
          <label className="grid gap-1.5 text-[12px] font-medium text-foreground">Instructions<Textarea name="content" required rows={12} placeholder="# Customer support\n\nUse this skill when…" /></label>
          {error && <p className="text-[12px] text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={isCreating}>{isCreating ? "Creating…" : "Create skill"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
