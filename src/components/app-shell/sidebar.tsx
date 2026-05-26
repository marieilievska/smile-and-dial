"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  NAV_SECTION_LABELS,
  navItems,
  type NavItem,
  type NavSection,
} from "@/lib/nav";
import { cn } from "@/lib/utils";

const SECTION_ORDER: NavSection[] = ["workflow", "operations", "admin"];

export function AppSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const visible = navItems.filter((item) => !item.adminOnly || isAdmin);

  // Group by section, preserving the order defined in nav.ts.
  const grouped = new Map<NavSection, NavItem[]>();
  for (const item of visible) {
    const bucket = grouped.get(item.section) ?? [];
    bucket.push(item);
    grouped.set(item.section, bucket);
  }

  return (
    <aside className="border-sidebar-border bg-sidebar flex w-60 shrink-0 flex-col border-r">
      <div className="border-sidebar-border flex h-16 shrink-0 items-center border-b px-6">
        <span className="text-sidebar-foreground text-lg font-bold tracking-tight">
          Smile <span className="text-coral">&amp;</span> Dial
        </span>
      </div>
      <nav
        aria-label="Main"
        className="flex flex-1 flex-col gap-4 overflow-y-auto p-3"
      >
        {SECTION_ORDER.map((section) => {
          const items = grouped.get(section);
          if (!items || items.length === 0) return null;
          return (
            <div
              key={section}
              data-testid={`sidebar-section-${section}`}
              className="flex flex-col gap-1"
            >
              <p className="text-sidebar-foreground/60 px-3 pt-1 text-[10px] font-semibold tracking-wider uppercase">
                {NAV_SECTION_LABELS[section]}
              </p>
              {items.map((item) => {
                const active =
                  pathname === item.href ||
                  pathname.startsWith(`${item.href}/`);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <item.icon className="size-4 shrink-0" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
