import Link from "next/link";
import {
  Bot,
  CalendarClock,
  PhoneCall,
  HeartCrack,
  History,
  LayoutDashboard,
} from "lucide-react";

/** The Reporting hub's tabs. Shared by the in-app page and the public
 *  read-only share so the two never drift. Plain (non-"use client") module
 *  so both Server Components can import the array + component safely. */
export const REPORTING_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "cohorts", label: "Cohorts", icon: CalendarClock },
  { key: "cause-of-death", label: "Cause of Death", icon: HeartCrack },
  { key: "numbers", label: "Numbers", icon: PhoneCall },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;

export type ReportingTabKey = (typeof REPORTING_TABS)[number]["key"];

/** The tabs to show for the current audience.
 *
 *  `showNumbers: false` is for the public token-gated share surface: the
 *  Numbers tab lists our own phone numbers, their campaigns, and which are
 *  burned or resting — operational detail an external recipient has no business
 *  seeing, and a shopping list for anyone wanting to report our numbers as spam.
 *
 *  `isAdmin: false` hides App Changelog and Agent Prompt Log from members. Not
 *  a policy choice so much as an honesty one: their RLS is admin-only
 *  (`app_changelog_admin_all`, `agent_prompt_log_admin_all`), so a member
 *  opening either would be shown a permanently empty table with no explanation.
 *  Hiding beats explaining. Everything else is scoped by RLS to the leads the
 *  viewer owns, which is exactly what a member should see. */
export function reportingTabsFor({
  showNumbers = true,
  showCohorts = true,
  isAdmin = true,
}: {
  showNumbers?: boolean;
  showCohorts?: boolean;
  isAdmin?: boolean;
} = {}): readonly (typeof REPORTING_TABS)[number][] {
  return REPORTING_TABS.filter((t) => {
    if (t.key === "numbers") return showNumbers;
    // Cohorts is kept off the public share: it puts cost per registration and
    // cost per sale on screen, which is our economics, not a recipient's
    // business.
    if (t.key === "cohorts") return showCohorts;
    if (t.key === "changelog" || t.key === "prompt-log") return isAdmin;
    return true;
  });
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
