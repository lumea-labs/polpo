"use client";

/**
 * Inference credits — shared balance + top-up + auto-reload logic.
 *
 * Two visual variants consume the same hook and dialog:
 *   <InferenceCreditsBadge>  compact header pill (used in /llm-gateway)
 *   <InferenceCreditsCard>   full card (used in /billing)
 *
 * Keeps the Autumn / Stripe wiring in one place.
 */

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useCustomer } from "autumn-js/react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const PRESETS = [20, 50, 100, 500];

async function apiCall<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...opts?.headers },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Error ${res.status}`);
  }
  return res.json();
}

type Balance = { remaining: number; used: number } | null;
type BreakdownRow = { id: string; amount: number; remaining: number; expiresAt: number | null };
type BreakdownData = {
  total: number;
  purchased: BreakdownRow[];
  granted: BreakdownRow[];
  redeemedCodes: Array<{ code: string; redeemedAt: string }>;
};

function useInferenceBalance(orgId: string) {
  const [balance, setBalance] = useState<Balance>(null);
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    const load = () => {
      apiCall<{ ok: boolean; data: Balance }>(
        `/v1/billing/inference/balance?orgId=${orgId}`,
      )
        .then((res) => { if (!cancelled) setBalance(res.data); })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false); });
      apiCall<{ ok: boolean; data: BreakdownData }>(
        `/v1/billing/inference/breakdown?orgId=${orgId}`,
      )
        .then((res) => { if (!cancelled) setBreakdown(res.data); })
        .catch(() => {});
    };
    load();
    const onRefresh = () => load();
    window.addEventListener("polpo:inference-balance-refresh", onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener("polpo:inference-balance-refresh", onRefresh);
    };
  }, [orgId]);

  const grantedRemaining = breakdown?.granted.reduce((sum, r) => sum + r.remaining, 0) ?? 0;
  // Earliest expiration among granted entries that actually expire. Ignores
  // non-expiring entries — the badge says "X expires on Y" which is about
  // the portion that disappears, not the permanent portion.
  const expiringEntries = breakdown?.granted.filter((r) => r.expiresAt !== null) ?? [];
  const earliestExpiresAt = expiringEntries.length > 0
    ? Math.min(...expiringEntries.map((r) => r.expiresAt as number))
    : null;
  const expiringAmount = expiringEntries.reduce((sum, r) => sum + r.remaining, 0);
  return { balance, loading, grantedRemaining, earliestExpiresAt, expiringAmount };
}

function formatExpiry(ts: number | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Buy credits dialog — shared between badge and card.
 */
function TopUpDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [topUpAmount, setTopUpAmount] = useState(100);
  const [isCustom, setIsCustom] = useState(false);
  const [topping, setTopping] = useState(false);

  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoThreshold, setAutoThreshold] = useState(1);
  const [autoQuantity, setAutoQuantity] = useState(10);
  const [autoLimit, setAutoLimit] = useState(0);
  const [savingAuto, setSavingAuto] = useState(false);
  const [showAutoConfig, setShowAutoConfig] = useState(false);

  // Auto-reload only makes sense when there's a saved card Autumn can charge
  // without user confirmation. Paid plans should have a payment method on file;
  // free-plan users would hit Stripe Checkout every auto-trigger.
  const { data: customer } = useCustomer();
  const plan = (customer as { subscriptions?: { planId?: string }[] } | undefined)
    ?.subscriptions?.[0]?.planId ?? "free";
  const canAutoReload = plan === "pro" || plan === "startup" || plan === "payg";

  // Preview/confirm step — returning customers (card on file) get a confirm
  // modal before the card is actually charged. First-timers skip it and go
  // straight to Stripe Checkout (where Stripe itself is the confirmation UI).
  type Preview = {
    total: number;
    subtotal: number;
    currency: string;
    redirectToCheckout: boolean;
    lineItems: Array<{ description?: string; amount?: number; quantity?: number }>;
  };
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  function formatMoney(amount: number, currency: string) {
    // Autumn returns amounts in the plan's configured unit (for
    // inference_top_up that's 1 unit = $1), not cents. Format as-is.
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    });
  }

  async function handleContinueToPayment() {
    if (topUpAmount < 10) return;
    setPreviewing(true);
    try {
      const res = await apiCall<{ ok: boolean; data: Preview }>(
        "/v1/billing/inference/preview",
        {
          method: "POST",
          body: JSON.stringify({ orgId, amount: topUpAmount }),
        },
      );
      if (res.data?.redirectToCheckout) {
        await handleTopUp();
        return;
      }
      setPreview(res.data);
    } catch (err) {
      console.error("[top-up] preview failed", err);
      alert("Failed to preview charge. Check server logs and try again.");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleTopUp() {
    if (topUpAmount < 10) return;
    setTopping(true);
    try {
      const successUrl = `${window.location.origin}${window.location.pathname}?topup=success`;
      const res = await apiCall<{ ok: boolean; url: string }>(
        "/v1/billing/inference/top-up",
        {
          method: "POST",
          body: JSON.stringify({ orgId, amount: topUpAmount, successUrl }),
        },
      );
      // First-time flow: Autumn returns a Stripe Checkout URL because no card
      // is on file. Redirect so the user can enter payment details.
      if (res.url) {
        window.location.href = res.url;
        return;
      }
      // Returning-customer flow: card was charged immediately. Close the
      // dialog, notify, and refresh the balance in place.
      toast.success(`Purchased $${topUpAmount.toFixed(2)} of AI credits`);
      setPreview(null);
      onOpenChange(false);
      window.dispatchEvent(new CustomEvent("polpo:inference-balance-refresh"));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      setTopping(false);
    }
  }

  async function handleSaveAutoReload() {
    setSavingAuto(true);
    try {
      await apiCall("/v1/billing/inference/auto-top-up", {
        method: "POST",
        body: JSON.stringify({
          orgId,
          enabled: autoEnabled,
          threshold: autoThreshold,
          quantity: autoQuantity,
          monthlyLimit: autoLimit || 10,
        }),
      });
      setShowAutoConfig(false);
    } catch {}
    setSavingAuto(false);
  }

  if (preview) {
    return (
      <Dialog open={open} onOpenChange={(o) => { if (!o) setPreview(null); onOpenChange(o); }}>
        <DialogContent className="sm:max-w-xl w-full">
          <DialogHeader>
            <DialogTitle className="text-xl">Confirm purchase</DialogTitle>
            <DialogDescription>
              Your card on file will be charged immediately. Credits are added to your balance as soon as payment succeeds.
            </DialogDescription>
          </DialogHeader>

          <div className="py-6 space-y-4">
            <div className="border border-border bg-secondary/20 p-4 space-y-3">
              {preview.lineItems.length > 0 ? (
                preview.lineItems.map((li, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{li.description ?? "AI inference credits"}</span>
                    <span className="font-mono">{formatMoney(li.amount ?? 0, preview.currency)}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">AI inference credits</span>
                  <span className="font-mono">{formatMoney(preview.subtotal, preview.currency)}</span>
                </div>
              )}
              {preview.subtotal !== preview.total && (
                <div className="flex items-center justify-between text-sm border-t border-border pt-3">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-mono">{formatMoney(preview.subtotal, preview.currency)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-border pt-3">
                <span className="text-sm font-medium">Total due now</span>
                <span className="font-mono text-lg font-extrabold">
                  {formatMoney(preview.total, preview.currency)}
                </span>
              </div>
            </div>
          </div>

          <div className="-mx-4 -mb-4 flex items-center justify-end gap-2 border-t border-border px-4 py-2">
            <button
              onClick={() => setPreview(null)}
              disabled={topping}
              className="inline-flex h-9 items-center border border-border px-4 text-sm leading-none transition-colors hover:bg-secondary disabled:opacity-50"
            >
              Back
            </button>
            <button
              onClick={handleTopUp}
              disabled={topping}
              className="inline-flex h-9 items-center gap-2 bg-foreground px-4 text-sm font-medium leading-none text-background transition-all hover:opacity-90 disabled:opacity-50"
            >
              {topping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Confirm purchase`}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl w-full min-h-[480px]">
        <DialogHeader>
          <DialogTitle className="text-xl">Buy AI Gateway Credit</DialogTitle>
          <DialogDescription>
            Purchase credit as a one time top-up for your team&apos;s AI Gateway usage.
          </DialogDescription>
        </DialogHeader>

        <div className="py-8">
          <div className="text-center">
            {isCustom ? (
              <div className="inline-flex items-baseline gap-1 justify-center">
                <input
                  type="number"
                  value={topUpAmount}
                  onChange={(e) => setTopUpAmount(Math.round(Number(e.target.value)))}
                  min={10}
                  step={1}
                  autoFocus
                  className="w-64 bg-transparent text-center text-6xl font-extrabold tracking-tight font-mono focus:outline-none border-b-2 border-foreground/20 focus:border-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-2xl font-medium text-muted-foreground ml-1">USD</span>
              </div>
            ) : (
              <p className="text-6xl font-extrabold tracking-tight">
                {topUpAmount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 })}
                <span className="text-2xl font-medium text-muted-foreground ml-2">USD</span>
              </p>
            )}
          </div>

          <div className="mt-8 flex items-center justify-center gap-2">
            {PRESETS.map((amt) => (
              <button
                key={amt}
                onClick={() => { setTopUpAmount(amt); setIsCustom(false); }}
                className={`px-5 py-2 text-sm font-mono font-medium border transition-all ${
                  !isCustom && topUpAmount === amt
                    ? "border-foreground bg-foreground text-background"
                    : "border-border hover:border-foreground/40"
                }`}
              >
                ${amt}
              </button>
            ))}
            <button
              onClick={() => setIsCustom(true)}
              className={`px-5 py-2 text-sm font-medium border transition-all ${
                isCustom
                  ? "border-foreground bg-foreground text-background"
                  : "border-border hover:border-foreground/40"
              }`}
            >
              Custom
            </button>
          </div>

          {!canAutoReload ? null : !showAutoConfig ? (
            <div className="mt-8 flex items-center justify-between rounded border border-border bg-secondary/30 px-4 py-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm">
                  {autoEnabled
                    ? `Auto-reload enabled. Adds $${autoQuantity} when below $${autoThreshold}.`
                    : "Auto-reload is disabled."}
                </span>
              </div>
              <button
                onClick={() => setShowAutoConfig(true)}
                className="text-sm font-medium border border-border bg-background px-3 py-1 hover:bg-secondary transition-colors"
              >
                Change
              </button>
            </div>
          ) : (
            <div className="mt-8 rounded border border-border p-5 space-y-5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Auto-reload</span>
                <button
                  onClick={() => setAutoEnabled(!autoEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${autoEnabled ? "bg-foreground" : "bg-border"}`}
                >
                  <span className={`inline-block h-4 w-4 rounded-full bg-background transition-transform ${autoEnabled ? "translate-x-6" : "translate-x-1"}`} />
                </button>
              </div>

              {autoEnabled && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium mb-2">When Balance Falls Below</label>
                      <div className="relative">
                        <input
                          type="number"
                          value={autoThreshold}
                          onChange={(e) => setAutoThreshold(Math.max(0, Number(e.target.value)))}
                          min={0}
                          step={1}
                          className="w-full border border-border bg-transparent pl-3 pr-12 py-2.5 text-sm font-mono focus:border-foreground/30 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USD</span>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-2">Recharge To Target Balance</label>
                      <div className="relative">
                        <input
                          type="number"
                          value={autoQuantity}
                          onChange={(e) => setAutoQuantity(Math.max(1, Number(e.target.value)))}
                          min={1}
                          step={5}
                          className="w-full border border-border bg-transparent pl-3 pr-12 py-2.5 text-sm font-mono focus:border-foreground/30 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USD</span>
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2">Maximum Monthly Spend</label>
                    <div className="relative">
                      <input
                        type="number"
                        value={autoLimit}
                        onChange={(e) => setAutoLimit(Math.max(0, Number(e.target.value)))}
                        min={0}
                        step={10}
                        placeholder="No limit"
                        className="w-full border border-border bg-transparent pl-3 pr-12 py-2.5 text-sm font-mono placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USD</span>
                    </div>
                  </div>
                </>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={handleSaveAutoReload}
                  disabled={savingAuto}
                  className="inline-flex items-center gap-2 bg-foreground text-background px-4 py-1.5 text-sm font-medium transition-all hover:opacity-90 disabled:opacity-50"
                >
                  {savingAuto ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save Changes"}
                </button>
                <button
                  onClick={() => setShowAutoConfig(false)}
                  className="px-4 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        {isCustom && topUpAmount < 10 && (
          <p className="text-xs text-destructive px-1">Minimum top-up amount is $10.</p>
        )}

        <div className="-mx-4 -mb-4 flex items-center justify-end gap-2 border-t border-border px-4 py-2">
          <DialogClose
            render={
              <button className="inline-flex h-9 items-center border border-border px-4 text-sm leading-none transition-colors hover:bg-secondary">
                Cancel
              </button>
            }
          />
          <button
            onClick={handleContinueToPayment}
            disabled={topping || previewing || topUpAmount < 10}
            className="inline-flex h-9 items-center gap-2 bg-foreground px-4 text-sm font-medium leading-none text-background transition-all hover:opacity-90 disabled:opacity-50"
          >
            {topping || previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Continue to Payment"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact header pill — used in /llm-gateway.
 */
export function InferenceCreditsBadge({ orgId, compact = false }: { orgId: string; compact?: boolean }) {
  const { balance, loading, grantedRemaining, earliestExpiresAt, expiringAmount } = useInferenceBalance(orgId);
  const [open, setOpen] = useState(false);
  const remaining = balance?.remaining ?? 0;
  const tooltip = earliestExpiresAt
    ? `$${grantedRemaining.toFixed(2)} free · $${expiringAmount.toFixed(2)} expires ${formatExpiry(earliestExpiresAt)}`
    : `$${grantedRemaining.toFixed(2)} of free credits`;

  return (
    <>
      <div className={compact ? "flex items-center gap-1.5" : "flex items-center gap-3"}>
        <button
          onClick={() => setOpen(true)}
          title={
            grantedRemaining > 0
              ? `AI credits — ${tooltip}. Click to buy more.`
              : "AI credits balance — click to buy more"
          }
          className={
            compact
              ? "inline-flex h-8 items-center gap-1.5 bg-foreground/10 px-2.5 text-xs font-mono font-bold hover:bg-foreground/15 transition-colors cursor-pointer"
              : "inline-flex items-center gap-1.5 bg-foreground/10 px-2.5 py-1 text-sm font-mono font-bold hover:bg-foreground/15 transition-colors cursor-pointer"
          }
        >
          <Wallet className={compact ? "h-3.5 w-3.5" : "h-3.5 w-3.5"} />
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin opacity-60" />
          ) : (
            `$${remaining.toFixed(2)}`
          )}
        </button>
        {!compact && grantedRemaining > 0 && (
          <span
            title={tooltip}
            className="rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-xs font-mono font-semibold"
          >
            ${grantedRemaining.toFixed(2)} free incl.
          </span>
        )}
        {!compact && (
          <button
            onClick={() => setOpen(true)}
            className="inline-flex items-center bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90"
          >
            Buy credits
          </button>
        )}
      </div>
      <TopUpDialog orgId={orgId} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * Full card — used in /billing grid alongside Plan/Payment.
 */
export function InferenceCreditsCard({ orgId }: { orgId: string }) {
  const { balance, loading, grantedRemaining, earliestExpiresAt, expiringAmount } = useInferenceBalance(orgId);
  const [open, setOpen] = useState(false);
  const remaining = balance?.remaining ?? 0;
  const tooltip = earliestExpiresAt
    ? `$${grantedRemaining.toFixed(2)} free · $${expiringAmount.toFixed(2)} expires ${formatExpiry(earliestExpiresAt)}`
    : `$${grantedRemaining.toFixed(2)} of free credits`;

  return (
    <>
      <div className="border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            AI Credits
          </p>
          {!loading && grantedRemaining > 0 && (
            <span
              title={tooltip}
              className="rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-mono font-semibold"
            >
              ${grantedRemaining.toFixed(2)} free incl.
            </span>
          )}
        </div>
        {!loading && earliestExpiresAt && (
          <p className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">
            ${expiringAmount.toFixed(2)} expires {formatExpiry(earliestExpiresAt)}
          </p>
        )}
        {loading ? (
          <>
            <div className="mt-2 h-8 w-24 bg-secondary rounded animate-pulse" />
            <div className="mt-4 h-8 w-28 bg-secondary/50 rounded animate-pulse" />
          </>
        ) : (
          <>
            <p className="mt-2 text-2xl font-extrabold">${remaining.toFixed(2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Prepaid balance for managed LLM inference
            </p>
            <button
              onClick={() => setOpen(true)}
              className="mt-4 inline-flex items-center bg-foreground text-background px-4 py-2 text-sm font-medium transition-all hover:opacity-90"
            >
              Buy credits
            </button>
          </>
        )}
      </div>
      <TopUpDialog orgId={orgId} open={open} onOpenChange={setOpen} />
    </>
  );
}
