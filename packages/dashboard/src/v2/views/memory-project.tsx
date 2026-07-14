"use client";

import { useState } from "react";
import {
  Brain,
  CircleNotch,
  FloppyDisk,
  PencilSimple,
} from "@phosphor-icons/react";
import { Button, Markdown, usePolpoClient } from "./memory-host.js";

const MEMORY_TEXTAREA_CLASS =
  "h-[calc(100vh-320px)] min-h-[360px] max-h-[900px] w-full resize-y rounded-lg border border-border bg-card p-4 font-mono text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none";

export function ProjectMemory({
  projectId,
  initial,
}: {
  projectId: string;
  initial: string;
}) {
  const polpo = usePolpoClient(projectId);
  const [value, setValue] = useState(initial);
  const [mode, setMode] = useState<"read" | "edit">(initial ? "read" : "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(initial);
  const dirty = value !== savedAt;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await polpo.saveMemory(value);
      setSavedAt(value);
      setMode("read");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] text-muted-foreground/50" data-tabular>
          {value.length} chars · ~{Math.ceil(value.length / 4)} tokens
        </span>
        <div className="flex items-center gap-2">
          {mode === "read" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMode("edit")}
            >
              <PencilSimple size={15} />
              Refine
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                {saving ? (
                  <>
                    <CircleNotch size={14} className="animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <FloppyDisk size={14} />
                    Save memory
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  setValue(savedAt);
                  setError(null);
                  setMode(savedAt ? "read" : "edit");
                }}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      {mode === "read" ? (
        value.trim() ? (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-[13px] leading-relaxed text-foreground">
            <Markdown content={value} />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-3.5 py-12 text-center">
            <span className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-secondary">
              <Brain size={20} className="text-muted-foreground" />
            </span>
            <span className="text-[13px] text-muted-foreground">
              No project memory yet. Click Refine to add it.
            </span>
          </div>
        )
      ) : (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          placeholder="Shared facts, conventions, and context every agent should know..."
          className={MEMORY_TEXTAREA_CLASS}
        />
      )}

      {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
    </div>
  );
}
