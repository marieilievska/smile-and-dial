"use server";

import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
import type { Json } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

export type AudienceCountResult = {
  count: number | null;
  error: string | null;
};

/**
 * Count how many of the campaign owner's leads a company-name audience filter
 * would target. Powers the live "matches N leads" preview in campaign settings.
 *
 * The dialer matches a campaign's audience against the campaign OWNER's leads,
 * so resolve that owner from the campaign in edit mode; in create mode the new
 * campaign will be owned by the current user. Counts non-deleted leads whose
 * company name contains the (sanitized) term — the same match the dial_queue
 * view applies, so the preview equals reality.
 */
export async function countAudienceMatches(input: {
  search: string;
  campaignId?: string;
}): Promise<AudienceCountResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { count: null, error: "You are not signed in." };

  const term = sanitizeAudienceSearch(input.search);
  if (!term) return { count: 0, error: null };

  let ownerId = user.id;
  if (input.campaignId) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("owner_id")
      .eq("id", input.campaignId)
      .maybeSingle();
    if (campaign?.owner_id) ownerId = campaign.owner_id;
  }

  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .is("deleted_at", null)
    .ilike("company", `%${term}%`);
  if (error) return { count: null, error: "Could not count matches." };
  return { count: count ?? 0, error: null };
}

/**
 * Count how many leads a smart list's saved filter currently matches. Powers
 * the live "matches N leads" preview when a smart list is picked in campaign
 * settings. Uses the same evaluator as the Leads page so the preview equals
 * what the dialer will see once members refresh.
 *
 * This used to page every matching id into JavaScript and return `ids.length`
 * — 84 round trips for a filter matching most of the table, to produce one
 * integer. Measured on production 2026-09-07:
 *
 *   status is ready_to_call  (83,384 matches)   23,121ms  ->  831ms
 *   created in last 7 days   (84,032 matches)   26,941ms  ->  813ms
 *   connected ever            (3,194 matches)      744ms  ->  532ms
 *
 * A broad filter is the FIRST thing anyone tries, so the preview taking half a
 * minute is most of why this feature has sat unused since June.
 *
 * `leads_matching_filter_rows` returns `setof leads` rather than `setof uuid`,
 * which is what makes this possible: PostgREST can put a table-valued function
 * behind `count=exact` with `head`, so Postgres counts and no rows cross the
 * wire. The scalar `leads_matching_filter` cannot be counted that way. Both are
 * SECURITY INVOKER, so RLS scopes the count to the caller either way.
 */
export async function countSmartListMatches(input: {
  smartListId: string;
}): Promise<AudienceCountResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { count: null, error: "You are not signed in." };

  const { data: sl } = await supabase
    .from("smart_lists")
    .select("filter")
    .eq("id", input.smartListId)
    .maybeSingle();
  if (!sl) return { count: null, error: "Smart list not found." };

  const { count, error } = await supabase.rpc(
    "leads_matching_filter_rows",
    { in_recipe: sl.filter as unknown as Json },
    { count: "exact", head: true },
  );
  if (error) return { count: null, error: "Could not run the filter." };
  return { count: count ?? 0, error: null };
}
