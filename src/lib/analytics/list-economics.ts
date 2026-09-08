/** Pure economics arithmetic for the /analytics list panels. No `server-only`,
 *  no fetches -- every rule that decides what a number MEANS lives here so it
 *  can be tested directly, in the same spirit as cohorts/math.ts and
 *  classify-outcome.ts. */

import { costPer, MIN_SHOW_SAMPLE } from "@/lib/cohorts/math";

import type { ListPerformanceRow } from "./list-performance";

/** Below three settled registrations there is no rate worth printing: one
 *  person attending is not a show rate. Between this and MIN_SHOW_SAMPLE the
 *  projection is shown but visibly de-emphasised and carries its sample size,
 *  because a projection is only dangerous when its sample is invisible. */
export const MIN_PROJECTION_SAMPLE = 3;

/** How much weight the reader should give a projected number. */
export type Confidence = "hidden" | "low" | "normal";

/** The panel's data contract, not the funnel's. Structurally a
 *  `ListPerformanceRow` minus the identity columns, so both a single row and
 *  `totalsFor(...)` satisfy it.
 *
 *  Four of these sixteen — `leads`, `calls`, `connected` and `voicemail` — are
 *  read by no function in this file. They are CALL- and inventory-level, and
 *  belong to the header strip above the funnel; `buildEconomicsFunnel` stays
 *  business-level on purpose. They are here so the panel needs one type rather
 *  than two, not because the arithmetic below wants them. */
export type EconomicsTotals = Pick<
  ListPerformanceRow,
  | "leads"
  | "worked"
  | "calls"
  | "connected"
  | "reached"
  | "voicemail"
  | "dms"
  | "goals"
  | "regs"
  | "attended"
  | "no_show"
  | "pending"
  | "sales"
  | "spend"
  | "remaining"
  | "worked_7d"
>;

/** Just enough to decide how many registrations have resolved. Declared
 *  structurally rather than as a Pick<> so BOTH a per-list row and the funnel's
 *  own input satisfy it -- the list table and the funnel must agree about what
 *  "settled" means, and the cheapest way to guarantee that is one function. */
export type SettledInput = {
  attended: number;
  no_show: number;
  regs: number;
};

/** Settled, plus the spend needed to price an attendee. */
export type AttendedCostInput = SettledInput & { spend: number };

/**
 * Registrations whose session has actually resolved.
 *
 * The ONLY valid denominator for a show rate. `regs` includes people whose
 * webinar has not happened yet: on 2026-09-07 that was 12 of 20, so
 * `attended / regs` read 20% where the truth was 50%.
 *
 * Clamped to `regs` on purpose. `attended` counts `attended_at is not null`
 * with no cancellation guard, while `regs` excludes cancelled rows -- so a
 * registration marked attended and cancelled afterwards is in one and not the
 * other, and the raw sum can exceed the whole. That asymmetry is inherited
 * from `cohort_rows` and deliberately not diverged from, because the two
 * functions agreeing matters more; the clamp belongs here, in the consumer.
 * Without it the panel renders a show rate above 100%.
 */
export function settledCount(t: SettledInput): number {
  return Math.min(t.attended + t.no_show, t.regs);
}

/** Attendance over settled registrations, or null while nothing has settled --
 *  which must not render as "nobody came". */
export function showRate(t: SettledInput): number | null {
  const settled = settledCount(t);
  if (settled <= 0) return null;
  return Math.min(t.attended / settled, 1);
}

/**
 * What an attendee costs, projected through the show rate.
 *
 * The same move `projectedCostPerSale` makes one step further along, and for
 * the same reason: cost per registration is knowable the same day, cost per
 * attendee is not knowable until the session happens. Dividing spend by
 * attendance instead charges today's money against a session that has not run.
 */
export function projectedCostPerAttended(
  costPerRegistration: number | null,
  rate: number | null,
): number | null {
  if (costPerRegistration === null || !Number.isFinite(costPerRegistration)) {
    return null;
  }
  if (costPerRegistration <= 0) return null;
  if (rate === null || !Number.isFinite(rate) || rate <= 0) return null;
  return costPerRegistration / rate;
}

/**
 * What an attendee costs this list, end to end.
 *
 * The composition every consumer needs: spend over registrations, then divided
 * by the SETTLED show rate. It lives here rather than in a view because it is
 * two guards deep -- `costPer` refuses a zero spend, `showRate` refuses an
 * unsettled cohort -- and a caller that composed it by hand could get either
 * one wrong without the number looking wrong.
 *
 * One definition, three callers: the funnel's Attended step, a table row, and
 * that table's footer. They cannot disagree about the same number because
 * there is only one of it.
 */
export function costPerAttended(t: AttendedCostInput): number | null {
  return projectedCostPerAttended(costPer(t.spend, t.regs), showRate(t));
}

/**
 * How much to trust a projection built on `settled` cases.
 *
 * `MIN_SHOW_SAMPLE` is imported, never redefined: if ten is ever the wrong
 * floor, /analytics and the Cohorts tab have to move together or they will
 * quietly start disagreeing.
 */
export function projectionConfidence(settled: number): Confidence {
  if (settled < MIN_PROJECTION_SAMPLE) return "hidden";
  if (settled < MIN_SHOW_SAMPLE) return "low";
  return "normal";
}

/**
 * How many days of dialling are left in a list at the recent pace.
 *
 * PRECONDITION: `firstCall` must be `first_dial` -- the UNFILTERED first
 * outbound dial -- and never `first_call`. The two columns are one character
 * apart and mean different things: `first_call` is activity and follows the
 * date pills and the campaign filter, so feeding it here makes this number a
 * property of what you are looking at rather than of the list. Traced on
 * 2026-09-07: with the Today pill, `first_call` was that morning, `ageDays`
 * came out at ~0.1, `paceDays` floored to 1, and a list with 56 days left
 * rendered 11. Two clicks, a fivefold swing. `first_dial` follows neither
 * filter, exactly like `remaining` and `worked_7d`, so all three inputs move
 * together or not at all.
 *
 * The `min(7, age)` guard matters. Dialling on this workspace began five days
 * before this was written; dividing a five-day total by a flat seven days
 * understates pace by 29% and turns a true 56 days into a claimed 78. The
 * guard retires itself once a list is more than a week old. The `max(1, ...)`
 * floor is the other side of it: a list first dialled twelve hours ago would
 * otherwise divide a week's work by half a day and claim a pace it has never
 * sustained.
 *
 * Null -- an em dash on screen -- when nothing has been dialled this week, so
 * an idle list never renders as Infinity. The Inbound list is exactly this
 * case: its calls are all inbound, so `worked_7d` is zero and `first_dial` is
 * null.
 *
 * Rounds UP. Zero is reserved for "nothing left"; rounding to nearest would
 * hand the same 0 to a list with 300 leads still in it, which reads as
 * finished at exactly the moment somebody is watching the column.
 */
export function daysLeft(
  t: EconomicsTotals,
  firstCall: string | null,
  now: Date = new Date(),
): number | null {
  if (t.worked_7d <= 0) return null;
  if (t.remaining <= 0) return 0;
  if (!firstCall) return null;
  const started = new Date(firstCall).getTime();
  if (Number.isNaN(started)) return null;
  const ageDays = (now.getTime() - started) / 86_400_000;
  // Quantised to whole days so the column holds still. Dividing by a
  // continuously growing age made this creep upward hour by hour on a list
  // younger than a week — 51 at midnight, 61 by the evening, with nothing
  // having actually changed. A number that moves while you watch it stops
  // being believed. Across days it still moves, and should: pausing the
  // dialler genuinely does lengthen how long the list will take.
  const paceDays = Math.max(1, Math.min(7, Math.round(ageDays)));
  const pace = t.worked_7d / paceDays;
  if (!Number.isFinite(pace) || pace <= 0) return null;
  return Math.ceil(t.remaining / pace);
}

/** Everything the merged chain needs, and where each half comes from.
 *
 *  The split matters. The four call-level counts come from `analytics_summary`,
 *  which follows the date pills. The registration outcomes come from
 *  `list_performance` -- which MUST be fetched over the same window, not over
 *  the list table's All-time toggle. Mixing the two is what let the old pair of
 *  funnels read different periods while looking like one story. */
export type FunnelInput = {
  /** Distinct businesses called -- analytics_summary.funnel_called. */
  called: number;
  /** Raw calls placed. Not a funnel step -- the chain is business-level -- but
   *  shown against `called` so the redial ratio is readable. */
  calls: number;
  connected: number;
  /** Talked more than a minute -- the step the economics panel collapsed away,
   *  and where the largest single drop actually is. */
  conversations: number;
  dms: number;
  goals: number;
  /** Of those goals, how many reached a decision-maker. Rendered as a subset
   *  line, which is what the old funnel's separate Outcome block was for. */
  goalsWithDm: number;
  spend: number;
  regs: number;
  attended: number;
  no_show: number;
  pending: number;
  sales: number;
};

/** The prior window's chain. Only the four call-level stages exist -- the page
 *  computes a prior `analytics_summary` but not a prior `list_performance`, so
 *  the economics steps have nothing to compare against and get no delta. */
export type PriorChain = {
  called: number;
  connected: number;
  conversations: number;
  dms: number;
};

/** One row of the "Where the money goes" chain. */
export type EconomicsStep = {
  label: string;
  count: number;
  /** Share kept from the step above; null on the first step and wherever the
   *  denominator is zero. */
  kept: number | null;
  /** The denominator `kept` was computed over -- not always the previous
   *  step's count, which is the entire point of the Attended row. */
  sample: number;
  /** Spend per one of these; null when the ratio would be meaningless. */
  costEach: number | null;
  /** True when `costEach` is projected rather than divided. */
  projected: boolean;
  confidence: Confidence;
  /** Registrations on this step whose session has not happened or not
   *  reconciled, or null where "pending" means nothing -- which is every step
   *  but Attended. A COUNT, not a sentence: the wording belongs to the view,
   *  and this module's sibling `cohorts/math.ts` contains no strings at all.
   *
   *  Do NOT render it as though `sample + pending` reconciled to the step
   *  above. `calendly_events.scheduled_at` is nullable, and a non-cancelled,
   *  unattended row with a null one falls out of both buckets -- the migration
   *  spells this out. The two numbers are each true and do not add up. */
  pending: number | null;
  /** Whether this step may be named as the funnel's bottleneck.
   *
   *  False for Sold. A sale ripens over SALES_WINDOW_DAYS after the session,
   *  and this module has no way to know how many of these attendees are still
   *  inside that window -- so a zero here is "not yet", never "we are losing
   *  them". Without this the callout hijacks itself the week attendance
   *  crosses MIN_LEAK_SAMPLE with sales still ripening, and points at the one
   *  step whose number means nothing. */
  leakEligible: boolean;
  /** How this step's conversion moved against the prior window, as a signed
   *  proportion. Null where there is no prior figure -- which is every
   *  economics step, and all of them when ?compare=0. */
  delta: number | null;
  /** A meaningful sub-count of this step, with the word that explains it, or
   *  null. Two steps have one:
   *
   *    Called    the raw CALL count. Businesses get redialled, so calls exceed
   *              businesses (8,156 against 7,518 today) -- and dropping the
   *              panel's old metric strip would otherwise take the only total
   *              call count off the page.
   *    Goal met  how many of those goals reached a decision-maker. This is
   *              what the old funnel's separate "Outcome" block was for.
   *
   *  `noun` is a fixed domain word, never a formatted string -- the count stays
   *  a number so the view owns `toLocaleString` and its locale. */
  subset: { count: number; noun: string } | null;
};

/**
 * A share, or null when the denominator makes one meaningless.
 *
 * Contract, and note where it DIFFERS from `costPer` next door: a zero
 * numerator here is a real answer -- 0 of 8 attendees bought is a 0% close
 * rate, and hiding it would hide the finding. `costPer(0, 5)` is null instead,
 * because in this app a zero SPEND does not mean "free", it means no cost rows
 * landed against these calls; the RPC's own Unattributed row hardcodes zero
 * spend while carrying real registrations, so "—" is the honest render there
 * and "$0.00 per registration" would be a lie. Same shape, opposite treatment
 * of zero, and on the Sold row a reader sees both at once: `kept` 0 beside
 * `costEach` null.
 *
 * Null only for a denominator that is zero or negative, or a ratio that comes
 * out non-finite -- `worstDrop` skips a non-finite `kept`, and this is where
 * that guarantee is made.
 */
function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

/** Change from `before` to `now`, or null when the comparison is meaningless.
 *  Null rather than Infinity for a zero baseline: "up from nothing" is not a
 *  percentage, and rendering one invites a decision off a number that is not
 *  there. */
function delta(now: number | null, before: number | null): number | null {
  if (now === null || before === null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(before)) return null;
  if (before <= 0) return null;
  return (now - before) / before;
}

/**
 * The whole chain, from a dialled business to a sale, with money and trend on
 * every step.
 *
 * One funnel, deliberately. This page used to carry two -- a call-level one
 * ending at decision-makers and an economics one starting at businesses
 * dialled -- which read different date windows and named different bottlenecks
 * on the same screen. The second one also collapsed Connected -> Conversations
 * -> Decision-maker into a single hop, which hid the largest drop in the funnel
 * and made the callout point at the wrong step with full confidence.
 *
 * Calls and voicemail are still absent as STEPS: they are call-level and this
 * chain is business-level, and mixing the two leaves rows whose denominators
 * differ with nothing on screen saying so. The call count rides along as the
 * first step's subset instead.
 */
export function buildEconomicsFunnel(
  t: FunnelInput,
  prior: PriorChain | null = null,
): readonly EconomicsStep[] {
  const priorRate = (n: number, d: number): number | null =>
    prior === null || d <= 0 ? null : n / d;

  const plain = (
    label: string,
    countNow: number,
    prev: number | null,
    priorNow: number | null,
    priorPrev: number | null,
    // A zero sub-count is not worth a line: "0 calls placed" under a step that
    // is itself zero says nothing.
    subset: { count: number; noun: string } | null = null,
  ): EconomicsStep => ({
    label,
    count: countNow,
    kept: prev === null ? null : rate(countNow, prev),
    sample: prev ?? 0,
    costEach: costPer(t.spend, countNow),
    projected: false,
    confidence: "normal",
    pending: null,
    leakEligible: true,
    delta:
      prev === null || priorNow === null || priorPrev === null
        ? null
        : delta(rate(countNow, prev), priorRate(priorNow, priorPrev)),
    subset: subset && subset.count > 0 ? subset : null,
  });

  const settled = settledCount(t);
  const rateOfShow = showRate(t);

  return [
    plain("Called", t.called, null, null, null, {
      count: t.calls,
      noun: "calls placed",
    }),
    plain(
      "Connected",
      t.connected,
      t.called,
      prior?.connected ?? null,
      prior?.called ?? null,
    ),
    plain(
      "Conversations",
      t.conversations,
      t.connected,
      prior?.conversations ?? null,
      prior?.connected ?? null,
    ),
    plain(
      "Decision-maker",
      t.dms,
      t.conversations,
      prior?.dms ?? null,
      prior?.conversations ?? null,
    ),
    plain("Goal met", t.goals, t.dms, null, null, {
      count: t.goalsWithDm,
      noun: "with a decision-maker",
    }),
    plain("Registered", t.regs, t.goals, null, null),
    {
      label: "Attended",
      count: t.attended,
      // Against SETTLED registrations. Anyone whose session has not happened
      // is not a miss, and must not drag the rate down.
      kept: rateOfShow,
      sample: settled,
      costEach: costPerAttended(t),
      projected: true,
      confidence: projectionConfidence(settled),
      pending: t.pending,
      leakEligible: true,
      delta: null,
      subset: null,
    },
    {
      label: "Sold",
      count: t.sales,
      kept: rate(t.sales, t.attended),
      sample: t.attended,
      costEach: costPer(t.spend, t.sales),
      projected: false,
      confidence: "normal",
      pending: null,
      // A sale ripens over SALES_WINDOW_DAYS after the session, and this module
      // cannot know how many of these attendees are still inside that window.
      // So a zero here is "not yet", never "we are losing them".
      leakEligible: false,
      delta: null,
      subset: null,
    },
  ];
}
