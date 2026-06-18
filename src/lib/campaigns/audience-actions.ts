"use server";

import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
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
