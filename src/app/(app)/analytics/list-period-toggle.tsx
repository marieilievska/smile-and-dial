"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

/**
 * All time / This range, for the "Performance by lead list" section.
 *
 * The one control on this page that opts out of the date pills. Lists are
 * imported at different moments and worked to different depths, so judging them
 * through a shared thirty-day window would score a list you finished six weeks
 * ago as a failure. All time is therefore the default; This range is there for
 * "what did each list do lately".
 *
 * A link rather than a control with state, like the date pills — the period is
 * in the URL, so a view is shareable and survives a refresh. `scroll={false}`
 * because this section sits well down the page and flipping the toggle should
 * not fling the reader back to the top.
 */
const OPTIONS = [
  { value: "all", label: "All time" },
  { value: "range", label: "This range" },
] as const;

export function ListPeriodToggle({ current }: { current: "all" | "range" }) {
  const searchParams = useSearchParams();

  function hrefFor(value: string): string {
    const params = new URLSearchParams(searchParams.toString());
    // "all" is the default, so it stays out of the URL rather than being
    // written in — a shared link should carry only what was actually changed.
    if (value === "all") params.delete("listperiod");
    else params.set("listperiod", value);
    const qs = params.toString();
    return qs ? `/analytics?${qs}` : "/analytics";
  }

  return (
    <div
      role="tablist"
      aria-label="Lead list period"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {OPTIONS.map((o) => {
        const active = current === o.value;
        return (
          <Link
            key={o.value}
            href={hrefFor(o.value)}
            scroll={false}
            role="tab"
            aria-selected={active}
            className={`inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}
