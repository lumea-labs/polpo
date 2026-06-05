"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  Check,
  Loader2,
  SquarePen,
  Settings,
} from "lucide-react";
import { ConnectButton } from "#/components/dashboard/connect-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Single-tenant top header: brandmark + Connect + Docs. No org breadcrumb,
 * plan badge, credits or user menu — those are cloud-only surfaces.
 */
export function TopHeader() {
  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-card px-4 md:px-5 shrink-0">
      <div className="flex items-center gap-3 min-w-0">
        <Link href="/projects/local" data-testid="header-logo" className="flex items-center shrink-0">
          <Image
            src="/polpo-brandmark.svg"
            alt="Polpo"
            width={24}
            height={24}
            priority
            className="h-[18px] w-[18px]"
          />
        </Link>
      </div>

      <div className="flex items-center gap-2 shrink-0">
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
      </div>
    </header>
  );
}

/**
 * Project name → lightweight rename popover. Same data-plane endpoint as
 * settings-form. `orgId` is accepted (optional, unused) for call-site parity
 * with the cloud sidebar.
 */
type Mode = "menu" | "rename";

export function ProjectSwitcher({
  projectId,
  projectName,
  variant = "header",
}: {
  projectId: string;
  projectName: string;
  orgId?: string;
  variant?: "header" | "sidebar";
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("menu");
  const [name, setName] = useState(projectName);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
            <button
              type="button"
              onClick={() => setMode("rename")}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm leading-5 text-muted-foreground hover:bg-secondary/50 hover:text-foreground transition-colors"
            >
              <SquarePen className="h-3.5 w-3.5 shrink-0" />
              Rename project
            </button>
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
