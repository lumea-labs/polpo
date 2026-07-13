"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Atom,
  Brain,
  ChatCircleText,
  ClockCounterClockwise,
  Files,
  GraduationCap,
} from "@phosphor-icons/react";

const links = [
  { href: "/playground", label: "Playground", icon: ChatCircleText },
  { href: "/agents", label: "Agents", icon: Atom },
  { href: "/skills", label: "Skills", icon: GraduationCap },
  { href: "/memory", label: "Shared memory", icon: Brain },
  { href: "/files", label: "Files", icon: Files },
  { href: "/sessions", label: "Sessions", icon: ClockCounterClockwise },
];

function activePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  return (
    <div className="oss-shell">
      <aside className="oss-sidebar">
        <div className="oss-brand"><span className="oss-brand-mark">P</span><span>Polpo</span><small>Self-hosted</small></div>
        <nav className="oss-nav">{links.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-active={activePath(pathname, href)}><Icon size={17} weight={activePath(pathname, href) ? "fill" : "regular"} />{label}</Link>)}</nav>
        <div className="oss-sidebar-footer"><span className="oss-status" />Local runtime</div>
      </aside>
      <header className="oss-mobile-header"><strong>Polpo</strong><select aria-label="Navigate" value={links.find((link) => activePath(pathname, link.href))?.href ?? "/agents"} onChange={(event) => router.push(event.target.value)}>{links.map((link) => <option key={link.href} value={link.href}>{link.label}</option>)}</select></header>
      <main className="oss-main">{children}</main>
    </div>
  );
}
