import { Sparkles } from "lucide-react";

import type { AnalyticsInsight as Insight } from "@/lib/analytics/stats";

/** AI "read" of the period — the 2026 differentiator on /analytics.
 *  Instead of leaving the business owner to eyeball a wall of numbers,
 *  we lead with one plain-English sentence on whether appointments are
 *  up or down and where the biggest leak is. Server-safe (no hooks); the
 *  sentence is computed deterministically in buildInsights().
 *
 *  The Sparkles accent that used to sit on the hero KPI lives here now —
 *  this card is the page's single "AI" moment, so the cue belongs on it
 *  rather than scattered across every tile. */
export function AnalyticsInsight({ insight }: { insight: Insight }) {
  // A green left edge when the trend is improving, amber when it's
  // slipping — so the card's tone is legible before a word is read.
  const rail =
    insight.tone === "up"
      ? "border-l-[color:var(--success)]"
      : insight.tone === "down"
        ? "border-l-[color:var(--warning)]"
        : "border-l-[color:var(--primary)]";

  return (
    <section
      data-testid="analytics-insight"
      className={`bg-card border-border animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex items-start gap-3 rounded-xl border border-l-[3px] p-4 duration-500 ${rail}`}
    >
      <span className="bg-primary/10 text-primary mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full">
        <Sparkles className="size-4" />
      </span>
      <div className="flex flex-col gap-0.5">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
          What changed
        </p>
        <p className="text-foreground text-sm font-medium">
          {insight.headline}
        </p>
        {insight.detail ? (
          <p className="text-muted-foreground text-sm">{insight.detail}</p>
        ) : null}
      </div>
    </section>
  );
}
