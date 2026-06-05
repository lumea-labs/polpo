import { Fragment } from "react";
import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";

export interface Crumb {
  label: string;
  href?: string;
  icon?: LucideIcon;
}

/**
 * Shared breadcrumb — chevron-separated trail that reads unmistakably as a
 * breadcrumb. Intermediate crumbs are muted links with a hover chip; the
 * last crumb is the current location (foreground, mono), still linkable if
 * it has an href. One component, used across the agent surfaces (DRY).
 */
export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-0.5 text-xs"
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        const Icon = item.icon;
        const inner = (
          <span className="inline-flex items-center gap-1.5">
            {Icon && <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} />}
            <span className={isLast ? "font-mono font-medium" : ""}>
              {item.label}
            </span>
          </span>
        );
        return (
          <Fragment key={`${item.label}-${i}`}>
            {i > 0 && (
              <ChevronRight
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40"
                strokeWidth={2}
                aria-hidden
              />
            )}
            {item.href ? (
              <Link
                href={item.href}
                aria-current={isLast ? "page" : undefined}
                className={`inline-flex items-center rounded-sm px-1.5 py-1 transition-colors hover:bg-secondary ${
                  isLast
                    ? "text-foreground hover:text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {inner}
              </Link>
            ) : (
              <span
                aria-current={isLast ? "page" : undefined}
                className={`inline-flex items-center px-1.5 py-1 ${
                  isLast ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {inner}
              </span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
