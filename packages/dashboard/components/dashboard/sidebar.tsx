"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Boxes, Settings, BarChart3,
  Home, ListChecks, Target, Users,
  BookMarked, Brain, Menu, KeyRound,
  MessageCircle, Library, Waypoints, CreditCard,
  PanelLeft, PanelRight, MessageSquare, ExternalLink, Clock,
  LineChart, ArrowLeft,
} from "lucide-react";
import {
  Sheet, SheetContent, SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip, TooltipTrigger, TooltipContent,
} from "@/components/ui/tooltip";
import { useMobileSidebar } from "@/hooks/use-mobile-sidebar";
import { useDesktopSidebar } from "@/hooks/use-desktop-sidebar";
import { useQuery } from "@tanstack/react-query";
import { fetchControlPlane } from "@/lib/data-client";
import { ProjectSwitcher } from "@/components/dashboard/top-header";

const globalNav = [
  { label: "Projects", href: "/projects", icon: Boxes },
  { label: "AI Gateway", href: "/llm-gateway", icon: Waypoints },
  { label: "Usage", href: "/usage", icon: BarChart3 },
  { label: "Billing", href: "/billing", icon: CreditCard },
  { label: "API Keys", href: "/keys", icon: KeyRound },
];

type NavItem = {
  label: string;
  href: string;
  icon: typeof Boxes;
  /** Open in a new browser tab — used for the standalone Playground surface. */
  external?: boolean;
};
type NavGroup = { separator?: boolean; heading?: string; items: NavItem[] };

const projectNav: NavGroup[] = [
  {
    heading: "Control",
    items: [
      { label: "Dashboard", href: "", icon: Home },
      { label: "Spending", href: "/spending", icon: LineChart },
    ],
  },
  {
    separator: true,
    heading: "Manage",
    items: [
      { label: "Agents", href: "/agents", icon: Users },
      { label: "Skills Library", href: "/skills", icon: BookMarked },
      { label: "Shared Memory", href: "/memory", icon: Brain },
      { label: "Files", href: "/storage", icon: Library },
    ],
  },
  {
    separator: true,
    heading: "Activity",
    items: [
      { label: "Sessions", href: "/sessions", icon: MessageCircle },
      { label: "Tasks", href: "/tasks", icon: ListChecks },
      { label: "Missions", href: "/missions", icon: Target },
      { label: "Schedules", href: "/schedules", icon: Clock },
    ],
  },
  {
    separator: true,
    items: [
      { label: "Playground", href: "/playground", icon: MessageSquare, external: true },
    ],
  },
];

const PROJECT_ID_RE = /^\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function extractProjectId(pathname: string): string | null {
  const match = pathname.match(PROJECT_ID_RE);
  return match ? match[1] : null;
}

function NavLink({
  href,
  icon: Icon,
  label,
  active,
  collapsed,
  external,
}: {
  href: string;
  icon: typeof Boxes;
  label: string;
  active: boolean;
  collapsed?: boolean;
  external?: boolean;
}) {
  const link = (
    <Link
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      data-testid={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={`flex items-center text-sm transition-colors ${
        collapsed ? "justify-center p-1.5" : "gap-2 px-2 py-1.5"
      } ${
        active
          ? "bg-foreground/10 text-foreground font-medium"
          : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
      }`}
    >
      <Icon
        className={`shrink-0 ${active ? "h-5 w-5 text-foreground" : "h-[18px] w-[18px] text-muted-foreground"}`}
        strokeWidth={active ? 2 : 1.5}
      />
      {!collapsed && (
        <span className="truncate flex-1 inline-flex items-center gap-1.5">
          {label}
          {external && (
            <ExternalLink className="h-3 w-3 opacity-50" strokeWidth={1.5} />
          )}
        </span>
      )}
    </Link>
  );

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger render={link} />
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return link;
}

/** Inner sidebar content — reused by both desktop aside and mobile sheet */
function SidebarContent({ collapsed = false }: { collapsed?: boolean }) {
  const pathname = usePathname();
  const projectId = extractProjectId(pathname);
  const inProject = !!projectId;
  const { toggle } = useDesktopSidebar();

  // Same React Query key as the top-header → cache hit when both render
  // (no double fetch). Only fires when we're inside a project route.
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () =>
      fetchControlPlane<{ name: string; orgId: string }>(
        `/v1/projects/${projectId}`,
      ),
    enabled: !!projectId,
    staleTime: 60_000,
  });

  function isActive(href: string) {
    if (inProject && href === `/projects/${projectId}`) return pathname === href;
    return pathname.startsWith(href);
  }

  return (
    <>
      {/* Nav */}
      <nav
        data-testid="sidebar-nav"
        className={`flex-1 overflow-y-auto pt-3 ${collapsed ? "px-1" : "px-2"}`}
      >
        {/* Project switcher — same component as the top header (different
            visual variant). The header switcher has been removed; this is
            the sole entry point for switching/renaming the active project.
            Above it: "All projects" back link so escaping the project
            context is one click regardless of the current page. */}
        {inProject && !collapsed && projectId && project?.name && project?.orgId && (
          <div className="mb-5 px-1 flex flex-col gap-2.5">
            <Link
              href="/projects"
              data-testid="sidebar-all-projects"
              className="inline-flex items-center gap-1.5 px-1.5 text-[11px] text-muted-foreground/70 hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-3 w-3" />
              All projects
            </Link>
            <ProjectSwitcher
              projectId={projectId}
              projectName={project.name}
              orgId={project.orgId}
              variant="sidebar"
            />
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          {inProject
            ? projectNav.map((group, gi) => (
                <div key={gi} className="flex flex-col gap-1.5">
                  {group.separator && (
                    <div className={`my-2 border-t border-border ${collapsed ? "mx-1" : "mx-3"}`} />
                  )}
                  {group.heading && !collapsed && (
                    <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/50">
                      {group.heading}
                    </div>
                  )}
                  {group.items.map((item) => {
                    const href = `/projects/${projectId}${item.href}`;
                    return (
                      <NavLink
                        key={href}
                        href={href}
                        icon={item.icon}
                        label={item.label}
                        active={isActive(href)}
                        collapsed={collapsed}
                        external={item.external}
                      />
                    );
                  })}
                </div>
              ))
            : (
                <>
                  {!collapsed && (
                    <div className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground/50">
                      Organization
                    </div>
                  )}
                  {globalNav.map((item) => (
                    <NavLink
                      key={item.href}
                      {...item}
                      active={isActive(item.href)}
                      collapsed={collapsed}
                    />
                  ))}
                </>
              )
          }
        </div>
      </nav>

      {/* Bottom — contextual Settings + collapse toggle */}
      {(() => {
        const settingsHref = inProject ? `/projects/${projectId}/settings` : "/settings";
        const settingsLabel = inProject ? "Project Settings" : "Settings";
        const settingsActive = inProject
          ? pathname === settingsHref
          : pathname.startsWith("/settings");

        return (
          <div className={`py-2 shrink-0 ${collapsed ? "px-1 space-y-0.5" : "px-2"}`}>
            {collapsed ? (
              <>
                <Link
                  href={settingsHref}
                  data-testid="nav-settings"
                  aria-label={settingsLabel}
                  className={`flex items-center justify-center rounded-md p-1.5 transition-colors ${
                    settingsActive
                      ? "text-foreground bg-foreground/5"
                      : "text-muted-foreground/70 hover:text-foreground hover:bg-secondary/50"
                  }`}
                >
                  <Settings className="h-[18px] w-[18px]" strokeWidth={1.5} />
                </Link>
                <CollapseToggle collapsed onToggle={toggle} />
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <Link
                  href={settingsHref}
                  data-testid="nav-settings"
                  className={`group flex-1 flex items-center gap-2 px-2 py-1.5 text-sm transition-colors ${
                    settingsActive
                      ? "text-foreground"
                      : "text-muted-foreground/70 hover:text-foreground"
                  }`}
                >
                  <Settings className="h-[18px] w-[18px]" strokeWidth={1.5} />
                  <span>{settingsLabel}</span>
                </Link>
                <CollapseToggle collapsed={false} onToggle={toggle} inline />
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}

function CollapseToggle({
  collapsed,
  onToggle,
  inline,
}: {
  collapsed: boolean;
  onToggle: () => void;
  inline?: boolean;
}) {
  const Icon = collapsed ? PanelLeft : PanelRight;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";

  const btn = (
    <button
      onClick={onToggle}
      aria-label={label}
      data-testid="sidebar-toggle"
      className={`hidden md:flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground hover:bg-secondary/50 ${
        inline ? "p-2 shrink-0" : "p-2 w-full"
      }`}
    >
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={btn} />
      <TooltipContent side={collapsed ? "right" : "top"}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Desktop sidebar — hidden on mobile, collapsible to icon strip on desktop */
export function Sidebar() {
  const { open } = useDesktopSidebar();
  const collapsed = !open;
  return (
    <aside
      data-testid="sidebar"
      data-open={open}
      className={`hidden md:flex shrink-0 flex-col border-r border-border bg-card overflow-hidden transition-[width] duration-150 ease-out ${
        collapsed ? "w-12" : "w-[200px]"
      }`}
    >
      <SidebarContent collapsed={collapsed} />
    </aside>
  );
}

/** Mobile sidebar — sheet drawer from left (always expanded) */
export function MobileSidebar() {
  const { open, setOpen } = useMobileSidebar();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-72 p-0 bg-card border-border"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full flex-col">
          <SidebarContent />
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Mobile top bar with hamburger — shown only on mobile */
export function MobileHeader() {
  const { toggle } = useMobileSidebar();

  return (
    <header className="flex md:hidden h-14 items-center gap-3 border-b border-border bg-card px-4 shrink-0">
      <button
        onClick={toggle}
        data-testid="mobile-menu-toggle"
        className="inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors"
        aria-label="Toggle navigation"
      >
        <Menu className="h-5 w-5" />
      </button>
      <Link href="/projects" className="flex items-center">
        <Image src="/polpo-logo.svg" alt="Polpo" width={92} height={20} priority className="h-5 w-auto" />
      </Link>
    </header>
  );
}
