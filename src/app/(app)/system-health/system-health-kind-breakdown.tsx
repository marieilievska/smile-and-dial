import Link from "next/link";

import { humanizeKind } from "./humanize-kind";
import type { KindCount } from "./stats-query";

/** "What's happening" — the top event kinds in the last 24h, ranked by
 *  count. The health analogue of the Costs "where the money goes"
 *  panel: turns a flat firehose into "here's what's actually firing".
 *  Each row deep-links to that kind's filtered view. Bar color carries
 *  severity (red = error, amber = warn, neutral = info). Renders
 *  nothing when there's been no activity. */
export function SystemHealthKindBreakdown({
  byKind,
  total,
}: {
  byKind: KindCount[];
  total: number;
}) {
  if (byKind.length === 0 || total === 0) return null;

  const top = byKind.slice(0, 6);
  const max = Math.max(1, ...top.map((k) => k.count));
  const barColor = (sev: KindCount["severity"]): string =>
    sev === "error"
      ? "var(--destructive)"
      : sev === "warn"
        ? "var(--warning)"
        : "var(--muted-foreground)";

  return (
    <section
      data-testid="system-health-kind-breakdown"
      className="border-border bg-card flex flex-col gap-3 rounded-xl border p-5"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-semibold">
          What&apos;s happening
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          {total.toLocaleString()} events · last 24h
        </p>
      </div>
      <ul className="flex flex-col gap-2.5 text-sm">
        {top.map((k) => {
          const pct = (k.count / max) * 100;
          const share = total > 0 ? Math.round((k.count / total) * 100) : 0;
          return (
            <li key={k.kind}>
              <Link
                href={`/system-health?kind=${encodeURIComponent(k.kind)}`}
                className="group focus-visible:ring-ring/60 hover:bg-muted/40 -mx-2 flex flex-col gap-1 rounded-md px-2 py-1 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-foreground inline-flex items-center gap-2 font-medium">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 shrink-0 rounded-full"
                      style={{ background: barColor(k.severity) }}
                    />
                    {humanizeKind(k.kind)}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {k.count.toLocaleString()} ({share}%)
                  </span>
                </div>
                <div className="bg-muted h-2 w-full overflow-hidden rounded">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${Math.max(2, pct)}%`,
                      background: barColor(k.severity),
                    }}
                  />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
