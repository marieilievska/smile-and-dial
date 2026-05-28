"use client";

import { Bookmark } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

import {
  NAV_SECTION_LABELS,
  navItems,
  type NavItem,
  type NavSection,
} from "@/lib/nav";
import { cn } from "@/lib/utils";

const SECTION_ORDER: NavSection[] = ["workflow", "operations", "admin"];

/** Each nav item can host a list of user-saved filter presets. Close
 *  calls them Smart Views; we keep our `saved_views` table name. The
 *  `page` column on saved_views maps to the route path (e.g. "leads"
 *  → /leads) so we group them under the matching nav item. */
export type SidebarSavedView = {
  id: string;
  page: string;
  name: string;
  params: string;
};

/** Map a nav href to the `saved_views.page` value that lists under it.
 *  Only Leads has saved views today, but adding Calls/Callbacks/etc.
 *  later is a one-line change here. */
const SAVED_VIEWS_FOR_HREF: Record<string, string> = {
  "/leads": "leads",
};

export function AppSidebar({
  isAdmin,
  savedViews = [],
}: {
  isAdmin: boolean;
  savedViews?: SidebarSavedView[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const visible = navItems.filter((item) => !item.adminOnly || isAdmin);

  // Group by section, preserving the order defined in nav.ts.
  const grouped = new Map<NavSection, NavItem[]>();
  for (const item of visible) {
    const bucket = grouped.get(item.section) ?? [];
    bucket.push(item);
    grouped.set(item.section, bucket);
  }

  // Group saved views by their `page` value for O(1) lookup per nav item.
  const viewsByPage = new Map<string, SidebarSavedView[]>();
  for (const v of savedViews) {
    const bucket = viewsByPage.get(v.page) ?? [];
    bucket.push(v);
    viewsByPage.set(v.page, bucket);
  }

  // What's the URL we'd compare against to know "this saved view is
  // currently applied"? It's the current pathname + sorted params.
  const currentParams = searchParams.toString();

  return (
    <aside className="border-sidebar-border bg-sidebar flex w-60 shrink-0 flex-col border-r">
      <div className="border-sidebar-border flex h-16 shrink-0 items-center border-b px-6">
        {/* Round 25 — Referrizer-aligned shell. The whitespace ampersand
         *  gets the sidebar's primary-foreground white so it reads as
         *  one wordmark, not a coral accent on a dark surface. */}
        <span className="text-sidebar-primary-foreground text-lg font-bold tracking-tight">
          Smile &amp; Dial
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
                const savedViewKey = SAVED_VIEWS_FOR_HREF[item.href];
                const itemSavedViews = savedViewKey
                  ? (viewsByPage.get(savedViewKey) ?? [])
                  : [];
                return (
                  <div key={item.href} className="flex flex-col gap-0.5">
                    <Link
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
                    {/* Nested saved views under this nav item — Close-style
                        Smart Views graduating from a dropdown into the rail
                        itself. */}
                    {itemSavedViews.length > 0 ? (
                      <ul
                        data-testid={`sidebar-saved-views-${item.href.replace(/\//g, "")}`}
                        className="border-sidebar-border ml-3 flex flex-col gap-0.5 border-l pl-3"
                      >
                        {itemSavedViews.map((view) => {
                          const viewActive =
                            active && currentParams === view.params;
                          return (
                            <li key={view.id}>
                              <Link
                                href={
                                  view.params
                                    ? `${item.href}?${view.params}`
                                    : item.href
                                }
                                aria-current={viewActive ? "page" : undefined}
                                className={cn(
                                  "flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors",
                                  viewActive
                                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                                )}
                              >
                                <Bookmark className="size-3 shrink-0" />
                                <span className="truncate">{view.name}</span>
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
