import type { FunnelStep } from "@/lib/analytics/stats";

/** The per-business conversion funnel hero. Each stage is a horizontal bar
 *  whose width is its share of the top stage ("Called"), with the count and the
 *  step-over-step conversion to its right. The final stage (Goals met) is tinted
 *  green. Plain divs — no charting dependency. Stage counts come from
 *  buildLeadFunnel (distinct leads), so the bars narrow cleanly. */
export function AnalyticsFunnel({ steps }: { steps: FunnelStep[] }) {
  const top = steps[0]?.count ?? 0;
  const last = steps[steps.length - 1]?.count ?? 0;
  const overallPct = top === 0 ? 0 : (last / top) * 100;
  return (
    <section
      data-testid="analytics-funnel"
      className="border-border bg-card rounded-2xl border p-6"
    >
      <div className="mb-5 flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-base font-medium">
          Conversion funnel
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          per business · {overallPct.toFixed(1)}% dial → goal
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {steps.map((s, i) => {
          const widthPct = top === 0 ? 0 : (s.count / top) * 100;
          const prev = i === 0 ? null : steps[i - 1];
          const stepPct =
            prev && prev.count > 0
              ? Math.round((s.count / prev.count) * 100)
              : null;
          const isGoal = i === steps.length - 1;
          return (
            <div key={s.label}>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground text-sm">{s.label}</span>
                <span className="text-sm">
                  <span
                    className={`font-medium tabular-nums ${
                      isGoal ? "text-success" : "text-foreground"
                    }`}
                  >
                    {s.count.toLocaleString()}
                  </span>
                  {stepPct != null && prev ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {stepPct}% of {prev.label.toLowerCase()}
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="bg-muted h-3.5 w-full overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${Math.max(s.count > 0 ? 2 : 0, widthPct)}%`,
                    background: isGoal ? "var(--success)" : "var(--primary)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
