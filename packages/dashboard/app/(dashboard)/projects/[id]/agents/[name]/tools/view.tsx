"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Lock,
  Loader2,
  Terminal,
  Globe,
  Image as ImageIcon,
  Video,
  Volume2,
  Search,
  Mail,
  Sheet,
  FileText,
  FileType,
  Brain,
  // per-tool icons
  FilePlus,
  FilePen,
  SquareTerminal,
  FileSearch,
  TextSearch,
  FolderTree,
  Download,
  Flag,
  KeyRound,
  Compass,
  ScanText,
  MousePointerClick,
  Keyboard,
  Camera,
  Eye,
  ListChecks,
  MousePointer2,
  MousePointer,
  Clock,
  Code,
  X,
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Columns3,
  AudioLines,
  Send,
  Inbox,
  MailOpen,
  Paperclip,
  ShieldCheck,
  Hash,
  Table,
  Info,
  Merge,
  Save,
  Plus,
  Pencil,
  type LucideIcon,
} from "lucide-react";
import type { AgentConfig } from "@polpo-ai/core";
import { SectionHeader } from "#/components/dashboard/section-header";
import {
  TOOL_CATALOG,
  CATALOG_TOOL_NAMES,
  isToolEnabled,
  hasGroupWildcard,
} from "#/lib/tool-catalog";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const ICONS: Record<string, LucideIcon> = {
  Terminal,
  Globe,
  Image: ImageIcon,
  Video,
  Volume2,
  Search,
  Mail,
  Sheet,
  FileText,
  FileType,
  Brain,
  ShieldCheck,
};

/**
 * Tools the runtime keeps ON only while `allowedTools` is unset — the moment
 * an agent sets any `allowedTools`, the core filters these out unless they're
 * explicitly listed. So any edit must first "materialise" this baseline (pin
 * the names) to avoid silently stripping the agent's file/shell/HTTP tools.
 */
const BASELINE_TOOLS = [
  "read", "write", "edit", "bash", "glob", "grep", "ls", "http_fetch", "http_download",
];

/** Empty allowedTools ⇒ runtime gives all baseline tools. Pin them before
 *  any edit so they survive once the list becomes non-empty. */
const materialize = (allowed: string[]): string[] =>
  allowed.length === 0 ? [...BASELINE_TOOLS] : allowed;

/** Reverse tidy: if the list ends up as exactly the full baseline (nothing
 *  extra, nothing missing), collapse back to [] — the clean "defaults" state. */
function tidyBaseline(allowed: string[]): string[] {
  const onlyBaseline = allowed.length > 0 && allowed.every((t) => BASELINE_TOOLS.includes(t));
  const allOn = BASELINE_TOOLS.every((t) => allowed.includes(t));
  return onlyBaseline && allOn ? [] : allowed;
}

/** Explicit (no-wildcard) single-tool toggle for baseline groups. */
function toggleToolExplicit(base: string[], name: string, enable: boolean): string[] {
  if (enable) return base.includes(name) ? base : [...base, name];
  return base.filter((t) => t !== name);
}

/** Explicit (no-wildcard) whole-group toggle for baseline groups. */
function toggleCategoryExplicit(base: string[], names: string[], enable: boolean): string[] {
  const without = base.filter((t) => !names.includes(t));
  return enable ? [...without, ...names] : without;
}

/** An appropriate icon per individual tool. Falls back to the category
 *  icon when a tool isn't mapped. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  // core
  read: FileText, write: FilePlus, edit: FilePen, bash: SquareTerminal,
  glob: FileSearch, grep: TextSearch, ls: FolderTree, http_fetch: Globe,
  http_download: Download, register_outcome: Flag, vault_get: KeyRound, vault_list: KeyRound,
  // browser
  browser_navigate: Compass, browser_snapshot: ScanText, browser_click: MousePointerClick,
  browser_fill: FilePen, browser_type: Keyboard, browser_press: Keyboard,
  browser_screenshot: Camera, browser_get: Eye, browser_select: ListChecks,
  browser_hover: MousePointer2, browser_scroll: MousePointer, browser_wait: Clock,
  browser_eval: Code, browser_close: X, browser_back: ArrowLeft, browser_forward: ArrowRight,
  browser_reload: RotateCw, browser_tabs: Columns3,
  // image / video
  image_generate: ImageIcon, image_analyze: Eye, video_generate: Video,
  // audio
  audio_transcribe: AudioLines, audio_speak: Volume2,
  // search
  search_web: Search, search_find_similar: Search,
  // email
  email_send: Send, email_draft: FilePen, email_list: Inbox, email_read: MailOpen,
  email_search: Search, email_download_attachment: Paperclip, email_verify: ShieldCheck,
  email_count: Hash,
  // excel
  excel_read: Table, excel_write: Sheet, excel_query: Search, excel_info: Info,
  // pdf / docx
  pdf_read: FileText, pdf_create: FilePlus, pdf_merge: Merge, pdf_info: Info,
  docx_read: FileText, docx_create: FilePlus,
  // memory
  memory_get: Brain, memory_save: Save, memory_append: Plus, memory_update: Pencil,
};

const iconForTool = (name: string, fallback: LucideIcon): LucideIcon =>
  TOOL_ICONS[name] ?? fallback;

/* ── allowedTools edit helpers ──────────────────────────────────── */

const wildcardOf = (groupKey: string) => `${groupKey}*`;

/** Expand a group wildcard into its explicit tool names (so a single
 *  tool can then be toggled off without disabling the whole group). */
function expandWildcard(allowed: string[], groupKey: string, groupTools: string[]) {
  const wc = wildcardOf(groupKey);
  if (!allowed.includes(wc)) return allowed;
  const next = allowed.filter((t) => t !== wc);
  for (const n of groupTools) if (!next.includes(n)) next.push(n);
  return next;
}

function toggleTool(
  allowed: string[],
  groupKey: string,
  groupTools: string[],
  name: string,
  enable: boolean,
): string[] {
  let next = expandWildcard(allowed, groupKey, groupTools);
  if (enable) {
    if (!next.includes(name)) next = [...next, name];
  } else {
    next = next.filter((t) => t !== name);
  }
  // Tidy: all group tools on → collapse back to the wildcard.
  if (groupTools.length > 1 && groupTools.every((n) => next.includes(n))) {
    next = next.filter((t) => !groupTools.includes(t));
    next.push(wildcardOf(groupKey));
  }
  return next;
}

function toggleCategory(
  allowed: string[],
  groupKey: string,
  groupTools: string[],
  enable: boolean,
): string[] {
  const next = allowed.filter(
    (t) => t !== wildcardOf(groupKey) && !groupTools.includes(t),
  );
  if (enable) next.push(wildcardOf(groupKey));
  return next;
}

/* ── Sharp toggle switch ────────────────────────────────────────── */

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-4 w-7 shrink-0 items-center border transition-colors ${
        checked ? "border-emerald-500 bg-emerald-500/20" : "border-border bg-secondary"
      } ${disabled ? "cursor-not-allowed opacity-40" : "cursor-pointer"}`}
    >
      <span
        aria-hidden
        className={`block h-3 w-3 transition-transform ${
          checked ? "translate-x-[13px] bg-emerald-500" : "translate-x-[1px] bg-muted-foreground"
        }`}
      />
    </button>
  );
}

interface CategoryTab {
  key: string;
  label: string;
  icon: LucideIcon;
  core?: boolean;
  baseline?: boolean;
  requiresKey?: boolean;
  note?: string;
  /** Catalog tool names of this group (for toggle math). */
  groupTools: string[];
  wildcard: boolean;
  enabled: number;
  total: number;
  tools: { name: string; description: string; enabled: boolean }[];
}

export default function AgentToolsView({
  agent,
  projectId,
}: {
  agent: AgentConfig | null;
  projectId: string;
}) {
  const router = useRouter();
  const [allowed, setAllowed] = useState<string[]>(agent?.allowedTools ?? []);
  const [saving, setSaving] = useState(false);

  const customTools = allowed.filter(
    (t) => !t.endsWith("*") && !CATALOG_TOOL_NAMES.has(t),
  );

  // Baseline groups are all-on while allowedTools is unset (mirrors runtime).
  const baselineDefault = allowed.length === 0;

  const tabs: CategoryTab[] = TOOL_CATALOG.map((g) => {
    const groupTools = g.tools.map((t) => t.name);
    const tools = g.tools.map((t) => ({
      name: t.name,
      description: t.description,
      enabled: g.core || (g.baseline && baselineDefault) || isToolEnabled(t.name, allowed),
    }));
    return {
      key: g.key,
      label: g.label,
      icon: ICONS[g.icon] ?? Terminal,
      core: g.core,
      baseline: g.baseline,
      requiresKey: g.requiresKey,
      note: g.note,
      groupTools,
      // Baseline groups never collapse to a wildcard (their names have no
      // shared prefix the runtime understands) — always explicit.
      wildcard: !g.core && !g.baseline && hasGroupWildcard(g.key, allowed),
      enabled: tools.filter((t) => t.enabled).length,
      total: tools.length,
      tools,
    };
  });

  if (customTools.length > 0) {
    tabs.push({
      key: "__custom",
      label: "Custom",
      icon: Terminal,
      groupTools: customTools,
      wildcard: false,
      enabled: customTools.length,
      total: customTools.length,
      note: "Tools enabled for this agent that aren't in the standard catalog.",
      tools: customTools.map((name) => ({
        name,
        description: "Custom tool enabled for this agent.",
        enabled: true,
      })),
    });
  }

  const firstActive =
    tabs.find((t) => !t.core && t.enabled > 0)?.key ?? tabs[0]?.key ?? "core";
  const [active, setActive] = useState(firstActive);

  async function persist(next: string[]) {
    if (!agent) return;
    const prev = allowed;
    setAllowed(next); // optimistic
    setSaving(true);
    try {
      const res = await fetch(
        `${API_URL}/v1/projects/${projectId}/data/v1/agents/${encodeURIComponent(agent.name)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowedTools: next }),
        },
      );
      if (!res.ok) {
        setAllowed(prev); // rollback
      } else {
        router.refresh();
      }
    } catch {
      setAllowed(prev);
    }
    setSaving(false);
  }

  /** Run a toggle against the materialised baseline, then tidy + persist.
   *  Every edit goes through here so enabling an extended tool never silently
   *  strips the file/shell/HTTP baseline. */
  const applyEdit = (fn: (base: string[]) => string[]) =>
    persist(tidyBaseline(fn(materialize(allowed))));

  if (!agent) {
    return (
      <div
        data-testid="agent-not-found"
        className="border border-border p-8 text-center text-sm text-muted-foreground"
      >
        Agent not found.
      </div>
    );
  }

  const activeTab = tabs.find((t) => t.key === active) ?? tabs[0];

  return (
    <div>
      <SectionHeader
        description={
          <span className="inline-flex items-center gap-1.5">
            Toggle the tools this agent can call. Vault access is always on; file,
            shell and HTTP tools are on until you customise the selection.
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
          </span>
        }
      />

      <div className="mt-4 flex flex-col gap-6 md:flex-row md:gap-8">
        {/* Vertical category nav — sticky; only the tool list (right) scrolls. */}
        <nav className="flex shrink-0 flex-col gap-0.5 md:w-48 md:self-start md:sticky md:top-0">
          {tabs.map((t) => {
            const Icon = t.icon;
            const isActive = t.key === active;
            const hot = t.enabled > 0;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActive(t.key)}
                className={`flex items-center gap-2 border-l-2 px-3 py-1.5 text-sm transition-colors ${
                  isActive
                    ? "border-foreground bg-foreground/5 font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${isActive || hot ? "" : "text-muted-foreground/50"}`}
                  strokeWidth={1.5}
                />
                <span className="flex-1 text-left">{t.label}</span>
                <span
                  className={`font-mono text-[10px] font-bold tabular-nums ${
                    hot ? "text-emerald-500" : "text-muted-foreground/40"
                  }`}
                >
                  {t.core ? t.total : `${t.enabled}/${t.total}`}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Active category — flat (no card background) */}
        <div className="min-w-0 flex-1">
          {activeTab && (
            <div>
              {/* Category status + master toggle */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 pb-2.5">
                {activeTab.core ? (
                  <span className="font-mono text-[9px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
                    always on
                  </span>
                ) : (
                  <>
                    <Switch
                      checked={activeTab.enabled > 0}
                      disabled={activeTab.key === "__custom"}
                      onChange={(v) =>
                        applyEdit((base) =>
                          activeTab.baseline
                            ? toggleCategoryExplicit(base, activeTab.groupTools, v)
                            : toggleCategory(base, activeTab.key, activeTab.groupTools, v),
                        )
                      }
                    />
                    <span
                      className={`font-mono text-[10px] font-bold uppercase tracking-[0.12em] ${
                        activeTab.enabled > 0 ? "text-emerald-500" : "text-muted-foreground/40"
                      }`}
                    >
                      {activeTab.enabled === 0
                        ? "All off"
                        : activeTab.enabled === activeTab.total
                          ? "All enabled"
                          : `${activeTab.enabled} of ${activeTab.total} on`}
                    </span>
                  </>
                )}
                {activeTab.requiresKey && (
                  <span
                    className="ml-auto inline-flex items-center gap-1 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60"
                    title="Needs an external API key / credential"
                  >
                    <Lock className="h-3 w-3" strokeWidth={2} />
                    key
                  </span>
                )}
              </div>

              {activeTab.note && (
                <p className="border-b border-border/60 py-2 text-[11px] leading-relaxed text-muted-foreground/70">
                  {activeTab.note}
                </p>
              )}

              <div>
                {activeTab.tools.map((t) => {
                  const ToolIcon = iconForTool(t.name, activeTab.icon);
                  const isCore = !!activeTab.core;
                  const on = isCore || t.enabled;
                  return (
                    <div
                      key={t.name}
                      className="flex items-center gap-3 border-b border-border/60 py-2.5 last:border-0"
                    >
                      <ToolIcon
                        className={`h-4 w-4 shrink-0 ${on ? "text-foreground" : "text-muted-foreground/40"}`}
                        strokeWidth={1.5}
                      />
                      <div className="min-w-0 flex-1">
                        <span
                          className={`font-mono text-xs ${on ? "text-foreground" : "text-muted-foreground/60"}`}
                        >
                          {t.name}
                        </span>
                        <p
                          className="truncate text-[11px] text-muted-foreground/70"
                          title={t.description}
                        >
                          {t.description}
                        </p>
                      </div>
                      {/* Switch always on the right. Core tools show it
                          checked + disabled (can't be turned off). */}
                      <Switch
                        checked={on}
                        disabled={isCore || activeTab.key === "__custom"}
                        onChange={(v) =>
                          applyEdit((base) =>
                            activeTab.baseline
                              ? toggleToolExplicit(base, t.name, v)
                              : toggleTool(base, activeTab.key, activeTab.groupTools, t.name, v),
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground/60">
        Some categories need an external key (vault).{" "}
        <a
          href="https://docs.polpo.sh/docs/agents/tools"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground"
        >
          Tool docs →
        </a>
      </p>
    </div>
  );
}
