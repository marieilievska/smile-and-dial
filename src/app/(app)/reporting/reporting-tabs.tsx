import Link from "next/link";
import {
  Bot,
  Flame,
  History,
  LayoutDashboard,
  MessageSquare,
} from "lucide-react";

/** The Reporting hub's tabs. Shared by the in-app page and the public
 *  read-only share so the two never drift. Plain (non-"use client") module
 *  so both Server Components can import the array + component safely. */
export const REPORTING_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "voice", label: "Voice of Customer", icon: MessageSquare },
  { key: "hot-leads", label: "Hot Leads", icon: Flame },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;

export type ReportingTabKey = (typeof REPORTING_TABS)[number]["key"];

/** Shown above the interest tabs (Voice of Customer, Hot Leads) in the combined
 *  / all-agents view, where they aggregate every agent's data but interest is
 *  only collected by the Market Research campaign today. Shared by the in-app
 *  page and the public share so the wording can't drift. */
export const INTEREST_COMBINED_NOTE =
  "Heads-up: yes / no / maybe is only recorded by agents set up to ask about it — currently the Market Research campaign — so this combined view reflects those calls.";

/** The tabs to show for the current scope. The interest-based tabs (Voice of
 *  Customer, Hot Leads) only make sense when the scope has yes/no/maybe data. */
export function reportingTabsFor(
  showInterest: boolean,
): readonly (typeof REPORTING_TABS)[number][] {
  if (showInterest) return REPORTING_TABS;
  return REPORTING_TABS.filter(
    (t) => t.key !== "voice" && t.key !== "hot-leads",
  );
}

/** Elevated segmented tab bar. `hrefFor` lets each surface build its own
 *  links (/reporting?tab=… vs /share/reporting/<token>?tab=…). */
export function ReportingTabs({
  active,
  hrefFor,
  tabs = REPORTING_TABS,
}: {
  active: string;
  hrefFor: (key: ReportingTabKey) => string;
  tabs?: readonly (typeof REPORTING_TABS)[number][];
}) {
  return (
    <nav
      aria-label="Reporting sections"
      className="border-border bg-card flex flex-wrap items-center gap-1 rounded-xl border p-1 shadow-sm"
    >
      {tabs.map((t) => {
        const isActive = t.key === active;
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            href={hrefFor(t.key)}
            aria-current={isActive ? "page" : undefined}
            className={
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors " +
              (isActive
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/60")
            }
          >
            <Icon className="size-4" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
