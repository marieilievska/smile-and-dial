import Link from "next/link";
import {
  Bot,
  PhoneCall,
  Flame,
  HeartCrack,
  History,
  LayoutDashboard,
  MessageSquare,
} from "lucide-react";

/** The Reporting hub's tabs. Shared by the in-app page and the public
 *  read-only share so the two never drift. Plain (non-"use client") module
 *  so both Server Components can import the array + component safely. */
export const REPORTING_TABS = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { key: "cause-of-death", label: "Cause of Death", icon: HeartCrack },
  { key: "voice", label: "Voice of Customer", icon: MessageSquare },
  { key: "hot-leads", label: "Hot Leads", icon: Flame },
  { key: "numbers", label: "Numbers", icon: PhoneCall },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;

export type ReportingTabKey = (typeof REPORTING_TABS)[number]["key"];

/** The tabs to show for the current scope. Voice of Customer and Hot Leads are
 *  always present: they stay openable and explain themselves with an in-tab
 *  notice when there's nothing to render (combined view, or a campaign with no
 *  sentiment field) — see voiceUnavailableReason / hotLeadsUnavailableReason —
 *  rather than silently vanishing from the nav. Numbers is admin-only: the
 *  public token-gated share surface must pass `showNumbers: false` so external
 *  recipients never see it, since it lists our own phone numbers, their
 *  campaigns, and which are burned or resting — operational detail an external
 *  recipient has no business seeing, and a shopping list for anyone wanting to
 *  report our numbers as spam. */
export function reportingTabsFor({
  showNumbers = true,
}: {
  showNumbers?: boolean;
} = {}): readonly (typeof REPORTING_TABS)[number][] {
  return REPORTING_TABS.filter((t) => {
    if (t.key === "numbers") return showNumbers;
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
