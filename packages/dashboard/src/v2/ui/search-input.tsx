"use client";

import { MagnifyingGlass } from "@phosphor-icons/react/dist/ssr";
import { Input } from "./input.js";

/**
 * The one search field.
 *
 * Fourteen surfaces had hand-rolled "magnifier absolutely positioned inside a
 * bordered box", and they had drifted: `bg-transparent` here, `bg-background`
 * there, a hairline focus in one place and the brand ring in another. The
 * icon placement is the only thing worth repeating, so it lives here and the
 * field underneath is the shared `Input`.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  disabled,
  className = "w-56",
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Sizing only — the surface comes from `Input`. */
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <MagnifyingGlass
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel ?? placeholder}
        className="pl-8 text-[13px] [&::-webkit-search-cancel-button]:appearance-none"
      />
    </div>
  );
}
