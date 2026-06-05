"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";

interface Tab {
  label: string;
  href: string;
  icon?: LucideIcon;
}

export function NavTabs({
  basePath,
  tabs,
  className,
  orientation = "horizontal",
}: {
  basePath: string;
  tabs: Tab[];
  className?: string;
  orientation?: "horizontal" | "vertical";
}) {
  const pathname = usePathname();
  const vertical = orientation === "vertical";

  return (
    <div
      data-testid="nav-tabs"
      className={
        vertical
          ? `flex flex-col gap-0.5 ${className ?? ""}`
          : `flex gap-1 border-b border-border overflow-x-auto scrollbar-none ${className ?? ""}`
      }
    >
      {tabs.map((tab) => {
        const href = `${basePath}${tab.href}`;
        const active = tab.href === ""
          ? pathname === basePath
          : pathname.startsWith(href);

        if (vertical) {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.label}
              href={href}
              data-testid={`tab-${tab.label.toLowerCase().replace(/\s+/g, "-")}`}
              className={`relative flex items-center gap-2.5 border-l-2 px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "border-foreground bg-foreground/5 font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
              }`}
            >
              {Icon && (
                <Icon
                  className={`h-4 w-4 shrink-0 ${active ? "text-foreground" : "text-muted-foreground/60"}`}
                  strokeWidth={1.5}
                />
              )}
              {tab.label}
            </Link>
          );
        }

        return (
          <Link
            key={tab.label}
            href={href}
            data-testid={`tab-${tab.label.toLowerCase().replace(/\s+/g, "-")}`}
            className={`relative px-3 py-2 text-sm transition-colors whitespace-nowrap ${
              active
                ? "text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
            {active && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
