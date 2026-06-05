"use client";

/**
 * Agent model picker — shows the current model as a `<ModelBadge>`
 * with an edit button. Click → swap the badge for
 * `<ModelSelectorCompact>` to change. On selection (or blur/escape),
 * collapses back to badge.
 *
 * Catalog: pulled from `/api/gateway/models` (Vercel AI Gateway
 * proxy). Each entry's `id` is `<provider>/<name>` — we split on `/`
 * to derive providerId + name and reuse `DEFAULT_PROVIDERS` for the
 * logo tiles.
 *
 * Persist: `PATCH /v1/projects/:id/data/v1/agents/:name` with
 * `{ model }`. On success we `router.refresh()` so the layout's
 * server-fetched `agent.model` updates without a hard reload.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";
import {
  ModelBadge,
  ModelSelectorCompact,
  DEFAULT_PROVIDERS,
  type Model,
} from "@lumea-labs/llm";

interface GatewayModel {
  id: string;
  owned_by?: string;
  context_window?: number;
}

interface Props {
  projectId: string;
  agentName: string;
  currentModel: string | undefined;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function AgentModelPicker({ projectId, agentName, currentModel }: Props) {
  const router = useRouter();
  const [models, setModels] = useState<Model[]>([]);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/gateway/models")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const raw = (data.data ?? data ?? []) as GatewayModel[];
        const mapped: Model[] = raw
          .filter((m) => m.id.includes("/"))
          .map((m) => {
            const [providerId, ...rest] = m.id.split("/");
            return {
              id: m.id,
              name: rest.join("/"),
              providerId,
            };
          });
        setModels(mapped);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Derive providers from the catalog so brand new ones (e.g.
  // "fireworks/...") show up too. Falls back to DEFAULT_PROVIDERS
  // for the known ones (logos, colours).
  const providers = useMemo(() => {
    const seen = new Set(DEFAULT_PROVIDERS.map((p) => p.id));
    const extras = Array.from(
      new Set(models.map((m) => m.providerId).filter((p) => !seen.has(p))),
    ).map((id) => ({
      id,
      name: id,
      color: "#888",
    }));
    return [...DEFAULT_PROVIDERS, ...extras];
  }, [models]);

  // Resolve the currently selected model into the Model shape needed
  // by <ModelBadge>. If it's not in the gateway catalog (e.g. custom
  // provider), build a minimal entry on the fly so the badge still
  // renders the raw id without crashing.
  const currentModelEntry = useMemo<Model | null>(() => {
    if (!currentModel) return null;
    const found = models.find((m) => m.id === currentModel);
    if (found) return found;
    const [providerId, ...rest] = currentModel.split("/");
    return {
      id: currentModel,
      name: rest.length > 0 ? rest.join("/") : currentModel,
      providerId: providerId ?? "other",
    };
  }, [currentModel, models]);

  async function handleChange(modelId: string) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_URL}/v1/projects/${projectId}/data/v1/agents/${encodeURIComponent(agentName)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Update failed (${res.status})`);
        setSaving(false);
        return;
      }
      // Collapse back to badge once the new model is committed.
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "Update failed");
    }
    setSaving(false);
  }

  if (models.length === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/40 font-mono">
        <Loader2 className="h-3 w-3 animate-spin" />
        loading models…
      </span>
    );
  }

  // Editing mode — full selector with cancel.
  if (editing) {
    return (
      <div className="inline-flex items-center gap-2">
        <ModelSelectorCompact
          models={models}
          value={currentModel}
          onChange={handleChange}
          providers={providers}
          appearance="ghost"
          showProvider
          showLogo
        />
        {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Cancel
        </button>
        {error && (
          <span className="text-[11px] text-destructive" title={error}>
            {error.length > 40 ? `${error.slice(0, 40)}…` : error}
          </span>
        )}
      </div>
    );
  }

  // Default mode — read-only badge + edit button.
  return (
    <div className="inline-flex items-center gap-1.5">
      {currentModelEntry ? (
        <ModelBadge model={currentModelEntry} providers={providers} showLogo />
      ) : (
        <span className="text-xs text-muted-foreground/40 italic">no model set</span>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Change model"
        title="Change model"
        className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}
