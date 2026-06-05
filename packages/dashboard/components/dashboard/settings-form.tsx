"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Shield,
  Check,
  Copy,
  ExternalLink,
  Plug,
  FileText,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Minus,
  Pencil,
  Eye,
} from "lucide-react";
import { fetchDataPlane, mutateDataPlane } from "#/lib/data-client";
import { fetchControlPlane } from "#/lib/data-client";
import type { ProjectSettings, ProjectGatewaySettings } from "#/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "#/components/ui/dialog";
import { CopyCard } from "#/components/dashboard/copy-card";
import { useEventCatalog } from "#/lib/use-event-catalog";
import { WebhookDeliveries } from "#/components/dashboard/webhook-deliveries";
import { InferenceModeRadio, type InferenceMode } from "#/components/dashboard/inference-mode";
import type { ByokEntry } from "#/lib/api";

const SALES_EMAIL = "hello@polpo.sh";

/** Providers selectable for request-scoped BYOK. Mirrors PROVIDER_ENV_MAP
 *  in @polpo-ai/core (the supported set the server validates against). */
const BYOK_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google (Gemini)" },
  { value: "xai", label: "xAI (Grok)" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "cerebras", label: "Cerebras" },
  { value: "mistral", label: "Mistral" },
  { value: "deepseek", label: "DeepSeek" },
];

interface Webhook {
  id: string;
  url: string;
  events: string[];
  created_at: string;
}


interface SettingsFormProps {
  projectId: string;
  projectName: string;
  projectSlug: string;
  apiEndpoint: string;
  initialSettings?: ProjectSettings | null;
  /**
   * Server-fetched Autumn integration status — passed to <IntegrationsTab>
   * as TanStack Query `initialData` so the card renders the connection
   * state instantly instead of flashing a "Loading status…" spinner.
   */
  initialAutumnStatus?: AutumnStatusResponse | null;
}

type TabId = "general" | "gateway" | "integrations" | "webhooks";

const TABS: { id: TabId; label: string }[] = [
  { id: "general", label: "General" },
  { id: "gateway", label: "AI Gateway" },
  { id: "integrations", label: "Integrations" },
  { id: "webhooks", label: "Webhooks" },
];

export function SettingsForm({ projectId, projectName, projectSlug, apiEndpoint, initialSettings, initialAutumnStatus }: SettingsFormProps) {
  const [active, setActive] = useState<TabId>("general");

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-extrabold tracking-tight">Project Settings</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Configure this project's general info, LLM gateway, and webhooks.
      </p>

      <div className="mt-8 flex gap-1 border-b border-border overflow-x-auto scrollbar-none">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            data-testid={`settings-tab-${tab.id}`}
            className={`relative px-3 py-2 text-sm transition-colors whitespace-nowrap ${
              active === tab.id
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {active === tab.id && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
            )}
          </button>
        ))}
      </div>

      <div className="mt-8">
        {active === "general" && (
          <GeneralTab
            projectId={projectId}
            projectName={projectName}
            projectSlug={projectSlug}
            apiEndpoint={apiEndpoint}
          />
        )}
        {active === "gateway" && (
          <GatewayTab projectId={projectId} initialSettings={initialSettings} />
        )}
        {active === "integrations" && (
          <IntegrationsTab
            projectId={projectId}
            initialStatus={initialAutumnStatus}
          />
        )}
        {active === "webhooks" && <WebhooksTab projectId={projectId} />}
      </div>
    </div>
  );
}

/* ── General Tab ──────────────────────────────────────────── */

function GeneralTab({ projectId, projectName, projectSlug, apiEndpoint }: {
  projectId: string;
  projectName: string;
  projectSlug: string;
  apiEndpoint: string;
}) {
  const router = useRouter();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [nameInput, setNameInput] = useState(projectName);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaved, setRenameSaved] = useState(false);

  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

  const renameMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`${API_URL}/v1/projects/${projectId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setRenameError(null);
      setRenameSaved(true);
      setTimeout(() => setRenameSaved(false), 2000);
      router.refresh();
    },
    onError: (err: Error) => {
      setRenameError(err.message);
    },
  });

  const nameChanged = nameInput.trim() !== projectName && nameInput.trim().length > 0;

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_URL}/v1/projects/${projectId}`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Error ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      router.push("/projects");
    },
    onError: (err: Error) => {
      setDeleteError(err.message);
    },
  });

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">Project details</h2>
      <div className="mt-4 space-y-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Project name
          </label>
          <div className="flex items-stretch gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              className="flex-1 border border-border bg-transparent px-3 py-2.5 text-sm focus:border-foreground/30 focus:outline-none transition-colors"
            />
            <button
              type="button"
              onClick={() => renameMutation.mutate(nameInput.trim())}
              disabled={!nameChanged || renameMutation.isPending}
              className="rounded border border-border bg-foreground/5 px-4 py-2 text-sm font-medium text-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-foreground/5 disabled:hover:text-foreground"
            >
              {renameMutation.isPending ? "Saving…" : renameSaved ? "Saved" : "Save"}
            </button>
          </div>
          {renameError && (
            <p className="mt-2 text-xs text-destructive">{renameError}</p>
          )}
        </div>
        <div>
          <CopyCard label="Project ID" value={projectId} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Use this in the CLI:{" "}
            <span className="font-mono">polpo --project-id &lt;ID&gt;</span>
          </p>
        </div>
        <div>
          <CopyCard label="API endpoint" value={apiEndpoint} />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Base URL for your project's data plane. Pair it with a project API
            key.
          </p>
        </div>
      </div>
      {/* Danger zone */}
      <div className="mt-16 border border-destructive/20 p-6">
        <h3 className="text-sm font-medium text-destructive">Danger zone</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Permanently remove this project, all agents, data, and API keys. This cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="mt-4 border border-destructive/30 px-4 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            Delete project
          </button>
        ) : (
          <div className="mt-4 space-y-3">
            <div className="flex items-start gap-2 rounded border border-destructive/20 bg-destructive/5 p-3">
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-xs text-destructive">
                Type <span className="font-mono font-bold">{projectName}</span> to confirm deletion.
              </p>
            </div>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={projectName}
              className="w-full border border-destructive/30 bg-transparent px-3 py-2 text-sm font-mono focus:border-destructive focus:outline-none transition-colors"
              autoFocus
            />
            {deleteError && (
              <p className="text-xs text-destructive">{deleteError}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={() => deleteMutation.mutate()}
                disabled={confirmName !== projectName || deleteMutation.isPending}
                className="inline-flex items-center gap-2 bg-destructive text-destructive-foreground px-4 py-1.5 text-xs font-medium transition-all hover:opacity-90 disabled:opacity-30"
              >
                {deleteMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Delete permanently"
                )}
              </button>
              <button
                onClick={() => { setShowDeleteConfirm(false); setConfirmName(""); setDeleteError(null); }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/* ── LLM Gateway Tab ─────────────────────────────────────── */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

function GatewayTab({ projectId, initialSettings }: { projectId: string; initialSettings?: ProjectSettings | null }) {
  const existingGateway = initialSettings?.gateway;

  // Provider keys (request-scoped BYOK) — fetched on mount.
  const [keys, setKeys] = useState<ByokEntry[]>([]);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/v1/byok/${projectId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => { if (!cancelled) setKeys(d.data ?? []); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setKeysLoaded(true); });
    return () => { cancelled = true; };
  }, [projectId]);

  const providerKeys = keys.filter((k) => k.provider !== "gateway");
  const hasCustomGateway = !!existingGateway?.url;

  // Derived current mode → initial view.
  function derive(): InferenceMode {
    if (hasCustomGateway) return "gateway";
    if (providerKeys.length > 0) return "byok";
    return "managed";
  }
  const [viewMode, setViewMode] = useState<InferenceMode>(derive);
  // Re-sync once keys arrive (so a project with keys lands on BYOK).
  useEffect(() => {
    if (keysLoaded) setViewMode(derive());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysLoaded]);

  // Custom gateway is Enterprise-gated: self-serve only when already
  // configured (existing users keep editing); new projects see "Contact us".
  const customGatewayEnabled = hasCustomGateway;

  // ── Gateway form state ──
  const [gatewayUrl, setGatewayUrl] = useState(existingGateway?.url ?? "");
  const [gatewayApiKey, setGatewayApiKey] = useState("");
  const [gatewayHeaders, setGatewayHeaders] = useState(
    existingGateway?.headers ? JSON.stringify(existingGateway.headers, null, 2) : "",
  );
  const [savingGw, setSavingGw] = useState(false);
  const [savedGw, setSavedGw] = useState(false);
  const [gwError, setGwError] = useState<string | null>(null);

  // ── Provider-key form state ──
  const [keyProvider, setKeyProvider] = useState("openai");
  const [keyValue, setKeyValue] = useState("");
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);

  // ── Managed switch state ──
  const [switching, setSwitching] = useState(false);

  const usedProviders = new Set(providerKeys.map((k) => k.provider));
  const availableProviders = BYOK_PROVIDERS.filter((p) => !usedProviders.has(p.value));

  async function refreshKeys() {
    const r = await fetch(`${API_URL}/v1/byok/${projectId}`, { credentials: "include" });
    const d = r.ok ? await r.json() : { data: [] };
    setKeys(d.data ?? []);
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    setKeyError(null);
    setSavingKey(true);
    try {
      const res = await fetch(`${API_URL}/v1/byok/${projectId}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: keyProvider, key: keyValue.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Error ${res.status}`);
      }
      await refreshKeys();
      setKeyValue("");
      setShowKeyForm(false);
    } catch (err: any) {
      setKeyError(err.message);
    } finally {
      setSavingKey(false);
    }
  }

  async function handleDeleteKey(provider: string) {
    setDeletingKey(provider);
    try {
      await fetch(`${API_URL}/v1/byok/${projectId}/${provider}`, {
        method: "DELETE",
        credentials: "include",
      });
      await refreshKeys();
    } catch {} finally {
      setDeletingKey(null);
    }
  }

  async function handleSaveGateway(e: React.FormEvent) {
    e.preventDefault();
    setGwError(null);
    setSavingGw(true);
    setSavedGw(false);
    try {
      let headers: Record<string, string> | undefined;
      if (gatewayHeaders.trim()) {
        try { headers = JSON.parse(gatewayHeaders.trim()); }
        catch { throw new Error("Invalid JSON in custom headers."); }
      }
      const settingsRes = await fetch(`${API_URL}/v1/projects/${projectId}/settings`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway: { url: gatewayUrl.trim(), headers } }),
      });
      if (!settingsRes.ok) {
        const data = await settingsRes.json().catch(() => ({}));
        throw new Error(data.error ?? `Error ${settingsRes.status}`);
      }
      if (gatewayApiKey.trim()) {
        await fetch(`${API_URL}/v1/byok/${projectId}`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "gateway", key: gatewayApiKey.trim(), label: "Gateway API Key" }),
        });
      }
      setSavedGw(true);
      setGatewayApiKey("");
      setTimeout(() => setSavedGw(false), 3000);
    } catch (err: any) {
      setGwError(err.message);
    } finally {
      setSavingGw(false);
    }
  }

  // Switch back to Polpo managed — clears the custom gateway + its key.
  async function handleSwitchToManaged() {
    setSwitching(true);
    try {
      await fetch(`${API_URL}/v1/projects/${projectId}/settings`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gateway: null }),
      });
      await fetch(`${API_URL}/v1/byok/${projectId}/gateway`, {
        method: "DELETE",
        credentials: "include",
      }).catch(() => {});
      window.location.reload();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">AI Gateway</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Choose how this project pays for inference.
      </p>

      <div className="mt-6">
        <InferenceModeRadio
          value={viewMode}
          onChange={setViewMode}
          customGatewayEnabled={customGatewayEnabled}
          onContactSales={() => {
            window.location.href = `mailto:${SALES_EMAIL}?subject=${encodeURIComponent("Custom gateway — Enterprise")}`;
          }}
        >
          {/* ── Managed panel ── */}
          {viewMode === "managed" && (
            <div className="border border-border bg-card p-5">
              <p className="text-sm font-medium">Polpo managed gateway</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Routes through the Vercel AI Gateway. Inference is deducted from
                your credit balance at list price.
              </p>
              {hasCustomGateway && (
                <button
                  onClick={handleSwitchToManaged}
                  disabled={switching}
                  className="mt-4 inline-flex items-center gap-2 border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-foreground/30 hover:bg-foreground/5 disabled:opacity-50"
                >
                  {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Switch to Polpo managed (clears custom gateway)
                </button>
              )}
              {providerKeys.length > 0 && (
                <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted-foreground/70">
                  This project also has provider keys. Calls to those providers
                  use BYOK (free on Polpo); everything else is managed.
                </p>
              )}
            </div>
          )}

          {/* ── Provider keys (BYOK) panel ── */}
          {viewMode === "byok" && (
            <div className="border border-border bg-card p-5">
              <p className="text-sm font-medium">Provider keys</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Encrypted per project. Calls to a provider with a key here are
                billed by that provider — free on Polpo.
              </p>

              {providerKeys.length > 0 && (
                <div className="mt-4 divide-y divide-border border-y border-border">
                  {providerKeys.map((k) => {
                    const label = BYOK_PROVIDERS.find((p) => p.value === k.provider)?.label ?? k.provider;
                    return (
                      <div key={k.provider} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-medium">{label}</span>
                          <span className="font-mono text-[11px] text-muted-foreground/60 truncate">{k.maskedKey}</span>
                        </div>
                        <button
                          onClick={() => handleDeleteKey(k.provider)}
                          disabled={deletingKey === k.provider}
                          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                          aria-label={`Remove ${label} key`}
                        >
                          {deletingKey === k.provider ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {keyError && (
                <div className="mt-3 border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">{keyError}</div>
              )}

              {!showKeyForm ? (
                <button
                  onClick={() => { setKeyProvider(availableProviders[0]?.value ?? "openai"); setShowKeyForm(true); }}
                  disabled={availableProviders.length === 0}
                  className="mt-4 inline-flex items-center gap-1.5 border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:border-foreground/30 hover:bg-foreground/5 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add provider key
                </button>
              ) : (
                <form onSubmit={handleAddKey} className="mt-4 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end">
                  <div className="flex-1">
                    <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60 mb-1">Provider</label>
                    <select
                      value={keyProvider}
                      onChange={(e) => setKeyProvider(e.target.value)}
                      className="w-full border border-border bg-background px-2.5 py-2 text-sm focus:border-foreground/30 focus:outline-none appearance-none"
                    >
                      {availableProviders.map((p) => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-[2]">
                    <label className="block text-[10px] font-mono uppercase tracking-wider text-muted-foreground/60 mb-1">API key</label>
                    <input
                      type="password"
                      value={keyValue}
                      onChange={(e) => setKeyValue(e.target.value)}
                      placeholder="sk-…"
                      required
                      className="w-full border border-border bg-transparent px-2.5 py-2 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="submit"
                      disabled={savingKey || !keyValue.trim()}
                      className="inline-flex items-center gap-1.5 bg-foreground text-background px-3 py-2 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
                    >
                      {savingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowKeyForm(false); setKeyError(null); setKeyValue(""); }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* ── Custom gateway panel (enterprise) ── */}
          {viewMode === "gateway" && customGatewayEnabled && (
            <form onSubmit={handleSaveGateway} className="border border-border bg-card p-5 space-y-4 max-w-lg">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Gateway URL</label>
                <input
                  type="url"
                  value={gatewayUrl}
                  onChange={(e) => setGatewayUrl(e.target.value)}
                  placeholder="https://your-gateway.example.com/v1"
                  required
                  className="w-full border border-border bg-transparent px-3 py-2.5 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">API Key</label>
                <input
                  type="password"
                  value={gatewayApiKey}
                  onChange={(e) => setGatewayApiKey(e.target.value)}
                  placeholder="Leave empty to keep existing key"
                  className="w-full border border-border bg-transparent px-3 py-2.5 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">Custom Headers (JSON, optional)</label>
                <textarea
                  value={gatewayHeaders}
                  onChange={(e) => setGatewayHeaders(e.target.value)}
                  placeholder={'{"X-Custom-Header": "value"}'}
                  rows={3}
                  className="w-full border border-border bg-transparent px-3 py-2.5 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors resize-y"
                />
              </div>
              {gwError && (
                <div className="border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">{gwError}</div>
              )}
              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={savingGw || !gatewayUrl.trim()}
                  className="inline-flex items-center gap-2 bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
                >
                  {savingGw ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save gateway"}
                </button>
                {savedGw && <span className="text-xs text-muted-foreground">Saved.</span>}
              </div>
            </form>
          )}
        </InferenceModeRadio>
      </div>
    </section>
  );
}

/* ── Integrations Tab ─────────────────────────────────────── */

export interface AutumnStatusResponse {
  connected: boolean;
  status?: "active" | "error" | "revoked";
  env?: "sandbox" | "live" | "unknown";
  featureIds?: {
    completions: string;
    tasks: string;
    inferenceUsd: string;
    inputTokens?: string | null;
    outputTokens?: string | null;
  };
  eventsCount?: number;
  errorsCount?: number;
  lastUsedAt?: string | null;
  lastError?: string | null;
  lastErrorAt?: string | null;
  createdAt?: string;
}

/**
 * Project integrations tab. Today only Autumn billing pass-through —
 * future identity providers, Stripe direct, etc. live as additional cards
 * here without changing the tab layout.
 *
 * The Autumn card has two states:
 *   - **Disconnected**: form to paste the builder's Autumn secret key.
 *     On submit, Polpo validates the key, creates the polpo_* features in
 *     the builder's Autumn (idempotent), and persists the encrypted secret.
 *   - **Active**: status + telemetry (events fired, errors, last error
 *     reason) + a "Disconnect" button. The plaintext key is never echoed
 *     back — once submitted, only counters and feature ids are visible.
 */
type ConnectionState = "disconnected" | "incomplete" | "active";
type WizardStep = "connect" | "plans" | "status";

/**
 * Derive the connection state from the raw status response. Today this is
 * a client-side heuristic — once the backend grows a "verify plan
 * attachment" endpoint, it can replace `incomplete` here without touching
 * any of the UI below.
 *
 * TODO(verify-endpoint): swap `eventsCount === 0` for a real
 * `plansAttached` boolean from the API.
 */
function deriveConnectionState(status: AutumnStatusResponse | undefined): ConnectionState {
  if (!status?.connected) return "disconnected";
  if (!status.eventsCount || status.eventsCount === 0) return "incomplete";
  return "active";
}

function IntegrationsTab({
  projectId,
  initialStatus,
}: {
  projectId: string;
  initialStatus?: AutumnStatusResponse | null;
}) {
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  const queryClient = useQueryClient();

  const { data: status, isLoading } = useQuery<AutumnStatusResponse>({
    queryKey: ["autumn-integration", projectId],
    queryFn: async () => {
      const res = await fetch(
        `${API_URL}/v1/integrations/${projectId}/autumn`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const json = await res.json();
      return json.data as AutumnStatusResponse;
    },
    // SSR-prefetched: the integration row was already loaded server-side
    // alongside the project, so we hydrate without a loading flash. Keep it
    // fresh for a minute, then revalidate in the background.
    initialData: initialStatus ?? undefined,
    staleTime: 60_000,
  });

  const [dialogOpen, setDialogOpen] = useState(false);

  const connectionState = deriveConnectionState(status);

  // Pick the entry step based on the card's current state.
  const initialStep: WizardStep =
    connectionState === "disconnected"
      ? "connect"
      : connectionState === "incomplete"
        ? "plans"
        : "status";

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight">Integrations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your stack to Polpo.
        </p>
      </div>

      {/* Autumn card */}
      <div className="rounded-lg border border-border p-5">
        <div className="flex items-start gap-4">
          {/* Logo */}
          <img
            src="/logos/autumn-icon.svg"
            alt="Autumn"
            className="h-12 w-12 shrink-0 rounded"
          />

          {/* Title + description + status pill */}
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-none">Autumn</h3>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Per-end-user billing pass-through. Polpo fires usage events to
              your Autumn — you manage plans &amp; pricing there.
            </p>
            {!isLoading && connectionState !== "disconnected" && (
              <div className="mt-2.5">
                <StatusPill state={connectionState} env={status?.env} />
              </div>
            )}
            {isLoading && (
              <div className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading status…
              </div>
            )}
          </div>

          {/* Action button */}
          <div className="shrink-0">
            {!isLoading && (
              <button
                type="button"
                onClick={() => setDialogOpen(true)}
                className={
                  connectionState === "disconnected"
                    ? "inline-flex items-center gap-2 bg-foreground px-3 py-1.5 text-xs font-medium text-background transition-all hover:opacity-90"
                    : "inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-secondary transition-colors"
                }
              >
                {connectionState === "disconnected"
                  ? "Connect Autumn"
                  : connectionState === "incomplete"
                    ? "Finish setup"
                    : "Manage"}
              </button>
            )}
          </div>
        </div>
      </div>

      <AutumnWizardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialStep={initialStep}
        mode={connectionState === "active" ? "manage" : "wizard"}
        projectId={projectId}
        apiUrl={API_URL}
        status={status}
        onChanged={() =>
          queryClient.invalidateQueries({
            queryKey: ["autumn-integration", projectId],
          })
        }
      />
    </section>
  );
}

/* ── Status pill (card) ─────────────────────────────────── */

function StatusPill({
  state,
  env,
}: {
  state: ConnectionState;
  env?: AutumnStatusResponse["env"];
}) {
  if (state === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-brand" />
        </span>
        Bridge active
        {env && env !== "unknown" && (
          <span className="ml-1 uppercase tracking-wide opacity-70">{env}</span>
        )}
      </span>
    );
  }
  if (state === "incomplete") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
        Action required
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
      Disconnected
    </span>
  );
}

/* ── Wizard Dialog ──────────────────────────────────────── */

const WIZARD_STEPS: {
  id: WizardStep;
  n: number;
  title: string;
  badge: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
}[] = [
  { id: "connect", n: 1, title: "Connect", badge: "Step 1", icon: Plug },
  { id: "plans", n: 2, title: "Plans & verify", badge: "Step 2", icon: FileText },
  { id: "status", n: 3, title: "Test event", badge: "Step 3", icon: CheckCircle2 },
];

/**
 * Segmented step card — mirrors `OptionCard` in connect-dialog. Three of
 * these glued together by `border + divide-x` form the navigation strip
 * at the top of the wizard.
 */
function StepOptionCard({
  icon: Icon,
  title,
  badge,
  active,
  completed,
  disabled,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  badge: string;
  active: boolean;
  completed: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  // Visual hierarchy:
  //  - completed (and not the current step) → green wash + check overlay
  //  - active (current step)               → secondary fill, normal icon
  //  - upcoming                            → dimmed, hover only
  const tone = active
    ? "bg-secondary"
    : completed
      ? "bg-emerald-500/8 hover:bg-emerald-500/12"
      : "hover:bg-secondary/60";

  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`group relative flex flex-1 flex-col items-center justify-center gap-3 py-4 transition-colors ${tone} ${
        disabled ? "cursor-not-allowed opacity-50 hover:bg-transparent" : ""
      }`}
      aria-current={active ? "step" : undefined}
    >
      {completed && !active && (
        <span className="absolute right-2 top-2 inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-background">
          <Check className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
      <Icon
        className={`h-6 w-6 ${
          completed && !active
            ? "text-emerald-600 dark:text-emerald-400"
            : active
              ? "text-muted-foreground"
              : "text-muted-foreground/60 group-hover:text-muted-foreground"
        }`}
        strokeWidth={1.5}
      />
      <div className="flex flex-col items-center gap-1.5">
        <span
          className={`text-[13px] leading-[18px] ${
            active ? "text-foreground" : "text-foreground/90"
          }`}
        >
          {title}
        </span>
        <span
          className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${
            completed && !active
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
              : "bg-brand/10 text-brand"
          }`}
        >
          {completed && !active ? "Done" : badge}
        </span>
      </div>
    </button>
  );
}

function AutumnWizardDialog({
  open,
  onOpenChange,
  initialStep,
  mode,
  projectId,
  apiUrl,
  status,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialStep: WizardStep;
  /**
   * "wizard" → segmented step strip, used when the integration is being
   * configured for the first time or finishing setup.
   *
   * "manage" → compact view (telemetry + disconnect only). The wizard would
   * just be noise once the bridge is fully active.
   */
  mode: "wizard" | "manage";
  projectId: string;
  apiUrl: string;
  status: AutumnStatusResponse | undefined;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<WizardStep>(initialStep);

  // Reset step every time the dialog re-opens so the entry point is
  // recomputed against the latest connection state.
  useEffect(() => {
    if (open) setStep(initialStep);
  }, [open, initialStep]);

  const [apiKey, setApiKey] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [createdSummary, setCreatedSummary] = useState<{
    createdFeatures?: number;
    reusedFeatures?: number;
  } | null>(null);
  // Custom confirmation dialog state — replaces window.confirm() so we get
  // a styled, themed confirm UI instead of the browser's native modal.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const connectMutation = useMutation({
    mutationFn: async (key: string) => {
      const res = await fetch(`${apiUrl}/v1/integrations/${projectId}/autumn`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Failed (${res.status})`);
      return json.data as {
        status: string;
        featureIds: AutumnStatusResponse["featureIds"];
        env: AutumnStatusResponse["env"];
        createdFeatures?: number;
        reusedFeatures?: number;
      };
    },
    onSuccess: (data) => {
      setApiKey("");
      setSubmitError(null);
      setCreatedSummary({
        createdFeatures: data.createdFeatures,
        reusedFeatures: data.reusedFeatures,
      });
      onChanged();
      // Auto-advance to step 2 after a beat so the user sees the success state.
      const t = setTimeout(() => setStep("plans"), 1000);
      return () => clearTimeout(t);
    },
    onError: (err: Error) => {
      setSubmitError(err.message);
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/v1/integrations/${projectId}/autumn`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
    },
    onSuccess: () => {
      onChanged();
      onOpenChange(false);
    },
  });

  // Real verify call — asks Autumn whether ANY polpo_* feature is attached
  // to ANY of the builder's plans. The bridge is "ready" with as little as
  // one feature on one plan, by design (different products bill on different
  // dimensions). When the call comes back ready, we advance to step 3.
  const [verifyResult, setVerifyResult] = useState<VerifyData | null>(null);
  const verifyMutation = useMutation({
    mutationFn: async (): Promise<VerifyData> => {
      const res = await fetch(
        `${apiUrl}/v1/integrations/${projectId}/autumn/verify`,
        { credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Failed (${res.status})`);
      return json.data as VerifyData;
    },
    onSuccess: (data) => {
      setVerifyResult(data);
      onChanged();
    },
  });

  // Test event — fires a synthetic track call so the builder can prove the
  // bridge end-to-end before real users hit it.
  const testEventMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(
        `${apiUrl}/v1/integrations/${projectId}/autumn/test`,
        { method: "POST", credentials: "include" },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `Failed (${res.status})`);
      return json.data as { customerId: string; featureId: string; value: number };
    },
    onSuccess: () => {
      onChanged();
      // Re-verify after a test event so the dashboard reflects new state.
      queryClient.invalidateQueries({ queryKey: ["autumn-integration", projectId] });
    },
  });

  // Step navigation guard: never let the user jump forward past their
  // current progress (you can't "verify" before you "connect").
  // Going back to a completed step is fine — informational only.
  const order: WizardStep[] = ["connect", "plans", "status"];
  const connected = !!status?.connected;
  const eventsFired = (status?.eventsCount ?? 0) > 0;
  function canJumpTo(target: WizardStep): boolean {
    const targetIdx = order.indexOf(target);
    const currentIdx = order.indexOf(step);
    if (targetIdx <= currentIdx) return true;
    if (target === "plans") return connected || connectMutation.isSuccess;
    if (target === "status") return connected;
    return false;
  }

  // Completion state per step — drives the green "Done" badge in the strip
  // and the Connect-step "already connected" panel.
  const completedSteps: Record<WizardStep, boolean> = {
    connect: connected || connectMutation.isSuccess,
    plans: !!verifyResult?.ready || eventsFired,
    status: eventsFired || testEventMutation.isSuccess,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl bg-card ring-foreground/15 shadow-2xl">
        <DialogHeader className="pb-1">
          <DialogTitle className="text-base font-normal">
            <span className="inline-flex items-center gap-3">
              <img
                src="/logos/autumn-icon.svg"
                alt=""
                className="h-9 w-9 rounded"
              />
              {mode === "manage" || connected ? (
                <span>
                  Manage <span className="font-semibold">Autumn</span> integration
                </span>
              ) : (
                <span>
                  Connect <span className="font-semibold">Autumn</span>
                </span>
              )}
            </span>
          </DialogTitle>
          <DialogDescription className="text-sm">
            Per-end-user billing pass-through for your AI app. Plans, pricing,
            balance UIs stay in Autumn — Polpo is the rail.{" "}
            <a
              href="https://docs.useautumn.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-foreground hover:underline underline-offset-4"
            >
              Read the docs
            </a>
          </DialogDescription>
        </DialogHeader>

        {mode === "manage" ? (
          <ManageView
            status={status}
            onSendTestEvent={() => testEventMutation.mutate()}
            testPending={testEventMutation.isPending}
            testError={
              testEventMutation.error instanceof Error
                ? testEventMutation.error.message
                : null
            }
            testResult={testEventMutation.data ?? null}
          />
        ) : (
          <>
            {/* Segmented step strip — three squared cards glued together with
                a single outer border + vertical dividers. Same shape as the
                ConnectDialog tab strip. */}
            <div className="mt-2 flex items-stretch overflow-hidden border border-border divide-x divide-border">
              {WIZARD_STEPS.map((s) => (
                <StepOptionCard
                  key={s.id}
                  icon={s.icon}
                  title={s.title}
                  badge={s.badge}
                  active={step === s.id}
                  completed={completedSteps[s.id]}
                  disabled={!canJumpTo(s.id)}
                  onClick={() => setStep(s.id)}
                />
              ))}
            </div>

            {/* Per-step content — 240px label column on the left, content
                on the right. min-h keeps dialog height stable across steps. */}
            <div className="mt-6 min-h-[160px]">
              {step === "connect" && (
                <ConnectStep
                  apiKey={apiKey}
                  setApiKey={setApiKey}
                  submitError={submitError}
                  isPending={connectMutation.isPending}
                  isSuccess={connectMutation.isSuccess}
                  alreadyConnected={connected && !connectMutation.isSuccess}
                  env={status?.env}
                  createdSummary={createdSummary}
                  featureIds={status?.featureIds ?? connectMutation.data?.featureIds}
                  onSubmit={(k) => connectMutation.mutate(k)}
                />
              )}

              {step === "plans" && (
                <PlansStep
                  featureIds={status?.featureIds ?? connectMutation.data?.featureIds}
                  onVerify={() => verifyMutation.mutate()}
                  verifyPending={verifyMutation.isPending}
                  verifyError={
                    verifyMutation.error instanceof Error
                      ? verifyMutation.error.message
                      : null
                  }
                  verifyResult={verifyResult}
                />
              )}

              {step === "status" && (
                <StatusStep
                  status={status}
                  onSendTestEvent={() => testEventMutation.mutate()}
                  testPending={testEventMutation.isPending}
                  testError={
                    testEventMutation.error instanceof Error
                      ? testEventMutation.error.message
                      : null
                  }
                  testResult={testEventMutation.data ?? null}
                />
              )}
            </div>
          </>
        )}

        <DialogFooter className="mt-2 flex items-center justify-between gap-3 sm:justify-between">
          {connected ? (
            <button
              type="button"
              onClick={() => setConfirmDisconnect(true)}
              disabled={disconnectMutation.isPending}
              className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-50"
            >
              {disconnectMutation.isPending && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              Disconnect
            </button>
          ) : (
            <span />
          )}
          <DialogClose>
            <button className="rounded-md border border-border px-4 py-2 text-sm hover:border-foreground/30 transition-colors">
              Close
            </button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>

      {/* Custom confirmation modal for disconnect — replaces window.confirm */}
      <Dialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <DialogContent className="sm:max-w-md bg-card ring-foreground/15">
          <DialogHeader>
            <DialogTitle className="text-base">
              Disconnect Autumn?
            </DialogTitle>
            <DialogDescription>
              Polpo will stop firing usage events. Your plans, customers, and
              balances in Autumn are not affected — you can reconnect at any
              time by pasting the same key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => setConfirmDisconnect(false)}
              className="rounded border border-border px-4 py-2 text-sm hover:border-foreground/30 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDisconnect(false);
                disconnectMutation.mutate();
              }}
              disabled={disconnectMutation.isPending}
              className="inline-flex items-center gap-2 rounded bg-destructive text-destructive-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {disconnectMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Disconnect
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

/* ── Manage view (compact, when integration is fully active) ─────── */

function ManageView({
  status,
  onSendTestEvent,
  testPending,
  testError,
  testResult,
}: {
  status: AutumnStatusResponse | undefined;
  onSendTestEvent: () => void;
  testPending: boolean;
  testError: string | null;
  testResult: { customerId: string; featureId: string; value: number } | null;
}) {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex items-center gap-2 border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">
          Bridge active
          {status?.env && status.env !== "unknown" ? ` · ${status.env}` : ""}
        </span>
        <span className="opacity-80">
          — Polpo is firing usage events to your Autumn account.
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat label="Events fired" value={String(status?.eventsCount ?? 0)} />
        <Stat
          label="Errors"
          value={String(status?.errorsCount ?? 0)}
          tone={status?.errorsCount && status.errorsCount > 0 ? "warn" : "ok"}
        />
        <Stat
          label="Last event"
          value={status?.lastUsedAt ? formatRelative(status.lastUsedAt) : "—"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onSendTestEvent}
          disabled={testPending}
          className="inline-flex items-center gap-2 rounded border border-foreground/20 px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          {testPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plug className="h-3.5 w-3.5" />
          )}
          {testResult ? "Send another" : "Send test event"}
        </button>
        <a
          href="https://app.useautumn.com/customers"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Open Autumn customers
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      {testError && (
        <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{testError}</span>
        </div>
      )}

      {testResult && (
        <div className="flex items-start gap-2 border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-medium">Test event delivered</div>
            <div className="mt-0.5 font-mono opacity-80">
              {testResult.featureId} += {testResult.value} for{" "}
              {testResult.customerId}
            </div>
          </div>
        </div>
      )}

      {status?.lastError && (
        <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="font-medium">Last error</div>
            <div className="mt-0.5 break-words font-mono text-[11px] opacity-80">
              {status.lastError}
            </div>
            {status.lastErrorAt && (
              <div className="mt-0.5 text-[11px] opacity-70">
                {formatRelative(status.lastErrorAt)}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Step 1: Connect ────────────────────────────────────── */

function ConnectStep({
  apiKey,
  setApiKey,
  submitError,
  isPending,
  isSuccess,
  alreadyConnected,
  env,
  createdSummary,
  featureIds,
  onSubmit,
}: {
  apiKey: string;
  setApiKey: (v: string) => void;
  submitError: string | null;
  isPending: boolean;
  isSuccess: boolean;
  /** True when the dialog was opened on a project that's already connected
   * (status.connected) but the user navigated back to Step 1 to inspect or
   * rotate the key. We never expose the plaintext key. */
  alreadyConnected: boolean;
  env: AutumnStatusResponse["env"];
  createdSummary: { createdFeatures?: number; reusedFeatures?: number } | null;
  featureIds: AutumnStatusResponse["featureIds"];
  onSubmit: (key: string) => void;
}) {
  // Already connected from a previous session — show a "Connected" panel
  // (we never fetched the plaintext key) instead of the empty form. The
  // disconnect lives in the dialog footer, so this view is purely
  // informational + a key-rotation affordance.
  if (alreadyConnected) {
    return (
      <div className="flex gap-6">
        <div className="flex w-[240px] shrink-0 flex-col gap-2">
          <p className="text-sm font-medium leading-6 text-foreground">Connected</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Your Autumn key is already linked. Drop a new key below to rotate
            it, or hit Disconnect at the bottom of this dialog.
          </p>
          <a
            href="https://app.useautumn.com/dev?tab=api_keys"
            target="_blank"
            rel="noreferrer"
            className="self-start text-xs font-medium text-foreground hover:underline underline-offset-4"
          >
            Manage keys in Autumn →
          </a>
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="flex items-start gap-2.5 border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <p className="font-medium">
                Connected{env && env !== "unknown" ? ` to ${env}` : ""}.
              </p>
              <p className="mt-0.5 text-xs opacity-80">
                For security we never display the saved key. Paste a new one
                below to overwrite it.
              </p>
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!apiKey.trim()) return;
              onSubmit(apiKey.trim());
            }}
            className="flex items-stretch gap-2"
          >
            <input
              id="autumn-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="am_sk_test_… or am_sk_live_… (rotate)"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 border border-border bg-transparent px-3 py-2.5 text-sm font-mono focus:border-foreground/30 focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={!apiKey.trim() || isPending}
              className="inline-flex items-center gap-2 rounded border border-border px-4 py-2.5 text-sm font-medium hover:border-foreground/30 transition-colors disabled:opacity-50"
            >
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Rotate
            </button>
          </form>
          {submitError && (
            <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>{submitError}</span>
            </div>
          )}
          {featureIds && <FeatureIdCards featureIds={featureIds} />}
        </div>
      </div>
    );
  }

  if (isSuccess && createdSummary) {
    const total =
      (createdSummary.createdFeatures ?? 0) + (createdSummary.reusedFeatures ?? 0);
    return (
      <div className="flex gap-6">
        <div className="flex w-[240px] shrink-0 flex-col gap-2">
          <p className="text-sm font-medium leading-6 text-foreground">Connected</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Polpo is wired up to your Autumn account. The features below are ready
            to be attached to a plan.
          </p>
        </div>
        <div className="flex-1 min-w-0 flex flex-col gap-3">
          <div className="flex items-start gap-2.5 border border-brand/30 bg-brand/5 p-3 text-sm">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0">
              <p className="font-medium text-foreground">
                Connected. {total > 0
                  ? `${total} feature${total === 1 ? "" : "s"} ready in your Autumn account.`
                  : "Polpo is ready to fire events."}
              </p>
              {(createdSummary.createdFeatures ?? 0) > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Created {createdSummary.createdFeatures} new
                  {createdSummary.reusedFeatures
                    ? `, reused ${createdSummary.reusedFeatures}`
                    : ""}
                  .
                </p>
              )}
            </div>
          </div>
          {featureIds && <FeatureIdCards featureIds={featureIds} />}
          <p className="text-xs text-muted-foreground">Moving to the next step…</p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!apiKey.trim()) return;
        onSubmit(apiKey.trim());
      }}
      className="flex gap-6"
    >
      <div className="flex w-[240px] shrink-0 flex-col gap-2">
        <p className="text-sm font-medium leading-6 text-foreground">Autumn secret key</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Polpo will fire usage events to your Autumn so you can charge your
          end-users. Plans, pricing, and balance UI stay in Autumn — Polpo is
          the rail.
        </p>
        <a
          href="https://app.useautumn.com/dev?tab=api_keys"
          target="_blank"
          rel="noreferrer"
          className="self-start text-xs font-medium text-foreground hover:underline underline-offset-4"
        >
          Get your secret key →
        </a>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div className="flex items-stretch gap-2">
          <input
            id="autumn-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="am_sk_test_… or am_sk_live_…"
            autoComplete="off"
            spellCheck={false}
            className="flex-1 border border-border bg-transparent px-3 py-2.5 text-sm font-mono focus:border-foreground/30 focus:outline-none transition-colors"
          />
          <button
            type="submit"
            disabled={!apiKey.trim() || isPending}
            className="inline-flex items-center gap-2 bg-foreground text-background px-5 py-2.5 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Connect
          </button>
        </div>

        {submitError && (
          <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{submitError}</span>
          </div>
        )}
      </div>
    </form>
  );
}

/* ── Step 2: Plans ──────────────────────────────────────── */

interface VerifyData {
  ready: boolean;
  totalPlans: number;
  attached: string[];
  unattached: string[];
  plansWithPolpoFeatures: Array<{ id: string; name: string; featureIds: string[] }>;
}

function PlansStep({
  featureIds,
  onVerify,
  verifyPending,
  verifyError,
  verifyResult,
}: {
  featureIds: AutumnStatusResponse["featureIds"];
  onVerify: () => void;
  verifyPending: boolean;
  verifyError: string | null;
  verifyResult: VerifyData | null;
}) {
  return (
    <div className="flex gap-6">
      <div className="flex w-[240px] shrink-0 flex-col gap-2">
        <p className="text-sm font-medium leading-6 text-foreground">Create a plan</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Polpo just created 3 features in your Autumn account. Attach{" "}
          <span className="font-medium text-foreground">at least one</span> of
          them to <span className="font-medium text-foreground">at least one</span>{" "}
          plan — that's enough to bridge billing.
        </p>
        <a
          href="https://docs.useautumn.com/products/create-product"
          target="_blank"
          rel="noreferrer"
          className="self-start text-xs font-medium text-foreground hover:underline underline-offset-4"
        >
          Plan setup guide →
        </a>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {featureIds && <FeatureIdCards featureIds={featureIds} />}
        {!featureIds && (
          <div className="border border-border bg-background p-6 text-center text-sm text-muted-foreground">
            Connect Autumn first to see the feature IDs.
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-3">
          <a
            href="https://app.useautumn.com/products?tab=products"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity"
          >
            Open Autumn Plans
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={onVerify}
            disabled={verifyPending}
            className="inline-flex items-center gap-2 rounded border border-border px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors disabled:opacity-50"
          >
            {verifyPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Check setup
          </button>
        </div>

        {verifyError && (
          <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{verifyError}</span>
          </div>
        )}

        {verifyResult && !verifyResult.ready && (
          <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">No polpo features attached yet</div>
              <div className="mt-0.5 opacity-80">
                Found {verifyResult.totalPlans} plan
                {verifyResult.totalPlans === 1 ? "" : "s"} in your Autumn
                account, but none of them include a{" "}
                <code className="font-mono">polpo_*</code> feature. Attach at
                least one and click Verify again.
              </div>
            </div>
          </div>
        )}

        {verifyResult && verifyResult.ready && (
          <div className="flex items-start gap-2 border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">
                Bridge ready — {verifyResult.attached.length} feature
                {verifyResult.attached.length === 1 ? "" : "s"} attached
              </div>
              {verifyResult.plansWithPolpoFeatures.length > 0 && (
                <div className="mt-0.5 opacity-80">
                  On{" "}
                  {verifyResult.plansWithPolpoFeatures
                    .map((p) => p.name)
                    .join(", ")}
                  . Move to Step 3 to fire a test event.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Step 3: Status / Manage ────────────────────────────── */

function StatusStep({
  status,
  onSendTestEvent,
  testPending,
  testError,
  testResult,
}: {
  status: AutumnStatusResponse | undefined;
  onSendTestEvent: () => void;
  testPending: boolean;
  testError: string | null;
  testResult: { customerId: string; featureId: string; value: number } | null;
}) {
  return (
    <div className="flex gap-6">
      <div className="flex w-[240px] shrink-0 flex-col gap-2">
        <p className="text-sm font-medium leading-6 text-foreground">Test the bridge</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Fire a synthetic event to <span className="font-mono">polpo_completions</span> for{" "}
          <span className="font-mono">polpo-test-customer</span>. Proves the
          rail end-to-end before real users hit it.
        </p>
        <a
          href="https://app.useautumn.com/customers"
          target="_blank"
          rel="noreferrer"
          className="self-start text-xs font-medium text-foreground hover:underline underline-offset-4"
        >
          Open Autumn customers →
        </a>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Events fired" value={String(status?.eventsCount ?? 0)} />
          <Stat
            label="Errors"
            value={String(status?.errorsCount ?? 0)}
            tone={status?.errorsCount && status.errorsCount > 0 ? "warn" : "ok"}
          />
          <Stat
            label="Last event"
            value={status?.lastUsedAt ? formatRelative(status.lastUsedAt) : "—"}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onSendTestEvent}
            disabled={testPending}
            className="inline-flex items-center gap-2 bg-foreground text-background px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {testPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            Send test event
          </button>
        </div>

        {testError && (
          <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{testError}</span>
          </div>
        )}

        {testResult && (
          <div className="flex items-start gap-2 border border-emerald-500/30 bg-emerald-500/5 p-2.5 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">Test event delivered</div>
              <div className="mt-0.5 font-mono opacity-80">
                {testResult.featureId} += {testResult.value} for{" "}
                {testResult.customerId}
              </div>
            </div>
          </div>
        )}

        {status?.lastError && (
          <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="font-medium">Last error</div>
              <div className="mt-0.5 break-words font-mono text-[11px] opacity-80">
                {status.lastError}
              </div>
              {status.lastErrorAt && (
                <div className="mt-0.5 text-[11px] opacity-70">
                  {formatRelative(status.lastErrorAt)}
                </div>
              )}
            </div>
          </div>
        )}

        {status?.featureIds && <FeatureIdCards featureIds={status.featureIds} />}
      </div>
    </div>
  );
}

/* ── Shared bits ────────────────────────────────────────── */

/**
 * Stack of CopyCards — one per polpo_* feature ID. Same visual treatment
 * as connect-dialog's API key / URL row, swapping the value-list for the
 * three feature ids the user needs to wire up in Autumn.
 */
function FeatureIdCards({
  featureIds,
}: {
  featureIds: NonNullable<AutumnStatusResponse["featureIds"]>;
}) {
  return (
    <div className="flex flex-col gap-2">
      <CopyCard label="polpo_completions feature" value={featureIds.completions} />
      <CopyCard label="polpo_tasks feature" value={featureIds.tasks} />
      <CopyCard label="polpo_inference_usd feature" value={featureIds.inferenceUsd} />
    </div>
  );
}

/** Compact stat tile for the integration telemetry panel. */
function Stat({ label, value, tone = "ok" }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div className="border border-border bg-background p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`mt-1 text-lg font-semibold ${tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}

/** Coarse relative-time format — matches the format used elsewhere in the dashboard. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* ── Webhooks Tab ─────────────────────────────────────────── */

function WebhooksTab({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [formUrl, setFormUrl] = useState("");
  // Wire format: a Set of event patterns. May contain "*", "task:*", or
  // specific keys like "task:created". The handlers below maintain the
  // invariant that wildcards and their children are never both present.
  const [selectedEvents, setSelectedEvents] = useState<Set<string>>(
    () => new Set<string>(["*"]),
  );
  // Pending webhook deletion — null when no confirm is open. Mirrors the
  // Autumn disconnect flow so destructive actions always go through a
  // styled modal instead of window.confirm().
  const [pendingDelete, setPendingDelete] = useState<Webhook | null>(null);
  // Webhook currently open in the delivery inspector dialog. Same pattern as
  // pendingDelete — null means closed.
  const [pendingInspect, setPendingInspect] = useState<Webhook | null>(null);
  // When non-null, the form is in "edit" mode for an existing row. The URL
  // and event selection are pre-filled from `editing` and submit calls
  // PATCH instead of POST.
  const [editing, setEditing] = useState<Webhook | null>(null);

  function openCreate() {
    setEditing(null);
    setFormUrl("");
    setSelectedEvents(new Set(["*"]));
    setShowForm(true);
  }
  function openEdit(wh: Webhook) {
    setEditing(wh);
    setFormUrl(wh.url);
    setSelectedEvents(new Set(wh.events));
    setShowForm(true);
  }
  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setFormUrl("");
    setSelectedEvents(new Set(["*"]));
  }

  const { data: webhooks = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ["webhooks", projectId],
    queryFn: () =>
      fetchDataPlane<{ ok: boolean; data: Webhook[] }>(projectId, "/v1/webhooks").then(
        (r) => r.data ?? []
      ),
  });

  // Single mutation that creates *or* updates depending on whether the form
  // was opened from an existing row. Keeps the success path identical so
  // the form clears and closes the same way in both flows.
  const upsertMutation = useMutation({
    mutationFn: (data: { url: string; events: string[]; editingId: string | null }) =>
      data.editingId
        ? mutateDataPlane(projectId, `/v1/webhooks/${data.editingId}`, {
            method: "PATCH",
            body: { url: data.url, events: data.events },
          })
        : mutateDataPlane(projectId, "/v1/webhooks", {
            method: "POST",
            body: { url: data.url, events: data.events },
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectId] });
      closeForm();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (webhookId: string) =>
      mutateDataPlane(projectId, `/v1/webhooks/${webhookId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["webhooks", projectId] });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const events = Array.from(selectedEvents);
    if (events.length === 0) return;
    upsertMutation.mutate({
      url: formUrl.trim(),
      events,
      editingId: editing?.id ?? null,
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-14 rounded-lg bg-secondary/30 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Webhooks</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Receive HTTP POST notifications when events occur in this project.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {!showForm && (
            <button
              onClick={openCreate}
              className="inline-flex items-center gap-2 bg-foreground text-background px-3 py-1.5 text-xs font-medium transition-all hover:opacity-90"
            >
              <Plus className="h-3 w-3" />
              Add webhook
            </button>
          )}
        </div>
      </div>

      {/* Add form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mt-4 rounded-lg border border-border bg-card p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Endpoint URL
            </label>
            <input
              type="url"
              value={formUrl}
              onChange={(e) => setFormUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              required
              className="w-full border border-border bg-transparent px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none transition-colors"
            />
          </div>
          <EventSelector
            selected={selectedEvents}
            onChange={setSelectedEvents}
          />
          {upsertMutation.error && (
            <p className="text-xs text-destructive">
              {(upsertMutation.error as Error).message}
            </p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={
                upsertMutation.isPending ||
                !formUrl.trim() ||
                selectedEvents.size === 0
              }
              className="inline-flex items-center gap-2 bg-foreground text-background px-3 py-1.5 text-xs font-medium transition-all hover:opacity-90 disabled:opacity-50"
            >
              {upsertMutation.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : editing ? (
                "Save changes"
              ) : (
                "Create"
              )}
            </button>
            <button
              type="button"
              onClick={closeForm}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Webhooks list */}
      {webhooks.length > 0 ? (
        <div className="mt-4 rounded-lg border border-border overflow-hidden">
          {webhooks.map((wh) => (
            <div
              key={wh.id}
              className="flex items-center justify-between border-b border-border last:border-0 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs font-medium truncate">{wh.url}</p>
                <div className="mt-1 flex items-center gap-2">
                  {wh.events.map((ev) => (
                    <span
                      key={ev}
                      className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground"
                    >
                      {ev}
                    </span>
                  ))}
                </div>
              </div>
              <div className="ml-4 flex shrink-0 items-center gap-3">
                <button
                  onClick={() => setPendingInspect(wh)}
                  className="text-muted-foreground/50 hover:text-foreground transition-colors"
                  aria-label="Inspect deliveries"
                  title="Inspect deliveries"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => openEdit(wh)}
                  className="text-muted-foreground/50 hover:text-foreground transition-colors"
                  aria-label="Edit webhook"
                  title="Edit webhook"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setPendingDelete(wh)}
                  disabled={deleteMutation.isPending}
                  className="text-muted-foreground/50 hover:text-destructive transition-colors"
                  aria-label="Delete webhook"
                  title="Delete webhook"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !showForm ? (
        <div className="mt-4 rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
          No webhooks configured.
        </div>
      ) : null}

      {/* Confirm-delete modal — same pattern as the Autumn disconnect dialog. */}
      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent className="sm:max-w-md bg-card ring-foreground/15">
          <DialogHeader>
            <DialogTitle className="text-base">Delete webhook?</DialogTitle>
            <DialogDescription>
              <span className="block">
                Polpo will stop sending events to this endpoint. You can
                always re-add it.
              </span>
              {pendingDelete && (
                <span className="mt-2 block break-all rounded border border-border bg-secondary/40 px-2 py-1.5 font-mono text-[11px] text-foreground">
                  {pendingDelete.url}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-end">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="rounded border border-border px-4 py-2 text-sm hover:border-foreground/30 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (!pendingDelete) return;
                deleteMutation.mutate(pendingDelete.id);
                setPendingDelete(null);
              }}
              disabled={deleteMutation.isPending}
              className="inline-flex items-center gap-2 rounded bg-destructive text-destructive-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {deleteMutation.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              )}
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delivery inspector — opens the new WebhookDeliveries panel. */}
      <Dialog
        open={!!pendingInspect}
        onOpenChange={(v) => !v && setPendingInspect(null)}
      >
        <DialogContent className="sm:max-w-3xl bg-card ring-foreground/15">
          <DialogHeader>
            <DialogTitle className="text-base">Webhook deliveries</DialogTitle>
            <DialogDescription>
              Last 50 attempts. Auto-refreshes every 5s.
            </DialogDescription>
          </DialogHeader>
          {pendingInspect && (
            <WebhookDeliveries
              projectId={projectId}
              webhook={pendingInspect}
            />
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

/* ── Webhook event selector (hierarchical multi-checkbox) ─────────── */

/**
 * Tree-shaped event picker: a top-level "All events" toggle, then one
 * collapsible group per namespace (task, mission, agent, …) with a "Select
 * all" mini-checkbox in its header and individual event checkboxes inside.
 *
 * The wire format is just an array of event patterns — the same one the
 * data plane already accepts (`task:*`, `mission:completed`, `*`, …) — so
 * we never have to model "expansion" on the backend. The state below
 * keeps wildcards and their children mutually exclusive, otherwise we'd
 * end up with confusingly-redundant payloads like `["task:*","task:created"]`.
 */
function EventSelector({
  selected,
  onChange,
}: {
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set());
  // Source of truth lives in `@polpo-ai/core`'s EVENT_CATALOG and is served
  // by the cloud at `/v1/events/catalog` (cached 1h). Fetching dynamically
  // keeps the picker in lockstep with whatever the runtime can actually
  // emit — no more hand-mirrored arrays here.
  const { data: catalog = [], isLoading } = useEventCatalog();
  const totalEvents = catalog.reduce((acc, g) => acc + g.events.length, 0);
  const allChecked = selected.has("*");

  // Count concrete events covered by the current selection — used for the
  // "X of Y selected" hint and to decide group header tri-state.
  function countSelectedInGroup(ns: string, events: ReadonlyArray<{ key: string }>) {
    if (selected.has("*") || selected.has(`${ns}:*`)) return events.length;
    return events.filter((e) => selected.has(`${ns}:${e.key}`)).length;
  }
  const totalSelected = allChecked
    ? totalEvents
    : catalog.reduce(
        (acc, g) => acc + countSelectedInGroup(g.ns, g.events),
        0,
      );

  function toggleAll(next: boolean) {
    onChange(next ? new Set(["*"]) : new Set());
  }

  function toggleGroup(ns: string, events: ReadonlyArray<{ key: string }>, next: boolean) {
    const out = new Set(selected);
    // Removing the global wildcard is implicit when we move from "everything"
    // to a finer selection — expand it into the *other* groups so the user
    // doesn't lose them.
    if (out.has("*")) {
      out.delete("*");
      for (const g of catalog) if (g.ns !== ns) out.add(`${g.ns}:*`);
    }
    // Drop any individual children we might have left behind, then set the
    // group wildcard (or remove it on the off-toggle).
    for (const e of events) out.delete(`${ns}:${e.key}`);
    out.delete(`${ns}:*`);
    if (next) out.add(`${ns}:*`);
    onChange(out);
  }

  function toggleEvent(ns: string, key: string, next: boolean) {
    const out = new Set(selected);
    // Same expansion logic as toggleGroup, then expand the group's own
    // wildcard into per-event entries so we can remove just one.
    if (out.has("*")) {
      out.delete("*");
      for (const g of catalog) if (g.ns !== ns) out.add(`${g.ns}:*`);
    }
    if (out.has(`${ns}:*`)) {
      out.delete(`${ns}:*`);
      const group = catalog.find((g) => g.ns === ns);
      if (group) for (const e of group.events) out.add(`${ns}:${e.key}`);
    }
    const fq = `${ns}:${key}`;
    if (next) out.add(fq);
    else out.delete(fq);
    onChange(out);
  }

  function toggleOpen(ns: string) {
    const next = new Set(openGroups);
    if (next.has(ns)) next.delete(ns);
    else next.add(ns);
    setOpenGroups(next);
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="block text-xs font-medium text-muted-foreground">
          Events
        </label>
        <span className="text-[11px] text-muted-foreground">
          {totalSelected} of {totalEvents} selected
        </span>
      </div>

      <div className="border border-border">
        {/* All events */}
        <label className="flex cursor-pointer items-center gap-3 border-b border-border px-3 py-2.5 transition-colors hover:bg-secondary/40">
          <Checkbox checked={allChecked} indeterminate={false} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-none">All events</p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Receive every event Polpo emits — overrides the per-namespace
              selection below.
            </p>
          </div>
          <input
            type="checkbox"
            checked={allChecked}
            onChange={(e) => toggleAll(e.target.checked)}
            className="sr-only"
            aria-label="All events"
          />
        </label>

        {/* Namespace groups */}
        <div className="max-h-[320px] overflow-y-auto">
          {isLoading && catalog.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              Loading event catalog…
            </div>
          )}
          {catalog.map((group) => {
            const isOpen = openGroups.has(group.ns);
            const groupCount = countSelectedInGroup(group.ns, group.events);
            const groupAll = groupCount === group.events.length && groupCount > 0;
            const groupSome = groupCount > 0 && !groupAll;
            const Chevron = isOpen ? ChevronDown : ChevronRight;
            return (
              <div key={group.ns} className="border-b border-border last:border-b-0">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleOpen(group.ns)}
                    className="inline-flex items-center text-muted-foreground hover:text-foreground"
                    aria-label={isOpen ? "Collapse" : "Expand"}
                  >
                    <Chevron className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </button>

                  <label className="flex flex-1 cursor-pointer items-center gap-3">
                    <Checkbox
                      checked={groupAll || allChecked}
                      indeterminate={!allChecked && groupSome}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-none">
                        {group.label}
                        <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
                          {group.ns}:*
                        </span>
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {group.description}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {allChecked
                        ? `${group.events.length}/${group.events.length}`
                        : `${groupCount}/${group.events.length}`}
                    </span>
                    <input
                      type="checkbox"
                      checked={groupAll || allChecked}
                      onChange={(e) =>
                        toggleGroup(group.ns, group.events, e.target.checked)
                      }
                      disabled={allChecked}
                      className="sr-only"
                      aria-label={`Select all ${group.label} events`}
                    />
                  </label>
                </div>

                {isOpen && (
                  <div className="grid grid-cols-1 gap-y-1 border-t border-border bg-secondary/20 px-3 py-2 sm:grid-cols-2">
                    {group.events.map((ev) => {
                      const checked =
                        allChecked ||
                        selected.has(`${group.ns}:*`) ||
                        selected.has(`${group.ns}:${ev.key}`);
                      return (
                        <label
                          key={ev.key}
                          className="flex cursor-pointer items-start gap-2 px-1.5 py-1.5 text-xs hover:bg-secondary/60"
                          title={ev.description}
                        >
                          <Checkbox checked={checked} indeterminate={false} compact />
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono text-[12px] text-foreground">
                              {group.ns}:{ev.key}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {ev.description}
                            </span>
                          </span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              toggleEvent(group.ns, ev.key, e.target.checked)
                            }
                            className="sr-only"
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {totalSelected === 0 && (
        <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          Select at least one event to receive notifications.
        </p>
      )}
    </div>
  );
}

/**
 * Minimal styled checkbox — supports tri-state (`indeterminate`) for the
 * group headers when a subset of children is selected. We render a custom
 * box because native indeterminate styling is browser-dependent and ugly.
 */
function Checkbox({
  checked,
  indeterminate,
  compact,
}: {
  checked: boolean;
  indeterminate: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-3.5 w-3.5" : "h-4 w-4";
  if (indeterminate) {
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 items-center justify-center border ${size} border-foreground bg-foreground/10 text-foreground`}
      >
        <Minus className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  if (checked) {
    return (
      <span
        aria-hidden
        className={`inline-flex shrink-0 items-center justify-center border ${size} border-foreground bg-foreground text-background`}
      >
        <Check className="h-2.5 w-2.5" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 ${size} border border-border bg-background`}
    />
  );
}
