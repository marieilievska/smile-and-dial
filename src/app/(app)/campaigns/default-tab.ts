import type { CampaignCounts } from "./campaigns-status-tabs";

/** Tab preference when the user has expressed none.
 *
 *  Ordered by how much the tab wants attention: something running, then
 *  something stopped that probably shouldn't be, then unfinished work, then
 *  history. "all" is deliberately absent — it is a real destination the user
 *  can pick, but never one we pick for them, because it mixes ended campaigns
 *  in with live ones. */
export const DEFAULT_TAB_ORDER = [
  "active",
  "paused",
  "draft",
  "ended",
] as const;

/**
 * Resolve which status tab the Campaigns page should open on.
 *
 * "Active" is the right default while a campaign is running, and a poor one
 * the rest of the time: with 0 active and 1 paused campaign the page greeted
 * you with "No campaigns match this status" while holding a campaign — after a
 * multi-second load. A campaign nobody can see is a campaign nobody restarts.
 *
 * `requested` is the validated `?status=` param, or null when the user did not
 * pick a tab. An explicit choice is NEVER second-guessed — including a
 * deliberately empty tab — so the status tabs keep working as plain filters.
 * Falls back to "active" when there are no campaigns at all, which is the
 * empty-workspace case and shows the "create your first campaign" state.
 *
 * Deliberately not a "use client" module: the page is a Server Component and
 * importing a value from a client module into one is a known trap here (#188).
 */
export function resolveCampaignTab(
  requested: string | null,
  counts: CampaignCounts,
): string {
  if (requested) return requested;
  return DEFAULT_TAB_ORDER.find((s) => (counts[s] ?? 0) > 0) ?? "active";
}
