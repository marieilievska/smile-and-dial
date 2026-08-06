import { REPORTING_TABS, type ReportingTabKey } from "./reporting-tabs";

/** Empty-state shown inside a Reporting tab that can be opened but has nothing
 *  to render yet (e.g. Voice of Customer / Hot Leads under the combined view or
 *  a campaign with no sentiment field). The tab always stays in the nav; this
 *  explains why it's empty and what to do, instead of the tab vanishing. Title
 *  and icon come from the shared tab list so they can't drift from the nav. */
export function ReportingNotice({
  tab,
  message,
}: {
  tab: ReportingTabKey;
  message: string;
}) {
  const meta = REPORTING_TABS.find((t) => t.key === tab)!;
  const Icon = meta.icon;
  return (
    <div className="border-border bg-card flex flex-col items-center gap-3 rounded-xl border p-12 text-center">
      <Icon className="text-muted-foreground/60 size-8" aria-hidden />
      <p className="text-foreground text-base font-semibold">{meta.label}</p>
      <p className="text-muted-foreground max-w-md text-sm leading-relaxed">
        {message}
      </p>
    </div>
  );
}
