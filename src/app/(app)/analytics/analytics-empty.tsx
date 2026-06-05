import { BarChart3 } from "lucide-react";
import Link from "next/link";

/** One motivating empty state for /analytics when the selected window has
 *  zero calls — replaces the old scatter of "0" hero + "No campaigns" +
 *  "No outcomes" + empty funnel that read as a broken page. Keeps the
 *  header + date pills above it so changing the range is one tap away. */
export function AnalyticsEmpty() {
  return (
    <section
      data-testid="analytics-empty"
      className="border-border bg-card animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center duration-500"
    >
      <span className="bg-primary/10 text-primary inline-flex size-12 items-center justify-center rounded-full">
        <BarChart3 className="size-6" />
      </span>
      <h2 className="text-foreground text-lg font-semibold">
        No activity in this window yet
      </h2>
      <p className="text-muted-foreground max-w-md text-sm">
        Once your AI places calls in this date range, your goals met, conversion
        funnel, and top campaigns show up here. Try widening the range, or get a
        campaign dialing.
      </p>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/analytics?preset=last30"
          className="border-border hover:bg-muted/60 text-foreground inline-flex h-8 items-center rounded-lg border px-3 text-sm font-medium transition-colors"
        >
          Widen to 30 days
        </Link>
        <Link
          href="/campaigns"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors"
        >
          Go to campaigns
        </Link>
      </div>
    </section>
  );
}
