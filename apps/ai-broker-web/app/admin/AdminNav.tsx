"use client";

import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CandlestickChart, Database, Trophy, Users, Vote } from "lucide-react";

interface AdminSection {
  href: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Sidebar sections, in the order they appear — laid out like the debate-ai
 * admin dashboard (packages/debate-webview-admin): an icon, a name and a
 * one-line description of what the section controls.
 */
export const ADMIN_SECTIONS: AdminSection[] = [
  { href: "/admin/users", name: "Users", description: "Accounts and per-user usage", icon: Users },
  {
    href: "/admin/markets",
    name: "Prediction markets",
    description: "Publish or hide markets and refill them from Polymarket",
    icon: Vote,
  },
  {
    href: "/admin/stocks",
    name: "Stocks",
    description: "Feature stocks or hide them from the public lists",
    icon: CandlestickChart,
  },
  {
    href: "/admin/traders",
    name: "Top traders",
    description: "Leaders from Polymarket, ZuluTrade and NVSTLY",
    icon: Trophy,
  },
  { href: "/admin/database", name: "Database", description: "Browse and edit D1 tables", icon: Database },
];

export function isActiveSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}

export default function AdminNav({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "";

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="bg-muted/40 border-b">
        <div className="mx-auto flex h-12 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <span className="text-sm font-semibold">Admin</span>
          <Link href="/" className="text-muted-foreground hover:text-foreground ml-auto text-xs">
            ← Back to app
          </Link>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row">
        <nav aria-label="Admin sections" className="md:w-60 md:shrink-0">
          <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
            {ADMIN_SECTIONS.map(({ href, name, description, icon: Icon }) => {
              const active = isActiveSection(pathname, href);
              return (
                <li key={href} className="shrink-0">
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={`flex items-start gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      <span className="block font-medium">{name}</span>
                      <span className="text-muted-foreground hidden text-xs md:block">{description}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
