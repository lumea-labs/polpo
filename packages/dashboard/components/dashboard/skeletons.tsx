import { Skeleton } from "@/components/ui/skeleton";
import { Shield } from "lucide-react";

/* ─── Helpers ─── */

function StatCardSkeleton({ label }: { label: string }) {
  return (
    <div className="border border-border bg-card p-4">
      <div className="flex items-center gap-2 mb-2">
        <Skeleton className="h-3.5 w-3.5 rounded" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      <Skeleton className="h-7 w-12" />
    </div>
  );
}

function TableRowSkeleton({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-border last:border-0">
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <Skeleton className="h-3.5 w-full max-w-[120px]" />
        </td>
      ))}
    </tr>
  );
}

function TableSkeleton({
  headers,
  rows = 4,
  minW = "min-w-[600px]",
  lastRight = false,
}: {
  headers: string[];
  rows?: number;
  minW?: string;
  lastRight?: boolean;
}) {
  return (
    <div className="mt-4 border border-border overflow-hidden overflow-x-auto">
      <table className={`w-full text-sm ${minW}`}>
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            {headers.map((h, i) => (
              <th
                key={h}
                className={`px-4 py-2.5 text-xs font-medium text-muted-foreground ${
                  lastRight && i === headers.length - 1 ? "text-right" : "text-left"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRowSkeleton key={i} cols={headers.length} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DetailTableSkeleton({ rows }: { rows: { label: string }[] }) {
  return (
    <div className="mt-3 border border-border bg-card overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[320px]">
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border last:border-0">
              <td className="px-4 py-2.5 text-xs text-muted-foreground w-32">{row.label}</td>
              <td className="px-4 py-2.5">
                <Skeleton className="h-3 w-32" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Page Skeletons ─── */

/** Project overview: title + status badge + 4 stat cards + swarm panel */
export function ProjectOverviewSkeleton() {
  return (
    <div>
      {/* Title + Ready/Running badge — matches view.tsx page header */}
      <div className="mb-6 flex items-center gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        <StatCardSkeleton label="Agents" />
        <StatCardSkeleton label="Tasks" />
        <StatCardSkeleton label="Missions" />
        <StatCardSkeleton label="Sessions" />
      </div>

      {/* Swarm panel — status bar + recent runs list. Mirrors the real
          layout in view.tsx so the transition skeleton → live data has
          zero layout shift. */}
      <div className="mt-8 flex flex-col gap-4">
        <Skeleton className="h-11 w-full" />

        <div className="border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0"
            >
              <Skeleton className="size-2 rounded-full" />
              <Skeleton className="h-3 w-[68px]" />
              <span className="flex items-center gap-1.5">
                <Skeleton className="size-4" />
                <Skeleton className="h-3 w-[88px]" />
              </span>
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="hidden h-3 w-[18%] md:inline-block" />
              <Skeleton className="h-3 w-12" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Agents list: heading + flex list matching AgentsTable layout */
export function AgentsListSkeleton() {
  return (
    <div>
      {/* Header: "Agents" h2 + description */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Agents</h2>
        <Skeleton className="mt-1 h-3 w-48" />
      </div>

      {/* Toolbar: search + tabs toggle + refresh */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>

      {/* Table: Agent / Team / Model / Tools */}
      <div className="mt-4 border border-border overflow-hidden overflow-x-auto">
        <div className="min-w-[600px]">
          <div className="flex items-center border-b border-border bg-secondary/50 text-left text-xs font-medium text-muted-foreground">
            <span className="px-4 py-2.5 flex-1">Agent</span>
            <span className="px-4 py-2.5 flex-1">Team</span>
            <span className="px-4 py-2.5 flex-1">Model</span>
            <span className="px-4 py-2.5 w-20">Tools</span>
            <span className="w-8" />
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center border-b border-border last:border-0">
              <span className="px-4 py-3 flex-1 space-y-1">
                <Skeleton className="h-3.5 w-24" />
                <Skeleton className="h-2.5 w-32" />
              </span>
              <span className="px-4 py-3 flex-1">
                <Skeleton className="h-4 w-14 rounded" />
              </span>
              <span className="px-4 py-3 flex-1">
                <Skeleton className="h-3 w-32" />
              </span>
              <span className="px-4 py-3 w-20">
                <Skeleton className="h-3 w-6" />
              </span>
              <span className="px-2 py-3 w-8">
                <Skeleton className="h-3.5 w-3.5 rounded" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Section heading placeholder — title line + description line. Mirrors
 *  the real <SectionHeader> so the swap has no layout shift. */
function SectionHeaderSkeleton({ descW = "w-80" }: { descW?: string }) {
  return (
    <div>
      <Skeleton className="h-4 w-28" />
      <Skeleton className={`mt-1.5 h-3 ${descW}`} />
    </div>
  );
}

/** Agent capabilities: section header + 4 capability card rows, each with
 *  a header (monogram + name + status) and a full-width model area. Matches
 *  <AgentCapabilities>. */
export function AgentProfileSkeleton() {
  return (
    <div>
      <SectionHeaderSkeleton />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => {
          // Text + Video are single-slot, Image + Audio are two-slot.
          const slots = i === 0 || i === 3 ? 1 : 2;
          return (
            <div key={i} className="border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <Skeleton className="h-4 w-4" />
                  <Skeleton className="h-3.5 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="hidden h-3 w-48 sm:block" />
              </div>
              <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
                {Array.from({ length: slots }).map((_, j) => (
                  <div key={j} className={slots === 1 ? "sm:col-span-2" : ""}>
                    <Skeleton className="mb-1.5 h-2.5 w-20" />
                    <Skeleton className="h-[68px] w-full" />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Agent tools: section header + accordion bars (one per tool category).
 *  Matches AgentToolsView's <details> list. */
export function AgentToolsSkeleton() {
  return (
    <div>
      <SectionHeaderSkeleton descW="w-72" />
      <div className="mt-4 flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border border-border bg-card">
            <div className="flex items-center gap-3 px-3 py-2.5">
              <Skeleton className="h-3.5 w-3.5" />
              <Skeleton className="h-4 w-4" />
              <Skeleton className="h-3.5 w-20" />
              <Skeleton className="h-3 w-8" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Agent skills: section header + card grid. Matches AgentSkillsView. */
export function AgentSkillsSkeleton() {
  return (
    <div>
      <SectionHeaderSkeleton descW="w-80" />
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 border border-border bg-card p-3">
            <Skeleton className="size-7" />
            <Skeleton className="h-3.5 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Agent identity: avatar + profile + persona + responsibilities + socials */
export function AgentIdentitySkeleton() {
  const sectionBlock = (rows: number) => (
    <div className="border border-border bg-card px-4">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-baseline gap-6 border-b border-border py-3 last:border-0">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3.5 w-40" />
        </div>
      ))}
    </div>
  );

  return (
    <div>
      {/* Avatar row */}
      <div className="flex items-center gap-4">
        <Skeleton className="h-16 w-16 rounded-full" />
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3.5 w-48" />
        </div>
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-2">Profile</h3>
        {sectionBlock(5)}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-2">Persona</h3>
        {sectionBlock(3)}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-2">Responsibilities</h3>
        {sectionBlock(2)}
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold mb-2">Socials</h3>
        {sectionBlock(2)}
      </div>
    </div>
  );
}

/** Agent system prompt: mono-space block */
export function AgentPromptSkeleton() {
  return (
    <div>
      <Skeleton className="h-3 w-32" />
      <div className="mt-3 border border-border bg-card p-6 space-y-3">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3.5 w-full" />
      </div>
    </div>
  );
}

/** Agent vault: description + table (3 cols) */
export function AgentVaultSkeleton() {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-4">
        Service credentials this agent can access at runtime via the vault_get tool.
      </p>
      <TableSkeleton headers={["Service", "Type", "Label"]} rows={3} minW="min-w-[400px]" />
      <div className="mt-6 flex gap-3 border border-border bg-card p-4">
        <Shield className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-medium">Encrypted at rest</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Values are AES-256-GCM encrypted. Never exposed in the dashboard.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Sessions list: heading + filter bar + rows matching the real view */
export function SessionsListSkeleton() {
  return (
    <div>
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Sessions</h2>
        <Skeleton className="mt-1 h-3 w-48" />
      </div>
      {/* Filter bar — search input, agent filter, refresh */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-7 w-24" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      {/* Rows */}
      <div className="mt-4 border border-border overflow-hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center border-b border-border last:border-0"
          >
            <div className="flex-1 px-4 py-3 min-w-0 space-y-1.5">
              <Skeleton className="h-3.5 w-48" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-16 rounded" />
                <Skeleton className="h-2.5 w-32" />
              </div>
            </div>
            <div className="flex items-center gap-4 px-4 py-3 shrink-0">
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="h-2.5 w-14" />
            </div>
            <div className="px-3">
              <Skeleton className="h-3 w-3 rounded-full" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Session detail: back link + header + raw-view table */
export function SessionDetailSkeleton() {
  return (
    <div>
      {/* Back link */}
      <Skeleton className="h-3 w-20" />
      {/* Header */}
      <div className="mt-4">
        <Skeleton className="h-5 w-56" />
        <div className="mt-2 flex items-center gap-3">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-16 rounded" />
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
      </div>
      {/* Raw-view table */}
      <div className="mt-5 border border-border overflow-hidden">
        {/* Header row */}
        <div className="flex border-b border-border bg-muted/40 px-3 py-2 gap-3">
          <Skeleton className="h-2.5 w-10" />
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-12" />
          <Skeleton className="h-2.5 w-24 hidden md:block" />
          <Skeleton className="h-2.5 flex-1" />
          <Skeleton className="h-2.5 w-20" />
        </div>
        {/* Data rows — alternating msg + tool patterns */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className={`flex items-center border-b border-border last:border-0 px-3 py-2 gap-3 ${i % 3 === 2 ? "bg-muted/10" : ""}`}>
            <Skeleton className="h-4 w-9 rounded" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-32 hidden md:block" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Agent memory view */
export function AgentMemorySkeleton() {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-4">
        Private memory this agent accumulates across sessions. This agent also inherits
        the shared project memory.
      </p>
      <div className="border border-border bg-card p-6 space-y-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-5/6" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    </div>
  );
}

/** Project memory view — title + description live in page.tsx so the
 *  skeleton only renders the body placeholder (avoids double-title flash
 *  during streaming Suspense load). */
export function ProjectMemorySkeleton() {
  return (
    <div className="mt-6 border border-border bg-card p-6 space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-5/6" />
      <Skeleton className="h-3.5 w-2/3" />
    </div>
  );
}

/** Tasks list: heading + flex list matching tasks view layout */
export function TasksListSkeleton() {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Tasks</h2>
      <Skeleton className="mt-1 h-3 w-20" />
      <div className="mt-4 border border-border overflow-hidden overflow-x-auto min-w-[600px]">
        {/* Header */}
        <div className="flex items-center border-b border-border bg-secondary/50 text-left text-xs font-medium text-muted-foreground">
          <span className="px-4 py-2.5 w-28">Status</span>
          <span className="px-4 py-2.5 flex-1">Task</span>
          <span className="px-4 py-2.5 w-24">Agent</span>
          <span className="px-4 py-2.5 w-20">Duration</span>
          <span className="px-4 py-2.5 w-16">Retries</span>
          <span className="px-4 py-2.5 w-20 text-right">Updated</span>
          <span className="w-8" />
        </div>
        {/* Rows */}
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center border-b border-border last:border-0">
            <span className="px-4 py-3 w-28">
              <span className="inline-flex items-center gap-1.5">
                <Skeleton className="h-2 w-2 rounded-full" />
                <Skeleton className="h-3 w-14" />
              </span>
            </span>
            <span className="px-4 py-3 flex-1">
              <Skeleton className="h-3.5 w-40" />
            </span>
            <span className="px-4 py-3 w-24">
              <Skeleton className="h-3 w-16" />
            </span>
            <span className="px-4 py-3 w-20">
              <Skeleton className="h-3 w-10" />
            </span>
            <span className="px-4 py-3 w-16">
              <Skeleton className="h-3 w-8" />
            </span>
            <span className="px-4 py-3 w-20 text-right">
              <Skeleton className="ml-auto h-3 w-12" />
            </span>
            <span className="px-2 py-3 w-8">
              <Skeleton className="h-3.5 w-3.5 rounded" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Task detail: status + title + 4 meta cards + details table */
export function TaskDetailSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-2.5 w-2.5 rounded-full" />
        <Skeleton className="h-5 w-56" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-full max-w-md" />

      <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 sm:grid-cols-4">
        <StatCardSkeleton label="Agent" />
        <StatCardSkeleton label="Status" />
        <StatCardSkeleton label="Phase" />
        <StatCardSkeleton label="Retries" />
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-semibold">Details</h3>
        <DetailTableSkeleton
          rows={[
            { label: "Mission" },
            { label: "Dependencies" },
            { label: "Side effects" },
            { label: "Session" },
            { label: "Created" },
            { label: "Updated" },
          ]}
        />
      </div>
    </div>
  );
}

/** Task output: meta bar + stdout block */
export function TaskOutputSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-6 mb-4 text-xs text-muted-foreground">
        <span>Exit code: <Skeleton className="inline-block h-3 w-6 align-middle" /></span>
        <span>Duration: <Skeleton className="inline-block h-3 w-10 align-middle" /></span>
      </div>
      <h3 className="text-sm font-semibold">stdout</h3>
      <div className="mt-3 border border-border bg-card p-5 space-y-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-full" />
      </div>
    </div>
  );
}

/** Task assessment: summary bar + checks + score cards */
export function TaskAssessmentSkeleton() {
  return (
    <div>
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="h-3 w-3 rounded-full" />
          <Skeleton className="h-4 w-16" />
        </div>
        <Skeleton className="h-7 w-14" />
      </div>

      {/* Checks */}
      <section className="mt-8">
        <h3 className="text-sm font-semibold">Expectation checks</h3>
        <div className="mt-3 border border-border overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border last:border-0 px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-40" />
              </div>
              <Skeleton className="h-2 w-2 rounded-full" />
            </div>
          ))}
        </div>
      </section>

      {/* Score cards */}
      <section className="mt-8">
        <h3 className="text-sm font-semibold">G-Eval dimensions</h3>
        <div className="mt-3 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-10" />
              </div>
              <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
              <Skeleton className="mt-3 h-3 w-full" />
              <Skeleton className="mt-1 h-3 w-4/5" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** Missions list: heading + table (6 cols) */
export function MissionsListSkeleton() {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Missions</h2>
      <Skeleton className="mt-1 h-3 w-20" />
      <TableSkeleton
        headers={["Status", "Mission", "Schedule", "Runs", "Quality", "Updated"]}
        rows={3}
        lastRight
      />
    </div>
  );
}

/** Schedules list: heading + table matching schedules view layout */
export function SchedulesListSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Schedules</h2>
          <Skeleton className="mt-1 h-3 w-24" />
        </div>
        <Skeleton className="h-3 w-16" />
      </div>
      <TableSkeleton
        headers={["Status", "Mission", "Type", "Expression", "Next run", "Runs", "Created"]}
        rows={3}
        minW="min-w-[800px]"
        lastRight
      />
    </div>
  );
}

export function MissionHeaderSkeleton() {
  return (
    <div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-2.5 w-2.5 rounded-full" />
        <Skeleton className="h-5 w-48" />
      </div>
      <Skeleton className="mt-2 h-3.5 w-full max-w-lg" />

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-14" />
        <Skeleton className="h-3 w-36" />
      </div>

      <Skeleton className="mt-6 h-8 w-28" />
    </div>
  );
}

export function MissionGraphSkeleton() {
  return (
    <section className="mt-4">
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-20" />
      </div>

      <div className="mb-3 flex items-center gap-1 rounded-lg bg-muted/50 p-1 w-fit">
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
        <Skeleton className="h-7 w-20 rounded-md" />
      </div>

      <div className="relative h-[600px] w-full overflow-hidden rounded-xl border border-border bg-card">
        <div className="absolute inset-0 opacity-40 [background-image:radial-gradient(circle_at_1px_1px,hsl(var(--muted-foreground))_1px,transparent_0)] [background-size:20px_20px]" />
        <div className="relative grid h-full grid-cols-3 gap-8 p-8">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center justify-center">
              <div className="w-full max-w-52 rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-2.5 w-2.5 rounded-full" />
                  <Skeleton className="h-3.5 w-28" />
                </div>
                <Skeleton className="mt-3 h-3 w-20" />
                <Skeleton className="mt-2 h-2 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Mission detail: header + task graph */
export function MissionDetailSkeleton() {
  return (
    <div>
      <MissionHeaderSkeleton />
      <MissionGraphSkeleton />
    </div>
  );
}

/** Skills list: heading + description + table (2 cols) */
export function SkillsListSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Skills</h2>
          <Skeleton className="mt-1 h-3 w-56" />
        </div>
        <Skeleton className="h-4 w-16" />
      </div>
      <TableSkeleton headers={["Skill", "Assigned to", "Tags"]} rows={3} minW="min-w-[520px]" />
    </div>
  );
}

/** Webhooks: heading + description + webhook rows */
export function WebhooksListSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Webhooks</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Receive HTTP POST notifications when events occur in this project.
          </p>
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="mt-4 border border-border overflow-hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between border-b border-border last:border-0 px-4 py-3"
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-64" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-14 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
              </div>
            </div>
            <Skeleton className="ml-4 h-3.5 w-3.5" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Logs: heading + session sidebar + entries panel */
export function LogsViewSkeleton() {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Orchestrator session logs. Each session captures events from a single orchestrator run.
      </p>
      <div className="mt-6 flex gap-6">
        {/* Session list sidebar */}
        <div className="w-64 shrink-0">
          <p className="text-xs font-medium text-muted-foreground mb-3">
            <Skeleton className="inline-block h-3 w-4 align-middle" /> sessions
          </p>
          <div className="border border-border overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-3 py-2.5 border-b border-border last:border-0 space-y-1.5">
                <Skeleton className="h-3 w-24" />
                <div className="flex items-center justify-between">
                  <Skeleton className="h-2.5 w-12" />
                  <Skeleton className="h-2.5 w-16" />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Entries placeholder */}
        <div className="flex-1 min-w-0 border border-border p-8 text-center text-sm text-muted-foreground">
          Select a session to view logs.
        </div>
      </div>
    </div>
  );
}

/** Logs entries loading (sub-spinner) */
export function LogsEntriesSkeleton() {
  return (
    <div className="border border-border overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 border-b border-border last:border-0 px-3 py-2"
        >
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </div>
  );
}

/** Storage: file browser skeleton */
export function StorageSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Storage</h2>
          <p className="mt-1 text-xs text-muted-foreground">Project files and directories.</p>
        </div>
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="mt-4 border border-border overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 border-b border-border last:border-0 px-4 py-3">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="ml-auto h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Skill detail: back + heading + pills + 2-col content/files */
export function SkillDetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-3 w-12" />
      <div className="mt-4">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3.5 w-96" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Skeleton className="h-6 w-20 rounded-md" />
        <Skeleton className="h-6 w-24 rounded-md" />
        <Skeleton className="h-6 w-28 rounded-md" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
        <div>
          <Skeleton className="h-3 w-20 mb-3" />
          <div className="border border-border bg-card p-6 space-y-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </div>
        <div>
          <Skeleton className="h-3 w-12 mb-3" />
          <div className="border border-border overflow-hidden">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2 border-b border-border last:border-0 px-3 py-2">
                <Skeleton className="h-3.5 w-3.5" />
                <Skeleton className="h-3 w-32" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Projects list: toolbar (count + view toggle) + 6-card grid */
export function ProjectsListSkeleton() {
  return (
    <div className="mt-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-2 w-2 rounded-full" />
            </div>
            <Skeleton className="mt-2 h-3 w-24" />
            <div className="mt-4 flex items-center justify-between">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-2.5 w-12" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** API Keys table: header row + 4 rows */
export function KeysTableSkeleton() {
  return (
    <div className="mt-8 border border-border overflow-hidden overflow-x-auto">
      <table className="w-full text-sm min-w-[600px]">
        <thead>
          <tr className="border-b border-border bg-secondary/50">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Name</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Scope</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Prefix</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Created</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 4 }).map((_, i) => (
            <tr key={i} className="border-b border-border last:border-0">
              <td className="px-4 py-3"><Skeleton className="h-3.5 w-32" /></td>
              <td className="px-4 py-3"><Skeleton className="h-4 w-16 rounded" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>
              <td className="px-4 py-3"><Skeleton className="h-3.5 w-3.5 rounded" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** LLM Gateway: gateway-per-project table + add button */
export function LlmGatewaySkeleton() {
  return (
    <div className="mt-6">
      <div className="border border-border overflow-hidden overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead>
            <tr className="border-b border-border bg-secondary/50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Project</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Gateway</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">URL</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground"></th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 2 }).map((_, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-4 py-3"><Skeleton className="h-3 w-24" /></td>
                <td className="px-4 py-3"><Skeleton className="h-4 w-14 rounded" /></td>
                <td className="px-4 py-3"><Skeleton className="h-3 w-40" /></td>
                <td className="px-4 py-3" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Skeleton className="mt-4 h-9 w-44" />
    </div>
  );
}

/** Model catalog: title + filters bar + table rows */
export function ModelCatalogSkeleton() {
  return (
    <div className="mt-10">
      <Skeleton className="h-5 w-20" />
      <Skeleton className="mt-2 h-3 w-80" />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="mt-4 border border-border overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-border last:border-0 px-4 py-3">
            <Skeleton className="h-3.5 w-48" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="ml-auto h-3 w-16" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** BYOK: header + table (3 cols) + encryption card */
export function ByokSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">LLM Keys</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Your LLM API keys, AES-256 encrypted per project.
          </p>
        </div>
      </div>
      <TableSkeleton headers={["Provider", "Label", "Key"]} rows={3} minW="min-w-[400px]" />
      <div className="mt-6 flex gap-3 border border-border bg-card p-4">
        <Shield className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        <div>
          <p className="text-xs font-medium">End-to-end encrypted</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Keys are encrypted with AES-256-GCM before storage. We never see your keys in plaintext.
          </p>
        </div>
      </div>
    </div>
  );
}
