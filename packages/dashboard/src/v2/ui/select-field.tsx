"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CaretDown,
  Check,
  MagnifyingGlass,
} from "@phosphor-icons/react/dist/ssr";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select.js";

export type SelectOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
  /**
   * Rendered before the label — on the closed trigger as well as in the
   * list, so the chosen option looks the same in both places. A meter, a
   * provider icon, a status dot.
   */
  leading?: ReactNode;
  /** Second line in the list: what picking this one actually costs you. */
  hint?: string;
};

/**
 * Options-driven wrapper over the shared Select.
 *
 * The point is to make the styled control cheaper to reach for than a native
 * `<select>`: those render their list in OS chrome, which ignores the v2
 * popover tokens and the 6px radius and looks different on every platform.
 *
 * It is also the only place a select is composed. Every hand-rolled
 * Trigger/Content/Item stack drifted a little — a different height here, a
 * `text-[12px]` there, an icon on the trigger that the list did not repeat —
 * and the drift is invisible until two of them end up on one screen.
 */
export function SelectField<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className = "",
  placeholder,
  size = "sm",
  variant,
  align,
  mono = false,
  contentClassName,
  ...aria
}: {
  /** `null` shows the placeholder — an empty string would render blank. */
  value: T | null;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  size?: "sm" | "default";
  /** `card` matches the model selector; `field` (default) the form fields. */
  variant?: "field" | "card";
  /** Where the list hangs off the trigger. */
  align?: "start" | "center" | "end";
  /** For identifier-ish values — alias names, channel ids, model ids. */
  mono?: boolean;
  contentClassName?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  id?: string;
  "data-testid"?: string;
}) {
  // The trigger only needs the custom renderer when an option carries
  // something the default text rendering would drop.
  const decorated = options.some((option) => option.leading != null);
  const monoClass = mono ? "font-mono" : "";

  return (
    <Select
      value={value}
      items={options.map(({ value, label }) => ({ value, label }))}
      disabled={disabled}
      onValueChange={(next) => {
        if (next != null) onChange(next as T);
      }}
    >
      <SelectTrigger
        size={size}
        variant={variant}
        className={className}
        {...aria}
      >
        {decorated ? (
          <SelectValue placeholder={placeholder}>
            {(current) => {
              const option = options.find((entry) => entry.value === current);
              if (!option) {
                return (
                  <span className="text-muted-foreground">{placeholder}</span>
                );
              }
              return (
                <span className="flex min-w-0 items-center gap-2">
                  {option.leading}
                  <span className={`truncate ${monoClass}`}>
                    {option.label}
                  </span>
                </span>
              );
            }}
          </SelectValue>
        ) : (
          <SelectValue placeholder={placeholder} className={monoClass} />
        )}
      </SelectTrigger>
      <SelectContent align={align ?? "start"} alignItemWithTrigger={false} className={`v2 ${contentClassName ?? ""}`}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              {option.leading}
              <span className="flex min-w-0 flex-col">
                <span className={monoClass}>{option.label}</span>
                {option.hint ? (
                  <span className="text-[12px] leading-snug text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Multiple choices using the same trigger, popup and items as SelectField. */
export function MultiSelectField<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className = "",
  placeholder = "Select…",
  size = "sm",
  variant,
  ...aria
}: {
  value: T[];
  onChange: (value: T[]) => void;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  size?: "sm" | "default";
  variant?: "field" | "card";
  "aria-label"?: string;
  id?: string;
}) {
  return (
    <Select
      multiple
      value={value}
      items={options.map(({ value, label }) => ({ value, label }))}
      disabled={disabled}
      onValueChange={(next) => onChange(next as T[])}
    >
      <SelectTrigger
        size={size}
        variant={variant}
        className={className}
        {...aria}
      >
        <SelectValue placeholder={placeholder}>
          {() =>
            value.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : value.length === 1 ? (
              (options.find((option) => option.value === value[0])?.label ??
              value[0])
            ) : (
              `${value.length} selected`
            )
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className="v2">
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={option.value}
            disabled={option.disabled}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A select you can type into. For lists long enough that scrolling is not a
 * real way to find anything — the ~400 IANA timezones being the case this
 * was written for.
 */
export function SearchableSelect<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className = "",
  placeholder = "Search…",
  emptyLabel = "No matches",
  triggerLabel,
  ...aria
}: {
  value: T | "";
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  emptyLabel?: string;
  /** Shown when nothing is selected. */
  triggerLabel?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((option) =>
      option.label.toLowerCase().includes(needle),
    );
  }, [options, query]);

  const selected = options.find((option) => option.value === value);

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    setQuery("");
    setOpen(true);
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={toggleOpen}
        {...aria}
        className="flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-input bg-transparent pr-2 pl-2.5 text-sm transition-colors outline-none select-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive"
      >
        <span
          className={`truncate ${selected ? "text-foreground" : "text-muted-foreground"}`}
        >
          {selected?.label ?? triggerLabel ?? placeholder}
        </span>
        <CaretDown size={12} className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          <div className="flex items-center gap-1.5 border-b border-border px-2">
            <MagnifyingGlass
              size={13}
              className="shrink-0 text-muted-foreground"
            />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              className="h-8 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
          <div role="listbox" className="max-h-60 overflow-y-auto p-1">
            {matches.length === 0 ? (
              <div className="px-2 py-3 text-center text-[12px] text-muted-foreground">
                {emptyLabel}
              </div>
            ) : (
              matches.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent disabled:opacity-40"
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value && (
                    <Check size={13} className="shrink-0 text-brand" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
