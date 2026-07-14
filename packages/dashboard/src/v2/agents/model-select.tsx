"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, useRouter } from "../host";
import {
  MagnifyingGlass,
  Check,
  CaretDown,
  CircleNotch,
} from "@phosphor-icons/react/dist/ssr";
import { ProviderIcon } from "../host";
import { useDashboardApi } from "../../host";

export type GatewayModel = {
  id: string;
  provider: string;
  name: string;
  context?: number;
  routing?: "managed" | "direct" | "local";
  credentialService?: string;
  language?: string;
  /** Best-effort input modalities (e.g. ["text","image"]). Undefined when unknown. */
  input?: string[];
  /** Best-effort output modalities (e.g. ["text"]). Undefined when unknown. */
  output?: string[];
};

/**
 * Raw shape returned by the Vercel AI Gateway (`/v1/models`). Modality data is
 * NOT exposed as `modalities`/`input_modalities`; it is encoded in `type`
 * (language | image | video | embedding | reranking | transcription | realtime
 * | speech) plus `tags` (e.g. "vision", "file-input", "image-generation"). We
 * still read the explicit modality fields first in case upstream adds them.
 */
type RawGatewayModel = {
  id: string;
  context_window?: number;
  type?: string;
  tags?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  modalities?: { input?: string[]; output?: string[] };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
};

const INPUT_BY_TYPE: Record<string, string[]> = {
  language: ["text"],
  realtime: ["text", "audio"],
  transcription: ["audio"],
  image: ["text"],
  video: ["text"],
  speech: ["text"],
  embedding: ["text"],
  reranking: ["text"],
};

const OUTPUT_BY_TYPE: Record<string, string[]> = {
  language: ["text"],
  realtime: ["text", "audio"],
  transcription: ["text"],
  image: ["image"],
  video: ["video"],
  speech: ["audio"],
  embedding: ["embedding"],
  reranking: ["ranking"],
};

/**
 * Best-effort input/output modalities for a gateway model. Returns `undefined`
 * for a side only when there is no signal to derive it from, so downstream
 * capability filters can stay lenient (unknown => include, never exclude).
 */
function deriveModalities(m: RawGatewayModel): { input?: string[]; output?: string[] } {
  // 1) Prefer explicit modality arrays if upstream ever provides them.
  const explicitInput =
    m.input_modalities ?? m.modalities?.input ?? m.architecture?.input_modalities;
  const explicitOutput =
    m.output_modalities ?? m.modalities?.output ?? m.architecture?.output_modalities;
  if (explicitInput || explicitOutput) {
    return {
      input: explicitInput ? [...explicitInput] : undefined,
      output: explicitOutput ? [...explicitOutput] : undefined,
    };
  }

  // 2) Derive from the gateway's `type` + `tags`.
  const tags = m.tags ?? [];
  const type = m.type;
  if (type == null && tags.length === 0) return {}; // no signal — stay lenient

  const inputBase = type != null ? INPUT_BY_TYPE[type] : undefined;
  const input = inputBase ? [...inputBase] : ["text"];
  if (tags.includes("vision") && !input.includes("image")) input.push("image");

  const outputBase = type != null ? OUTPUT_BY_TYPE[type] : undefined;
  // Unknown `type` => leave output undefined so the text filter includes it.
  const output = outputBase ? [...outputBase] : undefined;

  return { input, output };
}

export async function fetchModels(): Promise<GatewayModel[]> {
  const r = await fetch("/api/polpo/models");
  if (!r.ok) return [];
  const d = await r.json();
  const raw = (d.data ?? d ?? []) as RawGatewayModel[];
  return raw
    .filter((m) => m.id.includes("/"))
    .map((m) => {
      const [provider, ...rest] = m.id.split("/");
      const { input, output } = deriveModalities(m);
      return { id: m.id, provider, name: rest.join("/"), context: m.context_window, input, output };
    });
}

export function ModelSelect({
  projectId,
  agentName,
  currentModel,
  field = "model",
  options,
}: {
  projectId: string;
  agentName: string;
  currentModel?: string;
  /** Agent config field to patch (e.g. "model", "vision_model", "tts_model"). */
  field?: string;
  /** Static catalog. When provided, the gateway is not queried. */
  options?: GatewayModel[];
}) {
  const api = useDashboardApi();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const { data: fetched = [], isLoading: fetching } = useQuery({
    queryKey: ["gateway-models"],
    queryFn: fetchModels,
    staleTime: 5 * 60_000,
    enabled: !options,
  });

  // Which capability the fetched catalog should be narrowed to. Slots that pass
  // a static `options` catalog are already curated, so they get no filter.
  const capability: "text" | "vision" | null =
    field === "vision_model" ? "vision" : field === "model" ? "text" : null;

  // Lenient capability filter: only drop a model when its modality data proves
  // it does NOT match. Unknown/missing modality => keep, so the list is never
  // wrongly emptied.
  const capabilityFiltered = useMemo(() => {
    if (!capability) return fetched;
    return fetched.filter((m) => {
      if (capability === "vision") {
        return !m.input || m.input.includes("image");
      }
      return !m.output || m.output.includes("text");
    });
  }, [capability, fetched]);

  const models = options ?? capabilityFiltered;
  const isLoading = !options && fetching;

  const save = useMutation({
    mutationFn: (model: string) =>
      api.mutateDataPlane(projectId, `/v1/agents/${encodeURIComponent(agentName)}`, {
        method: "PATCH",
        body: { [field]: model },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent", projectId, agentName] }),
        queryClient.invalidateQueries({ queryKey: ["agents", projectId] }),
      ]);
      setOpen(false);
      setQuery("");
      router.refresh();
    },
  });

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q) ||
            m.provider.toLowerCase().includes(q) ||
            m.language?.toLowerCase().includes(q) ||
            m.routing?.toLowerCase().includes(q),
        )
      : models;
    const map = new Map<string, GatewayModel[]>();
    for (const m of filtered) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, query]);

  const [curProvider, curName] = currentModel
    ? [currentModel.split("/")[0], currentModel.split("/").slice(1).join("/")]
    : [null, null];
  const currentOption = currentModel
    ? models.find((model) => model.id === currentModel)
    : undefined;

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 min-w-[240px] items-center gap-2 rounded-md border border-border bg-card px-3 text-left transition-colors hover:border-muted-foreground/30 focus:outline-none focus-visible:outline-none focus-visible:!shadow-none"
      >
        {currentModel ? (
          <span className="flex min-w-0 items-center gap-2">
            {curProvider && (
              <ProviderIcon
                provider={curProvider}
                size={16}
                type="mono"
                className="shrink-0"
              />
            )}
            <span className="truncate font-mono text-[13px] text-foreground">
              {currentOption?.name ?? curName}
            </span>
          </span>
        ) : (
          <span className="text-[13px] text-muted-foreground/60">
            No model set
          </span>
        )}
        {save.isPending ? (
          <CircleNotch size={14} className="ml-auto shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <CaretDown size={13} className="ml-auto shrink-0 text-muted-foreground" />
        )}
      </button>

      {open && (
        <>
          {/* outside-click catcher */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setOpen(false);
              setQuery("");
            }}
          />
          <div className="absolute right-0 top-[calc(100%+4px)] z-50 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-popover shadow-xl">
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <MagnifyingGlass size={14} className="shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setOpen(false);
                    setQuery("");
                  }
                }}
                placeholder="Search models…"
                className="h-9 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
              />
            </div>
            <div className="max-h-[340px] overflow-y-auto py-1">
              {isLoading ? (
                <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  Loading catalog…
                </div>
              ) : grouped.length === 0 ? (
                <div className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                  No models match.
                </div>
              ) : (
                grouped.map(([provider, list]) => (
                  <div key={provider} className="mb-1">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/50">
                      <ProviderIcon provider={provider} size={13} type="mono" />
                      {provider}
                    </div>
                    {list.map((m) => {
                      const selected = m.id === currentModel;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => save.mutate(m.id)}
                          className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-secondary/60 ${
                            selected ? "text-foreground" : "text-muted-foreground"
                          }`}
                        >
                          <span className="w-3.5 shrink-0">
                            {selected && (
                              <Check size={13} weight="bold" className="text-brand" />
                            )}
                          </span>
                          <span className="min-w-0 truncate font-mono">{m.name}</span>
                          {m.language ? (
                            <span className="ml-auto shrink-0 font-mono text-[10px] uppercase text-muted-foreground/50">
                              {m.language}
                            </span>
                          ) : null}
                          {m.routing ? (
                            <span className={`${m.language ? "" : "ml-auto"} shrink-0 text-[10px] text-muted-foreground/50`}>
                              {m.routing === "local"
                                ? "Local"
                                : m.routing === "direct"
                                  ? "Vault key"
                                  : "Managed"}
                            </span>
                          ) : null}
                          {m.context ? (
                            <span
                              className={`${m.routing || m.language ? "" : "ml-auto"} shrink-0 font-mono text-[10px] text-muted-foreground/40`}
                              data-tabular
                            >
                              {Math.round(m.context / 1000)}k
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
      {save.isError && (
        <p className="mt-1.5 text-[12px] text-destructive">
          {save.error instanceof Error ? save.error.message : "Update failed"}
        </p>
      )}
    </div>
  );
}
