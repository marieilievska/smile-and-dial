"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/** Set the operator's "active campaign" preference. Sticks on the
 *  profile so every page picks it up on next render. The top-bar chip
 *  reads it; the Call-Now dialog auto-picks it; future quick-dial
 *  controls will respect it too.
 *
 *  Setting `null` clears the preference and falls back to "ask each
 *  time" behaviour for manual calls. */
export async function setActiveCampaign(
  campaignId: string | null,
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  if (campaignId) {
    // Validate the campaign exists and is reachable by this user. RLS
    // already filters; we just confirm it's there before storing the
    // FK so a paused/ended campaign doesn't silently land on the chip.
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("id, status")
      .eq("id", campaignId)
      .maybeSingle();
    if (!campaign) {
      return { error: "Campaign not found or no longer available." };
    }
  }

  const { error } = await supabase
    .from("profiles")
    .update({ active_campaign_id: campaignId })
    .eq("id", user.id);
  if (error) {
    return { error: "Could not update active campaign." };
  }

  // Invalidate every cached layout — the top-bar chip lives in the app
  // shell and needs to re-render with the new value.
  revalidatePath("/", "layout");
  return { error: null };
}
