"use client";

import type { ReactNode } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover";
import { cn } from "#/lib/utils";

export interface MultiSelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

interface MultiSelectProps {
  options: MultiSelectOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  className?: string;
  contentClassName?: string;
  /** Minimum number of selected options. When at this floor, uncheck
   *  becomes a no-op and the Clear affordance is hidden. Default 0. */
  minSelected?: number;
}

export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className,
  contentClassName,
  minSelected = 0,
}: MultiSelectProps) {
  const toggle = (v: string) => {
    if (value.includes(v)) {
      // Enforce floor: don't let the user drop below minSelected.
      if (value.length <= minSelected) return;
      onChange(value.filter((x) => x !== v));
    } else {
      onChange([...value, v]);
    }
  };

  // Selected options preserved in the order the `options` array declares
  // them — stable regardless of click order, matches what users see in
  // the popover. Icons are shown inline in the trigger up to 4, then
  // collapsed with a "+N" count so the trigger stays compact.
  const selectedOptions = options.filter((o) => value.includes(o.value));
  const maxIconsInTrigger = 4;
  const visibleIcons = selectedOptions.slice(0, maxIconsInTrigger);
  const hiddenIconsCount = selectedOptions.length - visibleIcons.length;

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex items-center justify-between gap-2 border border-border bg-background px-3 py-1.5 text-sm transition-colors hover:border-foreground/30 focus:border-foreground/30 focus:outline-none data-[popup-open]:border-foreground/30",
          className,
        )}
      >
        {selectedOptions.length === 0 ? (
          <span className="text-muted-foreground">{placeholder}</span>
        ) : selectedOptions.length === 1 ? (
          <span className="flex items-center gap-2 min-w-0">
            {selectedOptions[0].icon && (
              <span className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4">
                {selectedOptions[0].icon}
              </span>
            )}
            <span className="truncate">{selectedOptions[0].label}</span>
          </span>
        ) : (
          <span className="flex items-center gap-2 min-w-0">
            <span className="flex items-center gap-1">
              {visibleIcons.map(
                (o) =>
                  o.icon && (
                    <span
                      key={o.value}
                      className="flex h-4 w-4 shrink-0 items-center justify-center [&_svg]:h-4 [&_svg]:w-4"
                    >
                      {o.icon}
                    </span>
                  ),
              )}
            </span>
            <span className="text-muted-foreground">
              {hiddenIconsCount > 0
                ? `+${hiddenIconsCount}`
                : `${selectedOptions.length} selected`}
            </span>
          </span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className={cn("w-64 p-1 gap-0", contentClassName)}
      >
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-mono">
            {value.length} selected
          </span>
          <div className="flex items-center gap-2">
            {value.length < options.length && (
              <button
                type="button"
                onClick={() => onChange(options.map((o) => o.value))}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                All
              </button>
            )}
            {value.length > minSelected && (
              <button
                type="button"
                onClick={() => onChange(value.slice(0, minSelected))}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        <div className="max-h-60 overflow-y-auto">
          {options.map((opt) => {
            const selected = value.includes(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => toggle(opt.value)}
                disabled={selected && value.length <= minSelected}
                className="flex w-full items-center gap-2.5 rounded-sm px-2 py-2 text-sm text-left hover:bg-accent hover:text-accent-foreground transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center border transition-colors",
                    selected
                      ? "border-brand bg-brand text-background"
                      : "border-border",
                  )}
                >
                  {selected && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                {opt.icon && (
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center [&_svg]:h-5 [&_svg]:w-5">
                    {opt.icon}
                  </span>
                )}
                <span className="truncate font-medium">{opt.label}</span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
