"use client";

import { useState } from "react";
import { useMutation, mutateDataPlane, useRouter as useRuntimeRouter } from "../host";
import { FloppyDisk } from "@phosphor-icons/react/dist/ssr";
import { normalizeSessionTitleSettings, type SessionTitleSettings } from "@polpo-ai/core/session-titles";
import { Button } from "../ui/button";
import { SelectField } from "../ui/select-field";
import { ModelSelect } from "./model-select";

const inputClass = "h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:border-ring/50 focus:outline-none disabled:opacity-50";

export function SessionTitlePreferences({ projectId, agentName, initial, available = true, onSave }: {
  projectId: string; agentName?: string; initial?: SessionTitleSettings; available?: boolean;
  onSave(settings: SessionTitleSettings): Promise<unknown>;
}) {
  const [draft, setDraft] = useState<SessionTitleSettings>(initial ?? {});
  const [saved, setSaved] = useState(initial ?? {});
  const router = useRuntimeRouter();
  let error: string | undefined;
  try { normalizeSessionTitleSettings(draft); } catch (e) { error = e instanceof Error ? e.message : "Invalid title settings"; }
  const save = useMutation({ mutationFn: () => onSave(draft), onSuccess: () => { setSaved(draft); router.refresh(); } });
  const disabled = !available || save.isPending;
  const change = <K extends keyof SessionTitleSettings>(key: K, value: SessionTitleSettings[K]) => setDraft(current => ({ ...current, [key]: value }));
  const model = draft.model;
  const primary = typeof model === "object" && model && "primary" in model ? model.primary : model;
  const selectedModel = typeof primary === "string" ? primary : primary && "profile" in primary ? `profile:${primary.profile}` : undefined;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-start justify-between gap-4 px-3.5 py-3">
        <div><div className="text-[13px] font-medium">Automatic Session titles</div>
          <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">Name new conversations in the background, including greetings. Manual titles are preserved.</p>
          {!available && <p className="mt-1 text-[12px] text-muted-foreground">Available after the Session titles rollout is enabled.</p>}
        </div>
        <SelectField aria-label="Automatic Session titles" className="w-40 shrink-0" disabled={disabled}
          value={draft.enabled == null ? "inherit" : draft.enabled ? "on" : "off"}
          options={[{ value: "inherit", label: agentName ? "Project default" : "Default (on)" }, { value: "on", label: "On" }, { value: "off", label: "Off" }]}
          onChange={value => change("enabled", value === "inherit" ? null : value === "on")} />
      </div>
      <fieldset disabled={disabled} className="grid gap-4 border-t border-border px-3.5 py-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2">
          <div className="mb-1.5 flex items-center justify-between"><span className="text-[11px] font-medium text-muted-foreground">Title model</span>
            {model != null && <button type="button" className="text-[12px] text-muted-foreground hover:text-foreground" onClick={() => change("model", null)}>Use default</button>}
          </div>
          <ModelSelect projectId={projectId} agentName={agentName ?? ""} currentModel={selectedModel} onModelSelect={value => change("model", value)} />
          <p className="mt-1.5 text-[12px] text-muted-foreground">{model == null ? (agentName ? "Inherits the project choice; otherwise uses the first response’s model." : "Uses the model selected for the conversation’s first response.") : "This model is used only to name the Session."}</p>
          {typeof model === "object" && model && "fallbacks" in model && <p className="mt-1 text-[12px] text-muted-foreground">Configured fallback policy is preserved until you select another model.</p>}
        </div>
        <label><span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">Language</span>
          <input aria-label="Title language" className={inputClass} value={draft.language ?? ""} placeholder="Inherited · auto" onChange={e => change("language", e.target.value || null)} />
          <span className="mt-1 block text-[12px] text-muted-foreground">auto follows the user; or use a language tag such as it or en-US.</span>
        </label>
        {([{ key: "maxLength", label: "Maximum characters", fallback: 80, max: 200 }, { key: "maxOutputTokens", label: "Maximum output tokens", fallback: 128, max: 512 }, { key: "timeoutMs", label: "Timeout (milliseconds)", fallback: 5000, max: 15000 }] as const).map(field => (
          <label key={field.key}><span className="mb-1.5 block text-[11px] font-medium text-muted-foreground">{field.label}</span>
            <input aria-label={field.label} className={inputClass} type="number" min={1} max={field.max} step={1} value={draft[field.key] ?? ""} placeholder={`Inherited · default ${field.fallback}`} onChange={e => change(field.key, e.target.value === "" ? null : Number(e.target.value))} />
          </label>
        ))}
      </fieldset>
      <div className="flex items-center justify-end gap-3 border-t border-border px-3.5 py-3">
        {(error || save.isError) && <p role="alert" className="mr-auto text-[12px] text-destructive">{error ?? "Could not save title preferences."}</p>}
        <Button size="sm" disabled={disabled || Boolean(error) || JSON.stringify(saved) === JSON.stringify(draft)} onClick={() => save.mutate()}><FloppyDisk size={14} />{save.isPending ? "Saving…" : "Save"}</Button>
      </div>
    </div>
  );
}

export function AgentSessionTitlePreferences(props: { projectId: string; agentName: string; initial?: SessionTitleSettings; available: boolean }) {
  return <SessionTitlePreferences {...props} onSave={sessionTitles => mutateDataPlane(props.projectId, `/v1/agents/${encodeURIComponent(props.agentName)}`, { method: "PATCH", body: { sessionTitles } })} />;
}
