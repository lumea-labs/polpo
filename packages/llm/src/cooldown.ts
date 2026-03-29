/**
 * Provider cooldown / failback logic.
 *
 * Tracks provider-level errors and applies exponential backoff cooldowns
 * to avoid hammering failing providers.
 */

// ─── Types ───────────────────────────────────────────

interface CooldownEntry {
  until: number;    // timestamp
  errorCount: number;
  reason?: string;  // "rate_limit" | "auth" | "billing" | "error"
}

// ─── State ───────────────────────────────────────────

const providerCooldowns: Map<string, CooldownEntry> = new Map();

const COOLDOWN_STEPS = [60_000, 300_000, 1_500_000, 3_600_000]; // 1m, 5m, 25m, 1h

// ─── Cooldown Management ─────────────────────────────

/**
 * Check if a provider is currently in cooldown.
 */
export function isProviderInCooldown(provider: string): boolean {
  const entry = providerCooldowns.get(provider);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    providerCooldowns.delete(provider);
    return false;
  }
  return true;
}

/**
 * Mark a provider as temporarily unavailable (cooldown).
 */
export function markProviderCooldown(provider: string, reason?: string): void {
  const existing = providerCooldowns.get(provider);
  const errorCount = (existing?.errorCount ?? 0) + 1;
  const stepIdx = Math.min(errorCount - 1, COOLDOWN_STEPS.length - 1);
  const cooldownMs = COOLDOWN_STEPS[stepIdx];

  providerCooldowns.set(provider, {
    until: Date.now() + cooldownMs,
    errorCount,
    reason,
  });
}

/**
 * Clear cooldown for a provider (e.g. after successful call).
 */
export function clearProviderCooldown(provider: string): void {
  providerCooldowns.delete(provider);
}

/**
 * Get current cooldown state for all providers.
 */
export function getProviderCooldowns(): Record<string, { until: number; errorCount: number; reason?: string }> {
  const result: Record<string, { until: number; errorCount: number; reason?: string }> = {};
  for (const [provider, entry] of providerCooldowns) {
    if (Date.now() < entry.until) {
      result[provider] = { ...entry };
    }
  }
  return result;
}

// ─── Error Classification ────────────────────────────

/**
 * Classify an error to determine if it should trigger cooldown or failover.
 */
export function classifyProviderError(err: unknown): {
  shouldCooldown: boolean;
  shouldFailover: boolean;
  reason: string;
} {
  if (!(err instanceof Error)) {
    return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
  }

  const msg = err.message.toLowerCase();

  // Auth errors — cooldown + failover
  if (msg.includes("401") || msg.includes("unauthorized") || msg.includes("invalid api key") ||
      msg.includes("authentication") || msg.includes("forbidden") || msg.includes("403")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "auth" };
  }

  // Rate limit — cooldown + failover
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") ||
      msg.includes("quota exceeded")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "rate_limit" };
  }

  // Billing — long cooldown + failover
  if (msg.includes("insufficient") || msg.includes("credit") || msg.includes("billing") ||
      msg.includes("payment required") || msg.includes("402")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "billing" };
  }

  // Server errors — short cooldown, failover
  if (msg.includes("500") || msg.includes("502") || msg.includes("503") || msg.includes("504") ||
      msg.includes("overloaded") || msg.includes("service unavailable")) {
    return { shouldCooldown: true, shouldFailover: true, reason: "server_error" };
  }

  // Transient network — no cooldown, retry
  if (msg.includes("timeout") || msg.includes("econnreset") || msg.includes("econnrefused") ||
      msg.includes("socket hang up")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "network" };
  }

  // Non-retryable errors (bad request, invalid model, etc.)
  if (msg.includes("400") || msg.includes("invalid") || msg.includes("not found") ||
      msg.includes("404")) {
    return { shouldCooldown: false, shouldFailover: false, reason: "client_error" };
  }

  return { shouldCooldown: false, shouldFailover: false, reason: "unknown" };
}
