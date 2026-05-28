"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/** Date-range segmented control at the top of /analytics. Round 17 —
 *  primary axis of the page, so it deserves its own pill row rather
 *  than being buried in a filter wall. Custom opens From/To inputs
 *  inline (the page renders them when preset=custom). */
const PRESETS: { value: string; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "7 days" },
  { value: "last30", label: "30 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

export function AnalyticsDatePills({ current }: { current: string }) {
  const searchParams = useSearchParams();
  function hrefFor(value: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("preset", value);
    // Drop from/to when leaving Custom so the next preset takes over
    // cleanly.
    if (value !== "custom") {
      params.delete("from");
      params.delete("to");
    }
    return `/analytics?${params.toString()}`;
  }
  return (
    <div
      role="tablist"
      aria-label="Date range"
      className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 rounded-lg border p-1"
    >
      {PRESETS.map((p) => {
        const active = current === p.value;
        return (
          <Link
            key={p.value}
            href={hrefFor(p.value)}
            role="tab"
            aria-selected={active}
            className={`inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {p.label}
          </Link>
        );
      })}
    </div>
  );
}
