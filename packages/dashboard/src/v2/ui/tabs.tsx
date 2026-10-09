"use client";

import type { ReactNode } from "react";

/**
 * The v2 underline tab bar. Nine surfaces had hand-rolled this exact markup
 * and a tenth (Knowledge) had drifted to a tighter hit area — so the rule is now
 * here rather than copied into each view.
 */
export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
  "aria-label": ariaLabel,
}: {
  tabs: ReadonlyArray<{ id: T; label: ReactNode; disabled?: boolean }>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`scrollbar-none flex items-center gap-1 overflow-x-auto border-b border-border ${className}`}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-[13px] transition-colors disabled:opacity-40 ${
              active
                ? "border-brand font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The vertical counterpart: a left rail of named sections beside their
 * content.
 *
 * Reach for it when the sections are *places* rather than filters — each with
 * its own controls and its own state, where a row of pills reads as a filter
 * strip and hides what the other sections even are. The label can carry a
 * second line, which a horizontal bar has no room for.
 */
export function SideTabs<T extends string>({
  tabs,
  value,
  onChange,
  className = "",
  "aria-label": ariaLabel,
}: {
  tabs: ReadonlyArray<{
    id: T;
    label: ReactNode;
    /** One short line under the label — what you find in that section. */
    hint?: string;
    disabled?: boolean;
  }>;
  value: T;
  onChange: (id: T) => void;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      className={`flex shrink-0 flex-col gap-0.5 ${className}`}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={tab.disabled}
            tabIndex={active ? 0 : -1}
            data-side-tab={tab.id}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              const items = Array.from(
                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]:not(:disabled)',
                ) ?? [],
              );
              const index = items.indexOf(event.currentTarget);
              const offset = event.key === "ArrowDown" ? 1 : -1;
              const next = items[(index + offset + items.length) % items.length];
              const nextId = next?.dataset.sideTab as T | undefined;
              if (nextId) {
                onChange(nextId);
                next.focus();
              }
            }}
            className={`rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            }`}
          >
            <span className="block truncate">{tab.label}</span>
            {tab.hint ? (
              <span
                className={`mt-0.5 block text-[11px] leading-4 ${
                  active ? "text-muted-foreground" : "text-muted-foreground/70"
                }`}
              >
                {tab.hint}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
