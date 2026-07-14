"use client";

import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTheme } from "next-themes";
import {
  ArrowSquareOut,
  Atom,
  BookOpen,
  Brain,
  Buildings,
  CaretUpDown,
  ChartLineUp,
  ChatCircleText,
  ClockCounterClockwise,
  Desktop,
  GearSix,
  GraduationCap,
  HardDrives,
  Moon,
  PlugsConnected,
  SignOut,
  Sun,
  User,
  Wrench,
} from "@phosphor-icons/react/dist/ssr";
import { useDashboardHost } from "../../host.js";
import { Link } from "../host.js";
import {
  ClaudeCodeIcon,
  CodexIcon,
  CopilotIcon,
  CursorIcon,
  WindsurfIcon,
} from "./coding-agents.js";

type IconComponent = ComponentType<{
  size?: number;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
  className?: string;
}>;

type NavItem = {
  label: string;
  href: string;
  icon: IconComponent;
  external?: boolean;
  capability?: "billing";
};
type NavGroup = { heading: string; items: NavItem[] };

const PROJECT_TOP: NavItem[] = [
  { label: "Playground", href: "/playground", icon: ChatCircleText, external: true },
];

const GROUPS: NavGroup[] = [
  {
    heading: "Build",
    items: [
      { label: "Agents", href: "/agents", icon: Atom },
      { label: "Skills", href: "/skills", icon: GraduationCap },
      { label: "Tool Functions", href: "/tools", icon: Wrench },
      { label: "Memory", href: "/memory", icon: Brain },
      { label: "Drives", href: "/files", icon: HardDrives },
    ],
  },
  {
    heading: "Observe",
    items: [
      { label: "Sessions", href: "/sessions", icon: ClockCounterClockwise },
      { label: "Spending", href: "/spending", icon: ChartLineUp, capability: "billing" },
    ],
  },
];

const EXPANDED = 224;
const RAIL = 52;
const COLLAPSE_AT = 150;

export function DashboardShell({
  pathname,
  children,
}: {
  pathname: string;
  children: ReactNode;
}) {
  return (
    <div className="v2 flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <AppTopbar />
      <div className="flex min-h-0 flex-1">
        <AppSidebar pathname={pathname} />
        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

function AppTopbar() {
  const host = useDashboardHost();
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
      <Link href="/agents" className="flex shrink-0 items-center" aria-label="Polpo">
        <img
          src="/polpo-logo.svg"
          alt="Polpo"
          width={83}
          height={18}
          className="h-[18px] w-auto invert dark:invert-0"
        />
      </Link>

      <span className="hidden select-none text-muted-foreground/60 sm:inline" aria-hidden>/</span>
      <span className="hidden h-8 items-center gap-1.5 rounded-md px-1.5 text-[13px] font-medium text-foreground sm:flex">
        <Buildings size={15} weight="duotone" className="shrink-0 text-muted-foreground" />
        Self-hosted
      </span>

      <span className="hidden select-none text-muted-foreground/60 sm:inline" aria-hidden>/</span>
      <button
        type="button"
        className="hidden h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-foreground transition-colors hover:bg-secondary/60 sm:flex"
      >
        <span className="max-w-[180px] truncate font-medium">
          {host.project.name || "Local runtime"}
        </span>
        <CaretUpDown size={14} className="text-muted-foreground" />
      </button>

      <div className="ml-auto flex min-w-0 items-center gap-1 sm:gap-2">
        <a
          href="https://docs.polpo.sh"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Documentation"
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground sm:px-2.5"
        >
          <BookOpen size={16} weight="duotone" className="shrink-0 text-muted-foreground" />
          <span className="hidden sm:inline">Docs</span>
          <ArrowSquareOut size={12} className="hidden shrink-0 text-muted-foreground/50 sm:block" />
        </a>
        {host.capabilities?.settings !== false && (
          <Link
            href="/settings"
            className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
          >
            <GearSix size={16} className="shrink-0 text-muted-foreground" />
            Settings
          </Link>
        )}
        <ConnectButton />
      </div>
    </header>
  );
}

const CONNECT_LOGOS = [
  { Icon: ClaudeCodeIcon, name: "Claude" },
  { Icon: CursorIcon, name: "Cursor" },
  { Icon: CopilotIcon, name: "Copilot" },
  { Icon: WindsurfIcon, name: "Windsurf" },
  { Icon: CodexIcon, name: "Codex" },
];

function ConnectButton() {
  const [logoIndex, setLogoIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(
      () => setLogoIndex((index) => (index + 1) % CONNECT_LOGOS.length),
      1800,
    );
    return () => window.clearInterval(timer);
  }, []);
  const current = CONNECT_LOGOS[logoIndex];
  const Logo = current.Icon;
  return (
    <button
      type="button"
      title="Connect your coding agent"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-brand/30 bg-brand/[0.07] px-2.5 text-[12px] font-medium text-foreground transition-colors hover:border-brand/50 hover:bg-brand/10 sm:px-3"
    >
      <PlugsConnected size={13} className="text-muted-foreground" />
      <span>Connect</span>
      <span className="ml-1 hidden items-center overflow-hidden md:flex">
        <span
          key={logoIndex}
          className="inline-flex items-center gap-1.5 animate-in fade-in-0 slide-in-from-bottom-3 duration-300"
        >
          <span className="grid h-4 w-4 shrink-0 place-items-center [&_svg]:h-4 [&_svg]:w-4">
            <Logo className="h-4 w-4" />
          </span>
          {current.name}
        </span>
      </span>
    </button>
  );
}

function AppSidebar({ pathname }: { pathname: string }) {
  const host = useDashboardHost();
  const asideRef = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setCollapsed(localStorage.getItem("v2-sidebar-collapsed") === "1");
      setHydrated(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem("v2-sidebar-collapsed", collapsed ? "1" : "0");
  }, [collapsed, hydrated]);

  function startDrag(event: ReactPointerEvent) {
    event.preventDefault();
    setDragging(true);
    const left = asideRef.current?.getBoundingClientRect().left ?? 0;
    const onMove = (moveEvent: PointerEvent) => {
      setCollapsed(moveEvent.clientX - left <= COLLAPSE_AT);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }

  return (
    <aside
      ref={asideRef}
      data-collapsed={collapsed || undefined}
      style={{ width: collapsed ? RAIL : EXPANDED }}
      className="relative hidden shrink-0 flex-col border-r border-border bg-card transition-[width] duration-150 ease-out md:flex"
    >
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        <div className="animate-in fade-in-0 slide-in-from-right-8 duration-300">
          <div className="mb-5 flex flex-col gap-0.5">
            {PROJECT_TOP.map((item) => (
              <NavRow
                key={item.label}
                item={item}
                active={false}
                collapsed={collapsed}
              />
            ))}
          </div>
          {GROUPS.map((group) => (
            <div key={group.heading} className="mb-5 last:mb-0">
              {!collapsed && (
                <div className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/50">
                  {group.heading}
                </div>
              )}
              {collapsed && <div className="mx-2 mb-2 border-t border-border/70" />}
              <div className="flex flex-col gap-0.5">
                {group.items
                  .filter((item) => !item.capability || host.capabilities?.[item.capability] !== false)
                  .map((item) => (
                  <NavRow
                    key={item.label}
                    item={item}
                    active={!item.external && isActive(pathname, item.href)}
                    collapsed={collapsed}
                  />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </nav>

      <div className="flex flex-col gap-1 border-t border-border px-2 py-3">
        <UserMenu collapsed={collapsed} />
      </div>

      <div
        onPointerDown={startDrag}
        onDoubleClick={() => setCollapsed((value) => !value)}
        aria-hidden
        className="group absolute right-0 top-0 h-full w-2 translate-x-1/2 cursor-col-resize"
      >
        <div
          className={`mx-auto h-full w-px transition-colors ${
            dragging ? "bg-brand" : "bg-transparent group-hover:bg-brand/50"
          }`}
        />
      </div>
    </aside>
  );
}

function UserMenu({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative ${collapsed ? "" : "w-full"}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label="Account menu"
        title="Account"
        className={`flex items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground ${
          collapsed ? "h-8 w-8 justify-center" : "h-8 w-full gap-2.5 px-2 text-[13px]"
        }`}
      >
        <User size={17} className="shrink-0" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-left font-medium text-foreground">
              Self-hosted
            </span>
            <CaretUpDown size={13} className="shrink-0" />
          </>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-[calc(100%+6px)] left-0 z-50 w-56 overflow-hidden rounded-md border border-border bg-popover shadow-xl">
            <div className="border-b border-border px-3 py-2.5">
              <div className="truncate text-[13px] font-medium text-foreground">
                Self-hosted
              </div>
              <div className="truncate text-[12px] text-muted-foreground">
                Local runtime
              </div>
            </div>
            <div className="p-1">
              <ThemeMenu />
              <button
                type="button"
                disabled
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground"
              >
                <SignOut size={15} className="text-muted-foreground" />
                Log out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const THEME_ORDER = ["light", "dark", "system"] as const;

function ThemeMenu() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = (mounted ? theme : "system") as (typeof THEME_ORDER)[number];
  const Icon = current === "light" ? Sun : current === "dark" ? Moon : Desktop;
  return (
    <button
      type="button"
      onClick={() =>
        setTheme(
          THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length],
        )
      }
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] text-foreground transition-colors hover:bg-secondary/60"
    >
      <Icon size={15} className="text-muted-foreground" />
      Theme
      <span className="ml-auto text-[12px] capitalize text-muted-foreground">
        {mounted ? current : ""}
      </span>
    </button>
  );
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavRow({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  const icon = (
    <Icon
      size={17}
      weight={active ? "bold" : "regular"}
      className={
        active
          ? "shrink-0 text-foreground"
          : "shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
      }
    />
  );
  const externalProps = item.external
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};

  if (collapsed) {
    return (
      <Link
        href={item.href}
        {...externalProps}
        aria-label={item.label}
        title={item.label}
        className={`group grid h-8 w-8 place-items-center rounded-md transition-colors ${
          active
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
        }`}
      >
        {icon}
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      {...externalProps}
      className={`group relative flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors ${
        active
          ? "bg-secondary font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
      }`}
    >
      {active && (
        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
      )}
      {icon}
      <span className="flex-1 truncate">{item.label}</span>
      {item.external && (
        <ArrowSquareOut size={12} className="shrink-0 text-muted-foreground/40" />
      )}
    </Link>
  );
}
