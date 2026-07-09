import Link from "next/link";
import {
  Bot,
  ClipboardCheck,
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
  { key: "call-review", label: "Call Review", icon: ClipboardCheck },
  { key: "voice", label: "Voice of Customer", icon: MessageSquare },
  { key: "hot-leads", label: "Hot Leads", icon: Flame },
  { key: "changelog", label: "App Changelog", icon: History },
  { key: "prompt-log", label: "Agent Prompt Log", icon: Bot },
] as const;

export type ReportingTabKey = (typeof REPORTING_TABS)[number]["key"];

/** The tabs to show for the current scope. Voice of Customer shows when the
 *  campaign has a detected sentiment field; Hot Leads keeps its interest-driven
 *  gate (Phase 3 generalizes it). Call Review is admin-only — the public
 *  token-gated share surface must pass `showCallReview: false` so external
 *  recipients never see the tab (it has no share render branch, and buckets are
 *  admin-only by design). */
export function reportingTabsFor({
  showVoice,
  showHotLeads,
  showCallReview = true,
}: {
  showVoice: boolean;
  showHotLeads: boolean;
  showCallReview?: boolean;
}): readonly (typeof REPORTING_TABS)[number][] {
  return REPORTING_TABS.filter((t) => {
    if (t.key === "voice") return showVoice;
    if (t.key === "hot-leads") return showHotLeads;
    if (t.key === "call-review") return showCallReview;
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
