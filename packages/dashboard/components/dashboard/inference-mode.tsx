"use client";

/**
 * Inference billing mode — a 3-way radio presented as the single
 * question that matters: "who pays for inference, and with whose key?".
 *
 * Three modes:
 *   1. Polpo Managed   — we handle everything, billed from credits.
 *   2. Provider keys   — request-scoped BYOK; the user's provider bills
 *                        them directly, inference is free on Polpo.
 *   3. Custom gateway  — route through the user's own OpenAI-compatible
 *                        endpoint. Gated as Enterprise (locked + contact)
 *                        unless explicitly enabled on the project.
 *
 * Design language matches the Polpo console (neo-brutalist: sharp edges,
 * mono uppercase labels, brand accent, theme tokens). The memorable bit
 * is the money-flow micro-diagram on each card — it makes the billing
 * model legible without reading the copy.
 *
 * Purely presentational: the parent owns mode state + the actual
 * provider-key CRUD and custom-gateway form. This component renders the
 * choice + the active mode's inline panel via the `children` slot.
 */

import { useId } from "react";
import {
  Boxes,
  KeyRound,
  Server,
  Lock,
  ArrowRight,
  Check,
} from "lucide-react";

export type InferenceMode = "managed" | "byok" | "gateway";

interface FlowNode {
  label: string;
  /** Visual weight — `accent` = the party that actually gets paid. */
  tone?: "default" | "accent" | "muted";
}

interface ModeDef {
  id: InferenceMode;
  icon: typeof Boxes;
  title: string;
  badge?: { text: string; tone: "brand" | "emerald" | "muted" };
  blurb: string;
  /** Who-pays-who money flow, left → right. */
  flow: FlowNode[];
  /** One-line billing consequence, shown emphasised. */
  billing: string;
  billingTone: "muted" | "emerald";
}

const MODES: ModeDef[] = [
  {
    id: "managed",
    icon: Boxes,
    title: "Polpo Managed",
    badge: { text: "Default", tone: "brand" },
    blurb: "We run the gateway, routing and fallback. Nothing to set up.",
    flow: [
      { label: "You" },
      { label: "Polpo", tone: "accent" },
      { label: "Provider", tone: "muted" },
    ],
    billing: "Pay per use from your credit balance.",
    billingTone: "muted",
  },
  {
    id: "byok",
    icon: KeyRound,
    title: "Your provider keys",
    badge: { text: "BYOK", tone: "emerald" },
    blurb: "Bring OpenAI, Anthropic, xAI… keys. Same product, your inference.",
    flow: [
      { label: "You" },
      { label: "Provider", tone: "accent" },
    ],
    billing: "Your provider bills you. Inference is free on Polpo.",
    billingTone: "emerald",
  },
  {
    id: "gateway",
    icon: Server,
    title: "Custom gateway",
    badge: { text: "Enterprise", tone: "muted" },
    blurb: "Route through your own OpenAI-compatible endpoint (LiteLLM, …).",
    flow: [
      { label: "You" },
      { label: "Your gateway", tone: "accent" },
      { label: "Provider", tone: "muted" },
    ],
    billing: "Full control over routing and credentials.",
    billingTone: "muted",
  },
];

function FlowDiagram({ nodes }: { nodes: FlowNode[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {nodes.map((n, i) => (
        <span key={n.label} className="flex items-center gap-1.5">
          <span
            className={`inline-flex h-5 items-center px-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.1em] ${
              n.tone === "accent"
                ? "bg-brand/15 text-brand"
                : n.tone === "muted"
                  ? "border border-border text-muted-foreground/50"
                  : "border border-border bg-card text-foreground"
            }`}
          >
            {n.label}
          </span>
          {i < nodes.length - 1 && (
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/40" strokeWidth={2} />
          )}
        </span>
      ))}
    </div>
  );
}

interface Props {
  /** Currently active mode. */
  value: InferenceMode;
  onChange: (mode: InferenceMode) => void;
  /** When false, the Custom gateway card is locked → "Contact us". */
  customGatewayEnabled?: boolean;
  onContactSales?: () => void;
  /** Optional slot rendered below the selected card (the active mode's
   *  config panel — provider-key list, gateway form, credits, …). */
  children?: React.ReactNode;
}

export function InferenceModeRadio({
  value,
  onChange,
  customGatewayEnabled = false,
  onContactSales,
  children,
}: Props) {
  const groupId = useId();

  return (
    <div>
      <div
        role="radiogroup"
        aria-label="Inference billing mode"
        className="flex flex-col gap-3"
      >
        {MODES.map((mode) => {
          const Icon = mode.icon;
          const selected = value === mode.id;
          const locked = mode.id === "gateway" && !customGatewayEnabled;

          return (
            <button
              key={mode.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={locked}
              disabled={locked}
              data-testid={`inference-mode-${mode.id}`}
              onClick={() => (locked ? onContactSales?.() : onChange(mode.id))}
              className={`group relative flex w-full flex-col gap-4 border p-4 text-left transition-all sm:flex-row sm:items-center sm:gap-6 ${
                selected
                  ? "border-brand bg-brand/[0.04] shadow-[inset_3px_0_0_0_var(--brand)]"
                  : locked
                    ? "border-border/60 bg-card/40 cursor-default"
                    : "border-border bg-card hover:border-foreground/30 hover:bg-foreground/[0.02] cursor-pointer"
              }`}
            >
              {/* Left: icon + title + badge + blurb */}
              <div className="flex min-w-0 flex-col gap-2 sm:flex-1">
                <div className="flex items-center gap-2">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      selected ? "text-brand" : locked ? "text-muted-foreground/40" : "text-foreground"
                    }`}
                    strokeWidth={1.75}
                  />
                  <span
                    className={`text-sm font-semibold tracking-tight ${
                      locked ? "text-muted-foreground/60" : "text-foreground"
                    }`}
                  >
                    {mode.title}
                  </span>
                  {mode.badge && (
                    <span
                      className={`inline-flex w-fit items-center px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em] ${
                        mode.badge.tone === "brand"
                          ? "bg-brand/10 text-brand"
                          : mode.badge.tone === "emerald"
                            ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                            : "border border-border text-muted-foreground/60"
                      }`}
                    >
                      {mode.badge.text}
                    </span>
                  )}
                </div>

                <p
                  className={`text-[11px] leading-relaxed ${
                    locked ? "text-muted-foreground/50" : "text-muted-foreground"
                  }`}
                >
                  {mode.blurb}
                </p>
              </div>

              {/* Right: money flow + billing consequence + status */}
              <div className="flex items-start gap-4 sm:items-center sm:gap-6">
                <div className="flex flex-col gap-2 sm:items-end">
                  {/* Money-flow diagram — the memorable bit */}
                  <FlowDiagram nodes={mode.flow} />

                  {/* Billing consequence */}
                  <p
                    className={`text-[11px] font-medium sm:text-right ${
                      mode.billingTone === "emerald"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground/80"
                    }`}
                  >
                    {mode.billing}
                  </p>

                  {/* Locked footer — contact CTA */}
                  {locked && (
                    <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-foreground/70 transition-colors group-hover:text-foreground">
                      Contact us
                      <ArrowRight className="h-3 w-3" strokeWidth={2} />
                    </span>
                  )}
                </div>

                {/* Selection indicator (selectable) or lock (gated) */}
                {locked ? (
                  <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" strokeWidth={1.75} />
                ) : (
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                      selected ? "border-brand bg-brand text-background" : "border-muted-foreground/40"
                    }`}
                  >
                    {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                  </span>
                )}
              </div>

              <span id={`${groupId}-${mode.id}`} className="sr-only">
                {mode.title}
              </span>
            </button>
          );
        })}
      </div>

      {/* Active mode's config panel */}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}
