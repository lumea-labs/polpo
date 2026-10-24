import type { ModelPolicyEvent } from "@polpo-ai/llm";

/**
 * Phase of a provider call made while serving one completion. Mirrors the
 * `phase` reported to `model:*` runtime hooks, plus context compaction.
 */
export type CompletionModelInvocationPhase =
  | "operational"
  | "terminal"
  | "stop-feedback"
  | "compaction";

/**
 * Billing facts for exactly one provider call made while serving a
 * completion. A completion makes one call per operational turn plus any
 * terminal structured-output, stop-feedback, compaction and failed fallback
 * attempts; hosts must meter the sum of these, not just the last call.
 */
export interface CompletionModelInvocation {
  phase: CompletionModelInvocationPhase;
  /** `failed` attempts were charged by the provider but their output was discarded. */
  status: "succeeded" | "failed";
  /** Policy candidate (e.g. `provider/model`) that served the call, when known. */
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Raw provider metadata for this call only (e.g. `gateway.marketCost`, `gateway.generationId`). */
  providerMetadata?: Record<string, unknown>;
}

type InvocationResult = {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  providerMetadata?: unknown;
  selectedAttempt?: { model?: string };
};

/**
 * Append-only per-completion record of provider calls. It is deliberately not
 * persisted in termination-gate checkpoints: a resumed completion reports only
 * the calls it made itself, so earlier calls are never billed twice.
 */
export class CompletionModelInvocationLedger {
  private readonly entries: CompletionModelInvocation[] = [];

  /** `parent` also receives every entry, so a nested runner can feed the completion ledger. */
  constructor(private readonly parent?: CompletionModelInvocationLedger) {}

  private push(entry: CompletionModelInvocation): void {
    this.entries.push(entry);
    this.parent?.push({ ...entry });
  }

  /** Record a successful provider call. */
  record(
    phase: CompletionModelInvocationPhase,
    result: InvocationResult,
    model?: string,
  ): void {
    this.push(invocation(phase, "succeeded", result.usage, result.providerMetadata, result.selectedAttempt?.model ?? model));
  }

  /** Record provider-billed failed attempts surfaced by the model policy. */
  observePolicyEvent(phase: CompletionModelInvocationPhase, event: ModelPolicyEvent): void {
    if (event.type !== "model-attempt-failed") return;
    const { failure } = event;
    if (failure.usage === undefined && failure.providerMetadata === undefined) return;
    this.push(invocation(phase, "failed", failure.usage, failure.providerMetadata, failure.attempt.model));
  }

  /** Merge invocations reported by a nested runner or transcript event. */
  append(entries: readonly CompletionModelInvocation[]): void {
    for (const entry of entries) this.push({ ...entry });
  }

  list(): CompletionModelInvocation[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

/** Translate a `usage` run-transcript event into an invocation record. */
export function invocationFromUsageEvent(event: Record<string, unknown>): CompletionModelInvocation {
  const phase = typeof event.phase === "string" && isPhase(event.phase) ? event.phase : "operational";
  return invocation(
    phase,
    event.status === "failed" ? "failed" : "succeeded",
    event.usage as InvocationResult["usage"],
    event.providerMetadata,
    typeof event.model === "string" ? event.model : undefined,
  );
}

function isPhase(value: string): value is CompletionModelInvocationPhase {
  return value === "operational" || value === "terminal" || value === "stop-feedback" || value === "compaction";
}

function invocation(
  phase: CompletionModelInvocationPhase,
  status: CompletionModelInvocation["status"],
  usage: InvocationResult["usage"],
  providerMetadata: unknown,
  model: string | undefined,
): CompletionModelInvocation {
  return {
    phase,
    status,
    ...(model ? { model } : {}),
    ...(usage ? {
      usage: {
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      },
    } : {}),
    ...(isRecord(providerMetadata) ? { providerMetadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
