"use client";

/**
 * Chat canvas — the collapsible, resizable right panel of the v2 playground,
 * rendered as a floating card (matches the v2 copilot dock / builder). Two
 * tabs:
 *   • Trace — the live transcript/step inspector for the current run, reusing
 *     the v2 sessions renderer (`<Trace>`) fed by `chatToItems`, polled so it
 *     tracks the run near-live.
 *   • Drive — the project file browser, reusing the existing v2 files section
 *     component (`<FilesBrowser>`).
 */

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Bug, FolderOpen, X } from "@phosphor-icons/react";
import { SessionsHostProvider } from "../sessions/host.js";
import { chatToItems } from "../sessions/trace-detail.js";
import { Trace } from "../sessions/trace-detail-view.js";
import { usePlaygroundHost } from "./host.js";

export type CanvasTabId = "trace" | "drive";
const CANVAS_DEFAULT_WIDTH = 640;
const CANVAS_MIN_WIDTH = 480;
const CANVAS_MAX_WIDTH = 960;

export function ChatCanvas({
  projectId,
  sessionId,
  tab,
  onTabChange,
  onClose,
}: {
  projectId: string;
  sessionId: string | undefined;
  tab: CanvasTabId;
  onTabChange: (tab: CanvasTabId) => void;
  onClose: () => void;
}) {
  const host = usePlaygroundHost();
  const { FilesBrowser } = host.components;
  const [width, setWidth] = useState(CANVAS_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);

  // Drag the left edge to resize the card.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) =>
      setWidth(Math.min(CANVAS_MAX_WIDTH, Math.max(CANVAS_MIN_WIDTH, startW - (ev.clientX - startX))));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="relative h-full shrink-0 py-3 pl-1.5 pr-3">
      {/* Resize handle in the gutter, outside the (overflow-hidden) card. */}
      <div
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        data-resizing={resizing || undefined}
        className="group absolute inset-y-3 left-0 z-30 flex w-3 cursor-col-resize items-center justify-center"
      >
        <div className="absolute inset-y-[6%] left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-brand/40 group-data-[resizing]:bg-brand/60" />
        <div className="relative h-7 w-1 rounded-full bg-border shadow-sm transition-all duration-150 group-hover:h-9 group-hover:bg-brand group-data-[resizing]:h-9 group-data-[resizing]:bg-brand" />
      </div>

      <aside
        style={{ width }}
        className="flex h-full max-w-[calc(100vw-4rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl"
      >
        <header className="flex h-11 shrink-0 items-center gap-0.5 border-b border-border px-2">
          <CanvasTab
            active={tab === "trace"}
            onClick={() => onTabChange("trace")}
            icon={<Bug size={14} weight={tab === "trace" ? "fill" : "regular"} />}
            label="Trace"
          />
          <CanvasTab
            active={tab === "drive"}
            onClick={() => onTabChange("drive")}
            icon={<FolderOpen size={14} weight={tab === "drive" ? "fill" : "regular"} />}
            label="Drive"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close canvas"
            className="ml-auto grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {tab === "trace" ? (
            <TraceTab projectId={projectId} sessionId={sessionId} />
          ) : (
            <div className="p-3">
              <FilesBrowser projectId={projectId} embedded />
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function CanvasTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${
        active
          ? "bg-secondary text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function TraceTab({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string | undefined;
}) {
  const host = usePlaygroundHost();
  const { RefreshButton } = host.components;
  // Poll ONLY while a run is streaming: `<PolpoChat>` dispatches
  // `polpo:trace-activity` on every chat update; we hold a short "active"
  // window that keeps polling for 3s after the last event, then stops. Idle =
  // no polling (no more refetching-forever when nothing is happening).
  const [active, setActive] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const onActivity = () => {
      setActive(true);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setActive(false), 3000);
    };
    window.addEventListener("polpo:trace-activity", onActivity);
    return () => {
      window.removeEventListener("polpo:trace-activity", onActivity);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, []);

  const { messages, isLoading, isFetching, refetch } = host.data.useTrace({
    projectId,
    sessionId,
    active,
  });

  const items = chatToItems(messages as never);

  // A run exists but its trace is still loading — show a skeleton, not the
  // "send a message" empty state (which wrongly reads as "nothing happened").
  if (sessionId && isLoading && items.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-md bg-muted/60" />
        ))}
      </div>
    );
  }

  if (!sessionId || items.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
        <Bug size={24} className="text-muted-foreground/40" />
        <p className="text-[13px] text-muted-foreground">
          Send a message to inspect the run — every step, tool call and result
          shows up here.
        </p>
      </div>
    );
  }

  return (
    <div className="p-4">
      <SessionsHostProvider host={host.sessions}>
        <Trace
          items={items}
          rightSlot={<RefreshButton onClick={() => refetch()} busy={isFetching} />}
        />
      </SessionsHostProvider>
    </div>
  );
}
