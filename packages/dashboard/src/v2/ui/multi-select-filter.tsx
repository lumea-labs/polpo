"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CaretDown, Check } from "@phosphor-icons/react/dist/ssr";

/**
 * Dropdown multi-select filter chip — the canonical v2 list filter (Usage,
 * Sessions, …). A trigger button shows the current selection; the popover is a
 * checkbox list with a Clear action. Empty selection = "all".
 */
export function MultiSelectFilter<T extends string>({
  allLabel,
  icon,
  options,
  selected,
  onToggle,
  onClear,
}: {
  allLabel: string;
  icon?: ReactNode;
  options: Array<{ value: T; label: string }>;
  selected: T[];
  onToggle: (value: T) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const label =
    selected.length === 0
      ? allLabel
      : selected.length === 1
        ? options.find((option) => option.value === selected[0])?.label ??
          selected[0]
        : `${selected.length} selected`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] text-foreground transition-colors hover:border-ring/40"
      >
        {icon}
        <span className="max-w-[140px] truncate">{label}</span>
        <CaretDown size={12} className="text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-52 rounded-md border border-border bg-popover p-1 shadow-lg">
          <div className="max-h-64 overflow-auto">
            {options.map((option) => {
              const on = selected.includes(option.value);
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onToggle(option.value)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-secondary/60"
                >
                  <span
                    className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                      on
                        ? "border-brand bg-brand text-brand-foreground"
                        : "border-border"
                    }`}
                  >
                    {on && <Check size={11} weight="bold" />}
                  </span>
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
          {selected.length > 0 && (
            <>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={onClear}
                className="w-full rounded px-2 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
              >
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
