"use client";

/**
 * Agent capabilities — one full-width card per modality
 * (Text / Image / Audio / Video). Reads as "here's the model behind
 * each capability". There is no on/off here: whether a capability is
 * usable is governed per-tool in the Tools tab.
 *
 * Layout per card:
 *   [icon + name]  [description]
 *   [model pickers grid]
 *
 * Each slot is a `<ModelSelectorCompact>` (ghost appearance) — an inline
 * trigger that opens a command-palette dropdown (search + keyboard nav +
 * cost tiers), no modal. On change we PATCH the matching
 * agent field and `router.refresh()` so the server-rendered page picks
 * up the new value.
 *
 * Catalogs:
 *   - chat fields (model, vision) → Vercel AI Gateway catalog
 *     (`/api/gateway/models`), fetched once here and shared.
 *   - media fields (image/video/voice) → `DEFAULT_MEDIA_MODELS`
 *     filtered by kind.
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Image as ImageIcon, Video, Volume2, Type, Loader2 } from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";
import {
  ModelSelectorCompact,
  DEFAULT_MEDIA_MODELS,
  DEFAULT_MEDIA_PROVIDERS,
  DEFAULT_PROVIDERS,
  type Model,
} from "@lumea-labs/llm";

/** The provider-entry shape both selectors accept (logo + colour). */
type Provider = (typeof DEFAULT_PROVIDERS)[number];

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Free, local (no-key) text-to-speech engine. Not in the media catalog, so
 *  we surface it explicitly as the default TTS option. */
const EDGE_TTS_MODEL: Model = {
  id: "edge/edge-tts",
  name: "Edge TTS — free",
  providerId: "edge",
  kind: "voice",
};

/** Which agent field a model slot writes to, and how to resolve it. */
interface ModelSlot {
  /** Short uppercase label, e.g. "GENERATION". */
  label: string;
  /** The AgentConfig key this slot patches, e.g. "image_model". */
  field: keyof AgentConfig;
  /** Effective value (agent override or default). */
  value: string;
  /** True when the value comes from agent config (not the default). */
  configured: boolean;
  /** Media catalog kind for resolution / selector filtering. */
  kind: Model["kind"];
  /** "chat" slots use the gateway catalog; "media" use DEFAULT_MEDIA_MODELS. */
  catalog: "chat" | "media";
}

interface CapabilityCard {
  name: "Text" | "Image" | "Audio" | "Video";
  description: string;
  icon: typeof ImageIcon;
  slots: ModelSlot[];
}

interface GatewayModel {
  id: string;
  owned_by?: string;
}

/** Resolve a model id against DEFAULT_MEDIA_MODELS; synthesise a minimal
 *  entry (provider logo + raw name) when not in the catalog. */
function resolveMediaModel(modelId: string, kind: Model["kind"]): Model {
  const lower = modelId.toLowerCase();
  const exact = DEFAULT_MEDIA_MODELS.find((m) => m.id.toLowerCase() === lower);
  if (exact) return exact;
  const suffix = DEFAULT_MEDIA_MODELS.find(
    (m) => lower.endsWith(`/${m.id.toLowerCase()}`) || lower.endsWith(m.id.toLowerCase()),
  );
  if (suffix) return suffix;
  const slashIdx = modelId.indexOf("/");
  const providerId = slashIdx > 0 ? modelId.slice(0, slashIdx) : "other";
  const remainder = slashIdx > 0 ? modelId.slice(slashIdx + 1) : modelId;
  return { id: modelId, name: remainder, providerId, kind };
}

/** A single selectable model slot — a clean badge trigger that opens a
 *  searchable model picker in a dialog. */
function ModelSlotPicker({
  slot,
  projectId,
  agentName,
  gatewayModels,
  gatewayProviders,
}: {
  slot: ModelSlot;
  projectId: string;
  agentName: string;
  gatewayModels: Model[];
  gatewayProviders: Provider[];
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isChat = slot.catalog === "chat";
  const providers = isChat ? gatewayProviders : DEFAULT_MEDIA_PROVIDERS;
  let baseModels = isChat
    ? gatewayModels
    : DEFAULT_MEDIA_MODELS.filter((m) => m.kind === slot.kind);
  // Edge TTS is a free, local (no-key) text-to-speech engine that isn't in
  // the media catalog — surface it as a first-class, default option on the
  // text-to-speech slot so it can be picked without a provider key.
  if (slot.field === "tts_model") {
    baseModels = [EDGE_TTS_MODEL, ...baseModels.filter((m) => m.id !== EDGE_TTS_MODEL.id)];
  }
  // Guarantee the current value renders in the trigger even when it's a
  // custom / not-in-catalog id — synthesise a minimal entry and prepend it.
  const models = baseModels.some((m) => m.id === slot.value)
    ? baseModels
    : [resolveMediaModel(slot.value, slot.kind), ...baseModels];

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
          body: JSON.stringify({ [slot.field]: modelId }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Update failed (${res.status})`);
        setSaving(false);
        return;
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message ?? "Update failed");
    }
    setSaving(false);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-4">
        {/* Field label — what this model powers. */}
        <span className="flex w-44 shrink-0 items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-foreground">
          {slot.label}
          {saving && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </span>
        {/* Bordered select-style trigger → reads as an editable control.
            Opens a command palette (search + keyboard nav + cost tiers). */}
        <div className="min-w-0 flex-1">
          <ModelSelectorCompact
            models={models}
            value={slot.value}
            onChange={handleChange}
            providers={providers}
            appearance="button"
            showCost
            activeFirst
            className="w-full justify-between"
          />
        </div>
        {!slot.configured && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/50">
            default
          </span>
        )}
      </div>

      {error && (
        <span className="block pl-48 text-[11px] text-destructive" title={error}>
          {error.length > 48 ? `${error.slice(0, 48)}…` : error}
        </span>
      )}
    </div>
  );
}

export function AgentCapabilities({
  agent,
  projectId,
  agentName,
}: {
  agent: AgentConfig;
  projectId: string;
  agentName: string;
}) {
  // Gateway catalog — fetched once, shared by all chat slots (text + vision).
  const [gatewayModels, setGatewayModels] = useState<Model[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/gateway/models")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const raw = (data.data ?? data ?? []) as GatewayModel[];
        setGatewayModels(
          raw
            .filter((m) => m.id.includes("/"))
            .map((m) => {
              const [providerId, ...rest] = m.id.split("/");
              return { id: m.id, name: rest.join("/"), providerId } as Model;
            }),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const gatewayProviders = useMemo<Provider[]>(() => {
    const seen = new Set(DEFAULT_PROVIDERS.map((p) => p.id));
    const extras = Array.from(
      new Set(gatewayModels.map((m) => m.providerId).filter((p) => !seen.has(p))),
    ).map((id) => ({ id, name: id, color: "#888" }) as Provider);
    return [...DEFAULT_PROVIDERS, ...extras];
  }, [gatewayModels]);

  const slot = (
    label: string,
    field: keyof AgentConfig,
    fallback: string,
    kind: Model["kind"],
    catalog: "chat" | "media",
  ): ModelSlot => {
    const configured = agent[field] as string | undefined;
    return {
      label,
      field,
      value: configured ?? fallback,
      configured: !!configured,
      kind,
      catalog,
    };
  };

  const cards: CapabilityCard[] = [
    {
      name: "Text",
      description: "Core reasoning and chat — every agent talks and thinks in text.",
      icon: Type,
      slots: [slot("Generation model", "model", "xai/grok-4.1-fast-non-reasoning", "chat", "chat")],
    },
    {
      name: "Image",
      description: "Generate + analyze with vision models.",
      icon: ImageIcon,
      slots: [
        slot("Generation model", "image_model", "fal/fal-ai/flux/dev", "image", "media"),
        slot("Vision model", "vision_model", "openai/gpt-4o-mini", "chat", "chat"),
      ],
    },
    {
      name: "Audio",
      description: "Transcribe and synthesize speech.",
      icon: Volume2,
      slots: [
        slot("Speech-to-text model", "transcribe_model", "openai/whisper-1", "voice", "media"),
        slot("Text-to-speech model", "tts_model", "edge/edge-tts", "voice", "media"),
      ],
    },
    {
      name: "Video",
      description: "Generate videos from prompts.",
      icon: Video,
      slots: [slot("Generation model", "video_model", "fal/luma-ray-2-flash", "video", "media")],
    },
  ];

  // Settings form — each modality is a titled section (name + one-line
  // description) over its labelled model fields. No card chrome; the bordered
  // pickers read as editable controls.
  return (
    <div className="flex flex-col divide-y divide-border">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div key={card.name} className="py-7 first:pt-0 last:pb-0">
            {/* Section header: icon + name + what it's for. The divider sits
                after the whole block (via divide-y), not under the title. */}
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <Icon className="h-[18px] w-[18px] shrink-0 text-foreground" strokeWidth={2} />
                <span className="text-base font-bold tracking-tight text-foreground">
                  {card.name}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{card.description}</p>
            </div>
            {/* Fields */}
            <div className="flex flex-col gap-2.5">
              {card.slots.map((s) => (
                <ModelSlotPicker
                  key={s.field as string}
                  slot={s}
                  projectId={projectId}
                  agentName={agentName}
                  gatewayModels={gatewayModels}
                  gatewayProviders={gatewayProviders}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
