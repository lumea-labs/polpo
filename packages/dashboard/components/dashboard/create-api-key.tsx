"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Copy, Check } from "lucide-react";
import type { Project } from "@/lib/api";

export function CreateApiKey({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [environment, setEnvironment] = useState<"live" | "test">("live");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/v1/api-keys`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name: name.trim(), environment }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? `Failed to create key (${res.status})`);
        setLoading(false);
        return;
      }

      const data = await res.json();
      setCreatedKey(data.rawKey);
      setLoading(false);
    } catch (err: any) {
      setError(err.message ?? "Something went wrong");
      setLoading(false);
    }
  }

  function handleCopy() {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function handleDone() {
    setCreatedKey(null);
    setOpen(false);
    setName("");
    router.refresh();
  }

  // Show the created key (one time only)
  if (createdKey) {
    return (
      <div className="mt-6 rounded-lg border border-brand/30 bg-brand/5 p-6">
        <p className="text-sm font-semibold">API key created</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Copy this key now. You won't be able to see it again.
        </p>
        <div className="mt-4 flex items-center gap-2">
          <code className="flex-1 rounded border border-border bg-card px-3 py-2 font-mono text-xs break-all">
            {createdKey}
          </code>
          <button
            onClick={handleCopy}
            className="shrink-0 rounded border border-border p-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-brand" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
        <button
          onClick={handleDone}
          className="mt-4 bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90"
        >
          Done
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90"
      >
        Create API key
      </button>
    );
  }

  return (
    <div className="mt-6 rounded-lg border border-border bg-card p-6">
      <p className="text-sm font-semibold">Create API key</p>

      {error && (
        <div className="mt-3 rounded border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production"
            required
            className="w-full border border-border bg-transparent px-3 py-2.5 text-sm placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Project</label>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full border border-border bg-transparent px-3 py-2.5 text-sm focus:border-foreground/30 focus:outline-none transition-colors"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">Environment</label>
          <div className="flex gap-3">
            {(["live", "test"] as const).map((env) => (
              <button
                key={env}
                type="button"
                onClick={() => setEnvironment(env)}
                className={`flex-1 border px-3 py-2 text-xs font-medium uppercase tracking-wider transition-colors ${
                  environment === env
                    ? "border-foreground/30 bg-secondary text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {env}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button
            type="submit"
            disabled={loading || !name.trim() || !projectId}
            className="group flex items-center justify-center gap-2 bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                Create
                <ArrowRight className="h-3.5 w-3.5" />
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
