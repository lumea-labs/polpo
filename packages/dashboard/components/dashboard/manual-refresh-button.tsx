"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";

interface ManualRefreshButtonProps {
  onRefresh?: () => void | Promise<unknown>;
  isRefreshing?: boolean;
  label?: string;
  className?: string;
}

export function ManualRefreshButton({
  onRefresh,
  isRefreshing = false,
  label = "Refresh",
  className = "",
}: ManualRefreshButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const refreshing = isRefreshing || isPending || isManualRefreshing;

  async function handleClick() {
    if (onRefresh) {
      setIsManualRefreshing(true);
      try {
        await onRefresh();
      } finally {
        setIsManualRefreshing(false);
      }
      return;
    }

    startTransition(() => {
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={refreshing}
      className={`inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 ${className}`}
    >
      <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
      {label}
    </button>
  );
}
