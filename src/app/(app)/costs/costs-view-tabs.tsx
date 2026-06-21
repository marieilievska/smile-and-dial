import Link from "next/link";

/** Segmented control for the six Costs views. Round 20 — rebuilt as a
 *  proper pill tablist (matches the analytics date pills) instead of
 *  the old ghost-button row. Order reflects intent: rollups first
 *  (where is the spend?), raw last (drill into individual calls).
 *
 *  Each label drops the "Per" prefix — the heading "Costs" already
 *  carries the "per" meaning. "Per goal met" is kept verbatim because
 *  the test reaches for that link by accessible name; if the test is
 *  ever updated we can shorten it to "Goal Met". */
/** Round 29 — collapsed from 7 tabs to 5. The Vendor view became a
 *  small inline breakdown panel on the Campaign rollup (vendor data
 *  lived alongside campaign data anyway), and the Per-user view was
 *  cut entirely — admins curious about user-level spend can still
 *  visit `?view=per_user` directly via the URL during the deprecation
 *  window, and the page will render it; we just don't surface a tab.
 *  This removes the "wall of segments" feeling the page had grown. */
const VIEWS: { value: string; label: string }[] = [
  { value: "per_campaign", label: "Campaign" },
  { value: "per_list", label: "List" },
  { value: "per_goal", label: "Per goal met" },
  { value: "per_time", label: "Day" },
  { value: "per_call", label: "Call" },
];

export function CostsViewTabs({
  current,
  buildHref,
}: {
  current: string;
  buildHref: (view: string) => string;
}) {
  // We render as a row of real anchor links rather than a `role="tablist"`
  // because each tab is a URL navigation (not a client-only panel switch).
  // Playwright tests reach these via getByRole("link", { name }) — adding
  // role="tab" would mask the link role and break the test.
  return (
    <nav
      aria-label="Cost view"
      data-testid="costs-view-tabs"
      className="border-border bg-background inline-flex flex-wrap items-center gap-0.5 self-start rounded-xl border p-1"
    >
      {VIEWS.map((v) => {
        const active = current === v.value;
        return (
          <Link
            key={v.value}
            href={buildHref(v.value)}
            aria-current={active ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded-md px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60"
            }`}
          >
            {v.label}
          </Link>
        );
      })}
    </nav>
  );
}

export const COSTS_VIEWS = VIEWS;
