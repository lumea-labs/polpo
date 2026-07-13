"use client";

import { useEffect, useState, type FormEvent } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { useMemory } from "@polpo-ai/react";
import { Button, IconButton, LoadingRows, PageHeader } from "../components.js";

export function MemoryView() {
  const { memory, isLoading, error, saveMemory, refetch } = useMemory();
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setContent(memory?.content ?? ""), [memory?.content]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    await saveMemory(content).finally(() => setSaving(false));
  }
  return (
    <div className="pd-view-stack">
      <PageHeader title="Shared memory" description="Shared context injected into every agent in this runtime." actions={<IconButton label="Refresh memory" onClick={() => void refetch()}><ArrowClockwise size={15} /></IconButton>} />
      {error ? <div className="pd-error">{error.message}</div> : null}
      {isLoading && !memory ? <LoadingRows rows={4} /> : <form className="pd-memory-editor" onSubmit={(event) => void submit(event)}><textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} /><footer><span>{content.trim() ? `${content.trim().split(/\s+/).length} words` : "Empty memory"}</span><Button type="submit" disabled={saving}>{saving ? "Saving..." : "Save memory"}</Button></footer></form>}
    </div>
  );
}
