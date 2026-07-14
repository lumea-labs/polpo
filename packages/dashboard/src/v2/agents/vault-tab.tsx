"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "../host";
import { Plus, Trash, CircleNotch, Lock } from "@phosphor-icons/react/dist/ssr";
import { usePolpoClient } from "../host";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { EmptyBox } from "../ui/bits";
import {
  TYPE_OPTIONS,
  TYPE_FIELDS,
  typeLabel,
  buildCredentials,
  type VaultType,
} from "../host";

type VaultEntry = {
  service: string;
  type: string;
  label?: string | null;
  keys?: string[];
};

const INPUT =
  "h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/40 focus:border-ring/50 focus:outline-none";

export function VaultTab({
  projectId,
  agentName,
  initialEntries,
}: {
  projectId: string;
  agentName: string;
  initialEntries: VaultEntry[];
}) {
  const polpo = usePolpoClient(projectId);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const { data: entries = [] } = useQuery({
    queryKey: ["vault", projectId, agentName],
    queryFn: () =>
      polpo.listVaultEntries(agentName) as unknown as Promise<VaultEntry[]>,
    initialData: initialEntries,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["vault", projectId, agentName] });

  const remove = useMutation({
    mutationFn: (service: string) => polpo.removeVaultEntry(agentName, service),
    onSuccess: async () => {
      setConfirm(null);
      await invalidate();
    },
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-[13px] text-muted-foreground">
          Encrypted secrets this agent can read at runtime. Values are write-only.
        </p>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={15} weight="bold" />
            Add credential
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-4">
          <AddCredentialForm
            onCancel={() => setAdding(false)}
            onSave={async (payload) => {
              await polpo.saveVaultEntry({ agent: agentName, ...payload });
              await invalidate();
              setAdding(false);
            }}
          />
        </div>
      )}

      {entries.length === 0 ? (
        <EmptyBox>No credentials stored for this agent.</EmptyBox>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex border-b border-border bg-muted/40 px-3.5 py-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            <span className="flex-1">Service</span>
            <span className="w-24">Type</span>
            <span className="w-40">Keys</span>
            <span className="w-24 text-right" />
          </div>
          {entries.map((e) => (
            <div
              key={e.service}
              className="flex items-center border-b border-border px-3.5 py-2.5 last:border-0"
            >
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <Lock size={13} className="shrink-0 text-muted-foreground/50" />
                <span className="truncate font-mono text-[12px] text-foreground">
                  {e.service}
                </span>
                {e.label && (
                  <span className="truncate text-[11px] text-muted-foreground/60">
                    {e.label}
                  </span>
                )}
              </span>
              <span className="w-24">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {typeLabel[e.type] ?? e.type}
                </span>
              </span>
              <span className="w-40 truncate font-mono text-[11px] text-muted-foreground/60">
                {e.keys?.join(", ") || "—"}
              </span>
              <span className="flex w-24 items-center justify-end">
                {confirm === e.service ? (
                  <span className="flex items-center gap-2 text-[12px]">
                    <button
                      onClick={() => remove.mutate(e.service)}
                      disabled={remove.isPending}
                      className="text-destructive hover:underline"
                    >
                      {remove.isPending ? "…" : "Delete"}
                    </button>
                    <button
                      onClick={() => setConfirm(null)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirm(e.service)}
                    aria-label={`Delete ${e.service}`}
                    className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-secondary hover:text-destructive"
                  >
                    <Trash size={14} />
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type SavePayload = {
  service: string;
  type: VaultType;
  label?: string;
  credentials: Record<string, string>;
};

function AddCredentialForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (payload: SavePayload) => Promise<void>;
}) {
  const [type, setType] = useState<VaultType>("api_key");
  const [service, setService] = useState("");
  const [label, setLabel] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [customRows, setCustomRows] = useState<{ k: string; v: string }[]>([
    { k: "", v: "" },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!service.trim()) {
      setError("Service name is required.");
      return;
    }
    let credentials: Record<string, string>;
    try {
      credentials = buildCredentials(type, values, customRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid fields");
      return;
    }
    setSaving(true);
    try {
      await onSave({
        service: service.trim(),
        type,
        label: label.trim() || undefined,
        credentials,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground">
          New credential
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Type</span>
          <Select
            value={type}
            onValueChange={(v) => {
              if (!v) return;
              setType(v as VaultType);
              setValues({});
            }}
          >
            <SelectTrigger size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {typeLabel[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Service</span>
          <input
            value={service}
            onChange={(e) => setService(e.target.value)}
            placeholder="e.g. openai, gmail"
            className={`${INPUT} font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted-foreground">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Personal key"
            className={INPUT}
          />
        </label>
      </div>

      {/* Typed fields */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {type === "custom"
          ? customRows.map((row, i) => (
              <div key={i} className="flex gap-2">
                <input
                  value={row.k}
                  onChange={(e) => {
                    const next = [...customRows];
                    next[i] = { ...next[i], k: e.target.value };
                    if (i === customRows.length - 1 && e.target.value)
                      next.push({ k: "", v: "" });
                    setCustomRows(next);
                  }}
                  placeholder="key"
                  className={`${INPUT} font-mono`}
                />
                <input
                  value={row.v}
                  onChange={(e) => {
                    const next = [...customRows];
                    next[i] = { ...next[i], v: e.target.value };
                    setCustomRows(next);
                  }}
                  placeholder="value"
                  className={INPUT}
                />
              </div>
            ))
          : TYPE_FIELDS[type].map((f) => (
              <label key={f.k} className="flex flex-col gap-1">
                <span className="text-[11px] text-muted-foreground">
                  {f.label}
                  {f.optional && (
                    <span className="text-muted-foreground/40"> · optional</span>
                  )}
                </span>
                <input
                  type={f.secret ? "password" : "text"}
                  value={values[f.k] ?? ""}
                  onChange={(e) =>
                    setValues((v) => ({ ...v, [f.k]: e.target.value }))
                  }
                  placeholder={f.placeholder}
                  className={INPUT}
                />
              </label>
            ))}
      </div>

      {error && <p className="mt-3 text-[12px] text-destructive">{error}</p>}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving ? (
            <>
              <CircleNotch size={14} className="animate-spin" />
              Saving…
            </>
          ) : (
            "Save credential"
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
