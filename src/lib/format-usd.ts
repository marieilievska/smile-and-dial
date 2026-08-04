/**
 * The one place the app formats a USD amount for display.
 *
 * Uses thousands separators + exactly two decimals ($1,234.56) so large totals
 * on Costs / Analytics read cleanly, instead of the old scattered
 * `$${x.toFixed(2)}` which produced `$1234.56`. Non-finite input renders as an
 * em dash so a missing number never shows "$NaN".
 */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
