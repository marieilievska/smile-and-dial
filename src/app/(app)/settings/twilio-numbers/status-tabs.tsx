import Link from "next/link";

import { Badge } from "@/components/ui/badge";

const TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "in_pool", label: "In pool" },
  { value: "released", label: "Released" },
];

/** Segmented status control for /settings/twilio-numbers. Default is
 *  All so the buy → release lifecycle remains visible in one place;
 *  admins can narrow to "In pool" once their workspace has a lot of
 *  released numbers cluttering the view. */
export function TwilioNumbersStatusTabs({
  current,
  counts,
  buildHref,
}: {
  current: string;
  counts: { all: number; in_pool: number; released: number };
  buildHref: (status: string) => string;
}) {
  function valueFor(key: string): number {
    if (key === "in_pool") return counts.in_pool;
    if (key === "released") return counts.released;
    return counts.all;
  }
  return (
    <nav
      aria-label="Filter numbers by status"
      data-testid="twilio-numbers-status-tabs"
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
