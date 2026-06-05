"use client";

import { useEffect, useState } from "react";
import { useCustomer } from "autumn-js/react";
import { ArrowRight, Check, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type PlanActionButtonProps = {
  orgId?: string;
  plan?: string;
  successUrl?: string;
  showManageWhenPaid?: boolean;
  variant?: "billing" | "header";
  autoOpen?: boolean;
  className?: string;
};

const paidPlans = [
  {
    id: "pro",
    name: "Pro",
    price: "$25",
    description: "For hobby projects and small teams.",
    features: ["1M chat requests / month", "100 task executions / month", "3 agents", "Schedules"],
  },
  {
    id: "startup",
    name: "Startup",
    price: "$200",
    description: "For teams with agent-native workflows.",
    features: ["Everything in Pro", "10M chat requests / month", "10K task executions / month", "Unlimited agents"],
  },
];

export function PlanActionButton({
  orgId,
  plan: planProp,
  successUrl,
  showManageWhenPaid = true,
  variant = "billing",
  autoOpen = false,
  className = "",
}: PlanActionButtonProps) {
  const { data: customer, openCustomerPortal } = useCustomer();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const plan = planProp ?? ((customer as { subscriptions?: { planId?: string }[] } | undefined)?.subscriptions?.[0]?.planId ?? "free");
  const customerOrgId = orgId ?? (customer as { id?: string } | undefined)?.id;
  const isFree = plan === "free";

  useEffect(() => {
    if (autoOpen && isFree && customerOrgId) setOpen(true);
  }, [autoOpen, customerOrgId, isFree]);

  async function upgradeToPlan(planId: string) {
    if (!customerOrgId) return;
    setLoading(true);
    setSelectedPlan(planId);
    try {
      const res = await fetch(API_URL + "/v1/billing/upgrade", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId: customerOrgId,
          planId,
          successUrl: successUrl ?? window.location.href,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Failed to start checkout");
        return;
      }
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      toast.success("Plan updated");
      setOpen(false);
    } finally {
      setLoading(false);
      setSelectedPlan(null);
    }
  }

  if (!isFree && !showManageWhenPaid) return null;

  if (isFree) {
    const classes = variant === "header"
      ? "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground disabled:opacity-50"
      : "inline-flex h-9 items-center gap-2 bg-foreground px-4 text-sm font-medium text-background transition-all hover:opacity-90 disabled:opacity-50";

    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={loading || !customerOrgId}
          className={[classes, className].filter(Boolean).join(" ")}
        >
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Upgrade"}
        </button>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl w-full">
            <DialogHeader>
              <DialogTitle>Choose a plan</DialogTitle>
              <DialogDescription>
                Pick the paid plan that matches your current usage. You can manage billing afterwards from the customer portal.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-3 py-2 sm:grid-cols-2">
              {paidPlans.map((paidPlan) => (
                <button
                  key={paidPlan.id}
                  type="button"
                  onClick={() => upgradeToPlan(paidPlan.id)}
                  disabled={loading}
                  className="flex min-h-[260px] flex-col border border-border bg-card p-5 text-left transition-colors hover:border-foreground/30 hover:bg-secondary/30 disabled:opacity-60"
                >
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {paidPlan.name}
                    </p>
                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="text-3xl font-extrabold">{paidPlan.price}</span>
                      <span className="text-sm text-muted-foreground">/ month</span>
                    </div>
                    <p className="mt-2 text-sm text-muted-foreground">{paidPlan.description}</p>
                  </div>

                  <ul className="mt-5 grow space-y-2.5">
                    {paidPlan.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-foreground" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>

                  <span className="mt-5 inline-flex h-9 items-center justify-center gap-2 bg-foreground px-4 text-sm font-medium text-background">
                    {loading && selectedPlan === paidPlan.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        Continue
                        <ArrowRight className="h-3.5 w-3.5" />
                      </>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => openCustomerPortal()}
      className={["inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground", className].filter(Boolean).join(" ")}
    >
      <span>Manage plan</span>
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}
