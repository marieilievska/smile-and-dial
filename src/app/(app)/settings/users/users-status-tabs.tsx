import Link from "next/link";

import { Badge } from "@/components/ui/badge";

const TABS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "all", label: "All" },
];

/** Status segmented control for /settings/users. URL-driven; renders
 *  match-counts inside the pill so the eye knows how big each slice
 *  is. */
export function UsersStatusTabs({
  current,
  counts,
  buildHref,
}: {
  current: string;
  counts: { active: number; inactive: number; all: number };
  buildHref: (status: string) => string;
}) {
  function valueFor(key: string): number {
    if (key === "active") return counts.active;
    if (key === "inactive") return counts.inactive;
    return counts.all;
  }
  return (
    <nav
      aria-label="Filter users by status"
      data-testid="users-status-tabs"
      className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 self-start rounded-lg border p-1"
    >
      {TABS.map((t) => {
        const active = current === t.value;
        return (
          <Link
            key={t.value}
            href={buildHref(t.value)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-8 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {t.label}
            <Badge
              variant={active ? "secondary" : "outline"}
              className="px-1.5 py-0 text-[10px] tabular-nums"
            >
              {valueFor(t.value).toLocaleString()}
            </Badge>
          </Link>
        );
      })}
    </nav>
  );
}
