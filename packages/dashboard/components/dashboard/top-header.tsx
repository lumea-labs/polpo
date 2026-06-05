"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCustomer } from "autumn-js/react";
import {
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  ChevronDown,
  Check,
  Coins,
  Loader2,
  SquarePen,
  Settings,
} from "lucide-react";
import { fetchControlPlane } from "@/lib/data-client";
import { UserMenu } from "@/components/dashboard/user-menu";
import { ConnectButton } from "@/components/dashboard/connect-dialog";
import { InferenceCreditsBadge } from "@/components/dashboard/inference-credits";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface TopHeaderProps {
  orgId: string;
  orgName: string;
  userEmail: string;
  userImage?: string;
}

export function TopHeader({ orgId, orgName, userEmail, userImage }: TopHeaderProps) {
  const { data: customer } = useCustomer();
  const plan = ((customer as { subscriptions?: { planId?: string }[] } | undefined)
    ?.subscriptions?.[0]?.planId) ?? "free";

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-card px-4 md:px-5 shrink-0">
      {/* Left: logo + breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/projects" data-testid="header-logo" className="flex items-center shrink-0">
          <Image
            src="/polpo-brandmark.svg"
            alt="Polpo"
            width={24}
            height={24}
            priority
            className="h-[18px] w-[18px]"
          />
        </Link>

        <span aria-hidden="true" className="text-muted-foreground/40 shrink-0">/</span>

        {/* Breadcrumb: org [plan] / project */}
        <nav className="flex items-center gap-2 text-sm min-w-0" aria-label="Breadcrumb">
          <Link
            href="/projects"
            data-testid="org-switcher"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors min-w-0 truncate"
          >
            {orgName}
          </Link>

          <Link
            href="/billing"
            data-testid="plan-badge"
            title="Manage billing plan"
            className={
              plan === "free"
                ? "rounded bg-secondary px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground shrink-0 transition-colors hover:bg-secondary/80 hover:text-foreground"
                : "rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 px-1.5 py-0.5 text-[9px] font-mono font-semibold uppercase tracking-wider shrink-0 transition-colors hover:bg-emerald-500/20"
            }
          >
            {plan}
          </Link>

          {/* Project switcher moved to the sidebar — header keeps only the
              org breadcrumb + plan badge. */}
        </nav>
      </div>

      {/* Right: credits + connect + docs + avatar */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Hide on small screens — compact already, but the breadcrumb + avatar
            still need room. Always rendered now (incl. /llm-gateway) so the
            credit balance is reachable from every surface. */}
        <div className="hidden lg:block">
          <InferenceCreditsBadge orgId={orgId} compact />
        </div>

        {plan === "free" && (
          <Link
            href="/billing?upgrade=1"
            className="hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/50 hover:text-foreground sm:inline-flex"
          >
            Upgrade
          </Link>
        )}

        <ConnectButton />

        <a
          href="https://docs.polpo.sh"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="header-docs"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        >
          <BookOpen className="h-3.5 w-3.5" strokeWidth={1.5} />
          <span className="hidden sm:inline">Docs</span>
        </a>

        <UserMenu userEmail={userEmail} userImage={userImage} />
      </div>
    </header>
  );
}

/**
 * Project name in the breadcrumb turns into a lightweight popover: click
 * opens an inline rename + a shortcut to the full settings page. Same
 * endpoint as settings-form.tsx; rename invalidates the ["project", id]
 * query so the TopHeader breadcrumb + sidebar badges pick up the new
 * name without a route refresh.
 */
type Mode = "menu" | "rename";

export function ProjectSwitcher({
  projectId,
  projectName,
  orgId,
  variant = "header",
}: {
  projectId: string;
  projectName: string;
  orgId: string;
  /** Where this switcher renders. Header = compact pill matching the
   *  breadcrumb chrome. Sidebar = full-width row so it sits flush in
   *  the project nav above the section headings. */
  variant?: "header" | "sidebar";
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(projectName);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inference credit balance from the billing endpoint — same source the
  // LLM Gateway page uses, so the two views never disagree.
  const { data: balanceData } = useQuery({
    queryKey: ["inference-balance", orgId],
    queryFn: () =>
      fetchControlPlane<{ ok: boolean; data: { remaining: number; used: number } | null }>(
        `/v1/billing/inference/balance?orgId=${orgId}`,
      ),
    enabled: !!orgId,
    staleTime: 30_000,
  });
  const aiBalance = balanceData?.data?.remaining;

  const renameMutation = useMutation({
    mutationFn: async (newName: string) => {
      const res = await fetch(`${API_URL}/v1/projects/${projectId}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d?.error ?? `Failed (${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1200);
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const changed = name.trim() !== projectName && name.trim().length > 0;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setMode("menu");
          setName(projectName);
          setError(null);
          setSaved(false);
        }
      }}
    >
      <PopoverTrigger
        data-testid={variant === "sidebar" ? "sidebar-project-switcher" : "header-project-switcher"}
        className={
          variant === "sidebar"
            ? "group flex w-full items-center justify-between gap-1.5 border border-border bg-card px-2.5 py-1.5 text-sm font-medium truncate text-foreground hover:border-foreground/30 data-[popup-open]:border-foreground/40 data-[popup-open]:bg-secondary/50 transition-colors"
            : "group inline-flex items-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium truncate text-foreground hover:border-border hover:bg-secondary/70 data-[popup-open]:border-border data-[popup-open]:bg-secondary transition-colors"
        }
      >
        <span className="truncate">{projectName}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72 p-2">
        {mode === "menu" ? (
          <div className="flex flex-col">
            {/* LLM credits — same padding + typography + leading as the
                action rows below, just non-interactive with an inline
                Manage link on the right. */}
            <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 text-muted-foreground">
              <Coins className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">
                LLM credits{" "}
                <span className="font-medium text-foreground">
                  {aiBalance !== undefined ? `$${aiBalance.toFixed(2)}` : "—"}
                </span>
              </span>
              <Link
                href="/llm-gateway"
                onClick={() => setOpen(false)}
                className="shrink-0 text-sm font-medium leading-5 text-foreground hover:underline underline-offset-4"
              >
                Manage
              </Link>
            </div>

            <button
              type="button"
              onClick={() => setMode("rename")}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
            >
              <SquarePen className="h-3.5 w-3.5 shrink-0" />
              Rename project
            </button>
            <Link
              href="/projects"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
            >
              <ArrowRightLeft className="h-3.5 w-3.5 shrink-0" />
              Switch project
            </Link>
            <Link
              href={`/projects/${projectId}/settings`}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
            >
              <Settings className="h-3.5 w-3.5 shrink-0" />
              Project settings
            </Link>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (changed) renameMutation.mutate(name.trim());
            }}
            className="flex flex-col gap-2 p-1"
          >
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setMode("menu")}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3 w-3" />
                Back
              </button>
              <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
                Rename
              </span>
            </div>
            <div className="flex items-stretch gap-2">
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                className="flex-1 min-w-0 border border-border bg-transparent px-2.5 py-1.5 text-sm focus:border-foreground/30 focus:outline-none transition-colors"
              />
              <button
                type="submit"
                disabled={!changed || renameMutation.isPending}
                className="rounded border border-border bg-foreground/5 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-foreground hover:text-background transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {renameMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : saved ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  "Save"
                )}
              </button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
