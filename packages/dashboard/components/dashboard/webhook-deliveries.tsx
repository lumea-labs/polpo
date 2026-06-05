"use client";

/**
 * Webhook delivery inspector.
 *
 * Renders a paginated, auto-refreshing table of webhook delivery attempts
 * for a single webhook. Each row can be expanded to show the request body
 * and (truncated) response body, and re-fired with the "Redeliver" button.
 *
 * Auto-refresh is intentionally chunky (5s). Webhooks are not chat — the
 * user opens this panel to debug, not to watch a live stream. SSE would be
 * overkill and 5s polling is cheap on the data plane.
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { fetchDataPlane, mutateDataPlane } from "#/lib/data-client";

interface Webhook {
  id: string;
  url: string;
  events: string[];
}

interface Delivery {
  id: string;
  webhook_id: string;
  event: string;
  attempt: number;
  status: "pending" | "success" | "failed" | "retrying";
  status_code: number | null;
  response_body: string | null;
  error: string | null;
  duration_ms: number | null;
  payload: unknown;
  next_retry_at: string | null;
  created_at: string;
  completed_at: string | null;
}

interface DeliveriesResponse {
  ok: boolean;
  data: Delivery[];
  next_cursor: string | null;
}

const STATUS_STYLES: Record<Delivery["status"], string> = {
  success: "bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20",
  failed: "bg-red-500/10 text-red-600 ring-1 ring-red-500/20",
  retrying: "bg-amber-500/10 text-amber-600 ring-1 ring-amber-500/20",
  pending: "bg-secondary text-muted-foreground ring-1 ring-border",
};

export function WebhookDeliveries({
  projectId,
  webhook,
}: {
  projectId: string;
  webhook: Webhook;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["webhook-deliveries", projectId, webhook.id],
    queryFn: () =>
      fetchDataPlane<DeliveriesResponse>(
        projectId,
        `/v1/webhooks/${webhook.id}/deliveries?limit=50`,
      ),
    // 5s auto-refresh while the panel is mounted. React Query pauses
    // polling when the tab loses focus, which is what we want.
    refetchInterval: 5000,
  });

  const redeliver = useMutation({
    mutationFn: (deliveryId: string) =>
      mutateDataPlane(
        projectId,
        `/v1/webhooks/${webhook.id}/deliveries/${deliveryId}/redeliver`,
        { method: "POST" },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["webhook-deliveries", projectId, webhook.id],
      });
    },
  });

  const deliveries = data?.data ?? [];

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Endpoint
          </p>
          <p className="font-mono text-sm break-all">{webhook.url}</p>
        </div>
        <button
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 rounded border border-border px-2.5 py-1 text-xs hover:border-foreground/30 transition-colors"
          disabled={isFetching}
          title="Refresh"
        >
          <RefreshCw
            className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </header>

      {isLoading ? (
        <div className="rounded border border-border p-6 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : deliveries.length === 0 ? (
        <div className="rounded border border-border p-8 text-center text-sm text-muted-foreground">
          No deliveries yet. Trigger an event to see attempts here.
        </div>
      ) : (
        <div className="rounded border border-border overflow-hidden">
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 border-b border-border bg-secondary/40 px-3 py-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span />
            <span>Event</span>
            <span>Status</span>
            <span>Code</span>
            <span>Latency</span>
            <span />
          </div>
          {deliveries.map((d) => {
            const isOpen = expanded.has(d.id);
            return (
              <div
                key={d.id}
                className="border-b border-border last:border-0"
              >
                <button
                  onClick={() => toggle(d.id)}
                  className="grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto_auto_auto_auto] items-center gap-3 px-3 py-2 text-left text-sm hover:bg-secondary/30 transition-colors"
                >
                  {isOpen ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="font-mono text-xs truncate">{d.event}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()} · attempt{" "}
                      {d.attempt}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[d.status]}`}
                  >
                    {d.status}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {d.status_code ?? "—"}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    {d.duration_ms != null ? `${d.duration_ms}ms` : "—"}
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      redeliver.mutate(d.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        redeliver.mutate(d.id);
                      }
                    }}
                    aria-disabled={redeliver.isPending}
                    className={`inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] cursor-pointer hover:border-foreground/30 transition-colors ${
                      redeliver.isPending ? "opacity-50 pointer-events-none" : ""
                    }`}
                  >
                    Redeliver
                  </span>
                </button>

                {isOpen && (
                  <div className="grid gap-3 border-t border-border bg-secondary/20 px-6 py-3 md:grid-cols-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        Request payload
                      </p>
                      <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-2 font-mono text-[11px]">
                        {JSON.stringify(d.payload, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                        Response
                      </p>
                      <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {d.response_body ??
                          d.error ??
                          (d.status === "pending" ? "pending…" : "(empty)")}
                      </pre>
                      {d.next_retry_at && (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Next retry:{" "}
                          {new Date(d.next_retry_at).toLocaleString()}
                        </p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
