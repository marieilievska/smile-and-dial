"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { callbacksHref } from "./callbacks-url";

/** Segmented control replacing the Status dropdown filter.
 *
 *  Five tabs: Pending (default), Completed, Missed, Cancelled, All.
 *  Each renders a small count badge so the user can see at a glance
 *  how many records sit in each bucket without changing the view.
 *
 *  Rendered as <Link>s so:
 *   - The browser handles middle-click → new tab naturally
 *   - Right-click → open in new window is preserved
 *   - JS doesn't need to be ready for the tabs to work */
const TABS: { value: string; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "missed", label: "Missed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
];

export type CallbackCounts = Record<string, number>;

export function CallbacksStatusTabs({
  current,
  counts,
}: {
  current: string;
  counts: CallbackCounts;
}) {
  const searchParams = useSearchParams();
  const params: Record<string, string> = {};
  searchParams.forEach((value, key) => {
    params[key] = value;
  });

  return (
    <div
      role="tablist"
      aria-label="Callback status"
      className="border-border bg-background inline-flex items-center gap-0.5 rounded-xl border p-1"
    >
      {TABS.map((tab) => {
        const active = current === tab.value;
        const href = callbacksHref(params, {
          status: tab.value,
          page: undefined,
        });
        const count = counts[tab.value];
        return (
          <Link
            key={tab.value}
            href={href}
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
