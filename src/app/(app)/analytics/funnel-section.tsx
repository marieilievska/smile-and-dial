import type { EconomicsStep } from "@/lib/analytics/list-economics";
import { MIN_LEAK_SAMPLE, worstDrop } from "@/lib/analytics/stats";
import { SALES_WINDOW_DAYS } from "@/lib/cohorts/math";
import { formatUsd } from "@/lib/format-usd";

function count(n: number): string {
  return n.toLocaleString();
}

/** A rate, or an em dash when the denominator makes it meaningless. */
function pct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

/** Money per outcome, or an em dash. `costPer` already returns null for a zero
 *  denominator — and, in this app, for zero SPEND too, because no cost rows
 *  landed does not mean the calls were free. */
function money(value: number | null): string {
  return value === null ? "—" : formatUsd(value);
}

/** Enough bar to see. A 6% step is a two-pixel sliver at these widths, and a
 *  step that kept almost nothing must still read as "something got through" —
 *  which is a different fact from "nothing did". Zero keeps an empty track. */
const MIN_BAR_PCT = 1.2;

/** One column template, shared by the header row and every step row so the two
 *  cannot drift apart: step · kept · trend · count · cost. */
const CHAIN_COLS =
  "grid grid-cols-[minmax(8rem,1.4fr)_minmax(4rem,2fr)_3.5rem_4rem_5.5rem] items-center gap-x-3";

/**
 * How wide to draw a step's bar, 0–100.
 *
 * The bar encodes CONVERSION, not count. A count-proportional chain running
 * 7,518 down to 0 makes every row below the second a hairline, which is
 * precisely where the interesting numbers are; drawing what each step KEPT
 * makes a 6% step visibly short beside its 42% and 100% neighbours, and that
 * shape is the whole point of the panel.
 *
 * Clamped to the track. `kept` above 1 is not supposed to happen, but the two
 * plain steps whose denominators are separate counts (a business can meet its
 * goal without the decision-maker) could produce one, and a bar overflowing its
 * rail would look like a rendering bug rather than the datum it is. Only the
 * WIDTH is clamped — the printed percentage stays whatever it really was.
 */
function barWidth(kept: number | null, isFirst: boolean): number {
  // The first step is the baseline everything below it is measured against,
  // so it is full width by definition rather than by division.
  if (isFirst) return 100;
  if (kept === null || !Number.isFinite(kept) || kept <= 0) return 0;
  return Math.max(MIN_BAR_PCT, Math.min(1, kept) * 100);
}

/**
 * The whole chain, from a dialled business to a sale — conversion, cost and
 * trend on every step.
 *
 * ONE funnel. This page carried two: a call-level one ending at
 * decision-makers reached, and an economics one starting at businesses dialled.
 * They read different date windows, named different bottlenecks on the same
 * screen, and between them printed businesses-reached four times and spend
 * three. The second also collapsed Connected → Conversations → Decision-maker
 * into a single hop, hiding the largest drop in the funnel.
 *
 * Purely presentational, and deliberately so. It takes steps that are already
 * built, because the page composes them from TWO aggregates — `analytics_summary`
 * for everything call-level, `list_performance` for the registration outcomes —
 * and the arithmetic that decides what any of it MEANS lives in
 * lib/analytics/list-economics.ts, where it is unit-tested. Nothing below does
 * more than format.
 */
export function FunnelSection({
  steps,
  rangeLabel,
}: {
  steps: readonly EconomicsStep[];
  rangeLabel: string;
}) {
  // The filter is load-bearing. `Sold` is leakEligible: false because a sale
  // ripens over a 7-day window this page cannot see, so a zero there is "not
  // yet", never a leak. Without it the callout hijacks itself the week
  // attendance crosses MIN_LEAK_SAMPLE.
  //
  // `from` and `to` are the same label deliberately: this panel names only the
  // step where the loss happens. buildInsights uses the pair properly.
  const leak = worstDrop(
    steps
      .filter((s) => s.leakEligible)
      .map((s) => ({
        from: s.label,
        to: s.label,
        kept: s.kept,
        sample: s.sample,
      })),
  );

  return (
    <section
      data-testid="funnel-section"
      className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm delay-100 duration-500"
    >
      <div>
        {/* Not "Where the money goes" — /costs already uses that heading for
            its vendor breakdown, and two pages answering different questions
            under one title is how people stop trusting either. */}
        <h2 className="text-foreground text-sm font-semibold">
          From dial to sale
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          Every business {rangeLabel} — what each step keeps, what it costs, and
          how it moved.
        </p>
      </div>

      {/* Scrolls sideways rather than crushing five columns onto a phone —
          the same move the tables below make. */}
      <div className="border-border overflow-x-auto rounded-xl border p-4">
        <div className="flex min-w-[36rem] flex-col gap-3">
          <div
            className={`${CHAIN_COLS} text-muted-foreground text-[10px] font-semibold tracking-[0.12em] uppercase`}
          >
            <span>Step</span>
            <span>Kept from above</span>
            <span className="text-right">Trend</span>
            <span className="text-right">Count</span>
            <span className="text-right">Cost each</span>
          </div>
          {steps.map((step, i) => (
            <StepRow
              key={step.label}
              step={step}
              isFirst={i === 0}
              isLeak={leak !== null && leak.to === step.label}
            />
          ))}
        </div>
      </div>

      {leak ? (
        <p className="border-destructive/30 bg-destructive/5 text-foreground rounded-xl border px-4 py-3 text-xs">
          <span className="text-destructive font-semibold">
            ▲ {leak.to} is the leak.
          </span>{" "}
          {pct(leak.drop)} of everything that reaches this step is lost there —
          more than at any other step in the chain. It is the cheapest place to
          win, because every step below it is only ever a share of what got
          through here.
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        <strong>Conversations</strong> are the calls where somebody talked to us
        for more than a minute — a pickup that lasted four seconds is a connect,
        not a conversation. <strong>Attended</strong> is measured against{" "}
        <strong>settled</strong> registrations, the ones whose session has
        already happened: somebody booked for next week has not missed anything,
        and counting them as a no-show makes the show rate look far worse than
        it is. Its cost is <strong>projected</strong> for the same reason — cost
        per registration divided by the settled show rate, rather than
        today&apos;s spend divided by an attendance those sessions have not
        produced yet. A step with fewer than {MIN_LEAK_SAMPLE} cases behind it
        is never named as the bottleneck, because a handful of calls can produce
        any percentage you like. <strong>Sold</strong> is never named as the
        leak either: a sale takes roughly {SALES_WINDOW_DAYS} days after the
        session to land, so a low number there usually means <em>not yet</em>{" "}
        rather than <em>lost</em>.
      </p>
    </section>
  );
}

/** One link in the chain: what it is, how much of the step above it kept, which
 *  way that moved, how many that leaves, and what one of them costs. */
function StepRow({
  step,
  isFirst,
  isLeak,
}: {
  step: EconomicsStep;
  isFirst: boolean;
  isLeak: boolean;
}) {
  return (
    <div
      className={CHAIN_COLS}
      data-testid="funnel-step"
      data-step={step.label}
    >
      <div className="flex flex-col gap-0.5">
        <span
          className={`text-sm ${isLeak ? "text-destructive font-medium" : "text-foreground"}`}
        >
          {isLeak ? "▲ " : ""}
          {step.label}
        </span>
        <SubLine step={step} />
      </div>

      <div className="flex items-center gap-2">
        <div className="bg-muted h-2.5 w-full overflow-hidden rounded-full">
          <div
            className={`h-full rounded-full ${isLeak ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${barWidth(step.kept, isFirst)}%` }}
          />
        </div>
        <span
          className={`w-12 shrink-0 text-right text-xs tabular-nums ${
            isLeak ? "text-destructive font-medium" : "text-muted-foreground"
          }`}
        >
          {/* Nothing for the baseline row: it is 100% by definition, and an
              em dash there would read as "unknown". */}
          {isFirst ? "" : pct(step.kept)}
        </span>
      </div>

      <DeltaCell value={step.delta} />

      <span className="text-foreground text-right text-sm font-medium tabular-nums">
        {count(step.count)}
      </span>

      <CostCell step={step} />
    </div>
  );
}

/**
 * The one line of context a step is allowed under its label.
 *
 * The wording lives here, not in the arithmetic module, so it can be restyled
 * without touching maths — and because `toLocaleString()` is locale-dependent
 * and has no business inside a pure function. `subset` wins where a step has
 * both; today none does.
 */
function SubLine({ step }: { step: EconomicsStep }) {
  if (step.subset !== null) {
    return (
      <span className="text-muted-foreground text-[11px]">
        {count(step.subset.count)} {step.subset.noun}
      </span>
    );
  }
  // Note these two numbers do NOT add up to the step above: a registration
  // with no session time on it falls out of both buckets.
  if (step.pending !== null && (step.sample > 0 || step.pending > 0)) {
    return (
      <span className="text-muted-foreground text-[11px]">
        of {count(step.sample)} settled · {count(step.pending)} pending
      </span>
    );
  }
  return null;
}

/**
 * How this step's conversion moved against the prior window.
 *
 * Deliberately NOT tinted green or red. A rising voicemail rate is not good
 * news and a falling one is not bad, the chain contains steps of both kinds,
 * and nothing else on this page claims a direction — so an arrow that coloured
 * itself would be asserting a judgement the number cannot support.
 *
 * Blank rather than an em dash when there is no prior: every economics step is
 * blank here, and eight dashes down one column reads as broken rather than as
 * "not applicable".
 */
function DeltaCell({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <span aria-hidden="true" />;
  }
  const points = value * 100;
  // A change that rounds away to nothing gets no arrow: "▲ 0%" claims a
  // direction the number does not have.
  const flat = Math.abs(points) < 0.5;
  return (
    <span className="text-muted-foreground text-right text-xs tabular-nums">
      {flat
        ? "0%"
        : `${points > 0 ? "▲" : "▼"} ${Math.abs(points).toFixed(0)}%`}
    </span>
  );
}

/**
 * What one of these costs, weighted by how much the reader should trust it.
 *
 * A projection is only dangerous when its sample is invisible, so a thin one
 * is muted and carries the sample it was built on; a sample too thin to say
 * anything at all renders no number rather than a quiet lie.
 */
function CostCell({ step }: { step: EconomicsStep }) {
  if (step.confidence === "hidden") {
    return (
      <span className="text-muted-foreground text-right text-sm tabular-nums">
        —
      </span>
    );
  }

  const low = step.confidence === "low";
  // A caveat under an em dash qualifies nothing, so the sub-line only appears
  // when there is a number for it to qualify.
  const note =
    step.costEach === null
      ? null
      : low
        ? `proj · from ${count(step.sample)}`
        : step.projected
          ? "proj"
          : null;

  return (
    <span className="flex flex-col items-end gap-0.5">
      <span
        className={`text-right text-sm tabular-nums ${
          low ? "text-muted-foreground" : "text-foreground font-medium"
        }`}
      >
        {money(step.costEach)}
      </span>
      {note ? (
        <span className="text-muted-foreground text-[11px]">{note}</span>
      ) : null}
    </span>
  );
}
