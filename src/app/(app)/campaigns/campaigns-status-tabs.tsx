"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/** Status segmented control on /campaigns. Mirrors the callbacks /
 *  goals pattern: active is the default tab; All shows everything
 *  including ended. */
const TABS: { value: string; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "draft", label: "Draft" },
  { value: "ended", label: "Ended" },
  { value: "all", label: "All" },
];

export type CampaignCounts = Record<string, number>;

export function CampaignsStatusTabs({
  current,
  counts,
}: {
  current: string;
  counts: CampaignCounts;
}) {
  const searchParams = useSearchParams();
  function hrefFor(value: string): string {
    const params = new URLSearchParams(searchParams.toString());
    params.set("status", value);
    return `/campaigns?${params.toString()}`;
  }

  return (
    <div
      role="tablist"
      aria-label="Campaign status"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-lg border p-1"
    >
      {TABS.map((tab) => {
        const active = current === tab.value;
        const count = counts[tab.value];
        return (
          <Link
            key={tab.value}
            href={hrefFor(tab.value)}
            role="tab"
            aria-selected={active}
            className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {tab.label}
            {typeof count === "number" && count > 0 ? (
              <span
                className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums ${
                  active
                    ? "bg-background/15 text-background"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
