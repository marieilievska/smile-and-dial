"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

/** Set the operator's "active campaign" preference. Sticks on the
 *  profile so every page picks it up on next render. The top-bar chip
 *  reads it; the Call-Now dialog auto-picks it; future quick-dial
 *  controls will respect it too.
 *
 *  Setting `null` clears the preference and falls back to "ask each
 *  time" behaviour for manual calls.
 *
 *  Writes through `update_my_profile` (20260905190000): the profiles
 *  UPDATE policy is admin-only, so a direct update matched zero rows for a
 *  member and reported success. The function touches only the caller's
 *  own row and returns how many rows it changed, which we check. */
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

  const { data: updated, error } = await supabase.rpc("update_my_profile", {
    patch: { active_campaign_id: campaignId },
  });
  if (error || !updated) {
    return { error: "Could not update active campaign." };
  }

  // Invalidate every cached layout — the top-bar chip lives in the app
  // shell and needs to re-render with the new value.
  revalidatePath("/", "layout");
  return { error: null };
}
