import type { ReactNode } from "react";

/** A labeled content block with an optional count. */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-7 first:mt-0">
      {(title || count !== undefined || action) && (
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            {title && (
              <h2 className="text-[13px] font-medium text-foreground">
                {title}
              </h2>
            )}
            {count !== undefined && (
              <span
                className="text-[12px] text-muted-foreground/60"
                data-tabular
              >
                {count}
              </span>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Chip({
  children,
  brand,
}: {
  children: ReactNode;
  brand?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[11px] ${
        brand
          ? "border-brand/30 bg-brand/10 text-brand"
          : "border-border bg-secondary/50 text-muted-foreground"
      }`}
    >
      {children}
    </span>
  );
}

export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-3.5 py-4 text-[13px] text-muted-foreground/60">
      {children}
    </div>
  );
}

/** Accessible on/off switch, brand-tinted when on. */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? "bg-brand" : "bg-secondary"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
          checked ? "translate-x-[13px]" : "translate-x-[2px]"
        }`}
      />
    </button>
  );
}
