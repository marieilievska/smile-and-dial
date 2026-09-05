/** Pure cohort arithmetic. No `server-only`, no fetches — every rule that
 *  decides what a number MEANS lives here so it can be tested directly, in the
 *  same spirit as classify-outcome.ts and calendly/booking.ts. */

/** A day is judgeable once its last session is this many days past. The sales
 *  window the operator chose: most deals close within a week of the webinar. */
export const SALES_WINDOW_DAYS = 7;

/** Below these, a rate is reported as unknown rather than printed off a handful
 *  of people — the spirit of the best-time heatmap's 8-sample threshold. Kept
 *  as named constants so they can be tuned without hunting through the query. */
export const MIN_SHOW_SAMPLE = 10;
export const MIN_CLOSE_SAMPLE = 5;

/**
 * Spend per outcome, or null when the ratio would be meaningless.
 *
 * Returning null rather than Infinity matters: a day with real spend and zero
 * attendees is the NORMAL state of a cohort that has not ripened, and it must
 * render as "—" rather than as an alarming number.
 */
export function costPer(spend: number, outcomes: number): number | null {
  if (!Number.isFinite(spend) || spend <= 0) return null;
  if (!Number.isFinite(outcomes) || outcomes <= 0) return null;
  return spend / outcomes;
}

/**
 * Whether a dial day's row has stopped changing and can be judged.
 *
 * Requires both that nothing is still pending AND that the last session is past
 * the sales window — a session can be over while the sale it produces is not.
 */
export function isRipe(
  lastSessionIso: string | null,
  pending: number,
  now: Date = new Date(),
): boolean {
  if (!lastSessionIso) return false;
  if (pending > 0) return false;
  const last = new Date(lastSessionIso).getTime();
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > SALES_WINDOW_DAYS * 86_400_000;
}

export type RateInput = {
  attended: number;
  no_show: number;
  sales: number;
};

export type Rates = {
  showRate: number | null;
  closeRate: number | null;
};

/**
 * Show and close rates over a set of cohort rows.
 *
 * The show-rate denominator is only RECONCILED registrations (attended +
 * no-show). Anyone whose session has not happened yet is not a miss and must
 * not drag the rate down — that error is what makes naive funnel dashboards
 * look like they are collapsing every time volume goes up.
 */
export function rollingRates(rows: readonly RateInput[]): Rates {
  const attended = rows.reduce((n, r) => n + r.attended, 0);
  const noShow = rows.reduce((n, r) => n + r.no_show, 0);
  const sales = rows.reduce((n, r) => n + r.sales, 0);
  const reconciled = attended + noShow;
  return {
    showRate: reconciled >= MIN_SHOW_SAMPLE ? attended / reconciled : null,
    closeRate: attended >= MIN_CLOSE_SAMPLE ? sales / attended : null,
  };
}

/**
 * What a sale should cost, given today's cost per registration and how the
 * funnel has been converting.
 *
 * This is the number that can be steered by TODAY. Cost per registration is
 * knowable the same day; cost per sale is not knowable for a week or more. So
 * the projection carries the daily signal, and ripe cohorts check it.
 */
export function projectedCostPerSale(
  costPerRegistration: number | null,
  showRate: number | null,
  closeRate: number | null,
): number | null {
  if (costPerRegistration === null || costPerRegistration <= 0) return null;
  if (showRate === null || showRate <= 0) return null;
  if (closeRate === null || closeRate <= 0) return null;
  return costPerRegistration / (showRate * closeRate);
}
