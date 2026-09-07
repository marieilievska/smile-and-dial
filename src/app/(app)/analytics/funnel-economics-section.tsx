import {
  buildEconomicsFunnel,
  type EconomicsStep,
  type EconomicsTotals,
} from "@/lib/analytics/list-economics";
import { MIN_LEAK_SAMPLE, worstDrop } from "@/lib/analytics/stats";
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
 *  cannot drift apart. */
const CHAIN_COLS =
  "grid grid-cols-[minmax(8rem,1.4fr)_minmax(4rem,2.2fr)_4rem_5.5rem] items-center gap-x-3";

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
 * "What does a registration cost me, and where is the money leaking" — the one
 * question this page could not answer.
 *
 * The funnel above ends at decision-makers reached; the per-list table below
 * starts at goals met. Nothing joined them, so the chain from a dialled
 * business to a paying one was split across two panels with no money attached
 * to either. This is that chain, end to end, with the spend divided into it.
 *
 * Every number here comes from `buildEconomicsFunnel`. Nothing on this page
 * decides what a number MEANS — that lives in lib/analytics/list-economics.ts
 * where it can be unit-tested, and this file only decides how it looks.
 */
export function FunnelEconomicsSection({
  totals,
  period,
  rangeLabel,
}: {
  totals: EconomicsTotals;
  period: "all" | "range";
  rangeLabel: string;
}) {
  const steps = buildEconomicsFunnel(totals);

  // Call-level, so it cannot sit in the chain: every percentage down there is
  // a share of BUSINESSES, and one row secretly divided by calls would be
  // indistinguishable from the rest. Computed here rather than in the
  // economics module for the same reason the module leaves it out — it belongs
  // to the header strip. Same shape as the reachability footer next door.
  const voicemailShare =
    totals.calls === 0 ? null : totals.voicemail / totals.calls;

  // The filter is load-bearing. `Sold` is leakEligible: false because a sale
  // ripens over a 7-day window this module cannot see, so a zero there is "not
  // yet", never "we are losing them" — and it arrives with drop = 1.0, the
  // largest a funnel can produce, so it would outrank every genuine leak on
  // the page. Without this filter the callout hijacks itself the week
  // attendance crosses ten and points at the one step whose number means
  // nothing.
  //
  // `from` and `to` are deliberately the SAME label. This panel names only the
  // step where the loss happens rather than a pair, and `leak.to ===
  // step.label` is how the row below gets flagged. `buildInsights` calls the
  // same helper with a genuine from → to pair, which is what the two fields
  // are for; collapsing them is this caller's choice, not a shortcut.
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
    <section className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both border-border bg-card flex flex-col gap-3 rounded-2xl border p-5 shadow-sm delay-200 duration-500">
      <div>
        {/* Not "Where the money goes" — /costs already uses that heading for
            its vendor breakdown, and two pages answering different questions
            under one title is how people stop trusting either. */}
        <h2 className="text-foreground text-sm font-semibold">
          From dial to sale
        </h2>
        <p className="text-muted-foreground mt-1 text-xs">
          {period === "all"
            ? "Everything dialled so far"
            : `Dialling in ${rangeLabel}`}{" "}
          — what each step keeps, and what one of them costs.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Metric label="Calls placed" value={count(totals.calls)} />
        <Metric label="Went to voicemail" value={pct(voicemailShare)} />
        <Metric label="Spend" value={formatUsd(totals.spend)} />
      </div>

      {/* Scrolls sideways rather than crushing four columns onto a phone —
          the same move the tables below make. */}
      <div className="border-border overflow-x-auto rounded-xl border p-4">
        <div className="flex min-w-[32rem] flex-col gap-3">
          <div
            className={`${CHAIN_COLS} text-muted-foreground text-[10px] font-semibold tracking-[0.12em] uppercase`}
          >
            <span>Step</span>
            <span>Kept from above</span>
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
        <strong>Attended</strong> is measured against <strong>settled</strong>{" "}
        registrations — the ones whose session has already happened. Somebody
        booked for next week has not missed anything, and counting them as a
        no-show makes the show rate look far worse than it is. Its cost is{" "}
        <strong>projected</strong> for the same reason: cost per registration
        divided by the show rate, rather than today&apos;s spend divided by an
        attendance those sessions have not produced yet. A step with fewer than{" "}
        {MIN_LEAK_SAMPLE} cases behind it is never named as the bottleneck — a
        handful of calls can produce any percentage you like.
      </p>
    </section>
  );
}

/** One number in the header strip. Call-level and inventory facts that frame
 *  the chain without belonging to it. */
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-muted/40 flex flex-col gap-0.5 rounded-xl border p-3">
      <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="text-foreground text-base font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}

/** One link in the chain: what it is, how much of the step above it kept, how
 *  many that leaves, and what one of them costs. */
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
    <div className={CHAIN_COLS}>
      <div className="flex flex-col gap-0.5">
        <span
          className={`text-sm ${isLeak ? "text-destructive font-medium" : "text-foreground"}`}
        >
          {isLeak ? "▲ " : ""}
          {step.label}
        </span>
        {/* The wording lives here, not in the arithmetic module, so it can be
            restyled without touching maths — and because toLocaleString() is
            locale-dependent and has no business inside a pure function. Note
            these two numbers do NOT add up to the step above: a registration
            with no session time on it falls out of both buckets. */}
        {step.pending !== null && (step.sample > 0 || step.pending > 0) ? (
          <span className="text-muted-foreground text-[11px]">
            of {count(step.sample)} settled · {count(step.pending)} pending
          </span>
        ) : null}
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

      <span className="text-foreground text-right text-sm font-medium tabular-nums">
        {count(step.count)}
      </span>

      <CostCell step={step} />
    </div>
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
