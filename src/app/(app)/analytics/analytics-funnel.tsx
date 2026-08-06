import type { FunnelStep } from "@/lib/analytics/stats";

/** Goals met, shown as the funnel card's "Outcome" — deliberately its OWN unit,
 *  not a fifth funnel stage. A goal can be met without reaching the
 *  decision-maker (a gatekeeper books the slot, a survey is completed), so goals
 *  aren't a subset of "Decision-makers reached" and can exceed it — which would
 *  render as a funnel bar that widens instead of narrows. So it gets its own
 *  baseline (Goals met = 100%), where the decision-maker share IS a true subset
 *  of goals. */
export type FunnelOutcome = {
  goalMet: number;
  goalMetWithDm: number;
  /** Goals met as a share of the Conversations stage (0–1) — the descriptor on
   *  the "Goals met" bar, so it reconciles with the funnel above. */
  goalRateOfConversations: number;
};

/** One labelled bar: label + count (+ optional descriptor) over a track whose
 *  fill is `widthPct` of the row's baseline, in `color`. A non-zero count always
 *  shows at least a sliver so it's never invisible. */
function Bar({
  label,
  count,
  widthPct,
  descriptor,
  color,
  testId,
}: {
  label: string;
  count: number;
  widthPct: number;
  descriptor: string | null;
  color: string;
  testId?: string;
}) {
  return (
    <div data-testid={testId}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground text-sm">{label}</span>
        <span className="text-sm">
          <span className="text-foreground font-medium tabular-nums">
            {count.toLocaleString()}
          </span>
          {descriptor ? (
            <span className="text-muted-foreground"> · {descriptor}</span>
          ) : null}
        </span>
      </div>
      <div className="bg-muted h-3.5 w-full overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${Math.max(count > 0 ? 2 : 0, widthPct)}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

/** The per-business conversion funnel hero. Each stage is a horizontal bar whose
 *  width is its share of the top stage ("Called"), with the count and the
 *  step-over-step conversion to its right. The chain ends at "Decision-makers
 *  reached"; goals met follows as a separate green "Outcome" block (see
 *  FunnelOutcome for why it isn't a funnel step). Plain divs — no charting
 *  dependency. Stage counts come from buildLeadFunnel (distinct leads), so the
 *  bars narrow cleanly. */
export function AnalyticsFunnel({
  steps,
  outcome,
}: {
  steps: FunnelStep[];
  outcome: FunnelOutcome;
}) {
  const top = steps[0]?.count ?? 0;
  const last = steps[steps.length - 1]?.count ?? 0;
  const overallPct = top === 0 ? 0 : (last / top) * 100;
  // The decision-maker share of goals met — a TRUE subset (goals-with-DM ⊆
  // goals), so it's an honest narrowing bar within the Outcome block.
  const withDmPct =
    outcome.goalMet === 0 ? 0 : (outcome.goalMetWithDm / outcome.goalMet) * 100;
  return (
    <section
      data-testid="analytics-funnel"
      className="border-border bg-card rounded-2xl border p-6 shadow-sm"
    >
      <div className="mb-5 flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-base font-medium">
          Conversion funnel
        </h2>
        <p className="text-muted-foreground text-xs tabular-nums">
          per business · {overallPct.toFixed(1)}% dial → decision-maker
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
          return (
            <Bar
              key={s.label}
              label={s.label}
              count={s.count}
              widthPct={widthPct}
              descriptor={
                stepPct != null && prev
                  ? `${stepPct}% of ${prev.label.toLowerCase()}`
                  : null
              }
              color="var(--primary)"
            />
          );
        })}
      </div>

      {/* Outcome — goals met, on its own baseline and in green so it reads as the
       *  payoff, not another narrowing funnel stage. */}
      <div className="border-border my-5 border-t" />
      <div className="mb-4">
        <p
          className="text-sm font-semibold"
          style={{ color: "var(--success)" }}
        >
          Outcome
        </p>
        <p className="text-muted-foreground mt-1 max-w-md text-xs leading-relaxed">
          Goals met — not a funnel stage. A goal can be met without reaching the
          decision-maker, so it isn&apos;t a subset of the bar above.
        </p>
      </div>
      <div className="flex flex-col gap-4">
        <Bar
          label="Goals met"
          count={outcome.goalMet}
          widthPct={outcome.goalMet > 0 ? 100 : 0}
          descriptor={`${Math.round(outcome.goalRateOfConversations * 100)}% of conversations`}
          color="var(--success)"
          testId="funnel-goals-met"
        />
        <Bar
          label="…with a decision-maker"
          count={outcome.goalMetWithDm}
          widthPct={withDmPct}
          descriptor={`${Math.round(withDmPct)}% of goals met`}
          color="var(--success)"
          testId="funnel-goals-met-dm"
        />
      </div>
    </section>
  );
}
