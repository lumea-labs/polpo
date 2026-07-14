"use client";

import { ArrowClockwise } from "@phosphor-icons/react/dist/ssr";

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      <ArrowClockwise size={14} className={busy ? "animate-spin" : ""} />
      Refresh
    </button>
  );
}
