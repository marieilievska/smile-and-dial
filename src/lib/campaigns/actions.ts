"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

export type CampaignResult = { error: string | null; campaignId?: string };

const CAMPAIGNS_PATH = "/campaigns";

/** Confirm the caller is signed in. RLS handles owner-or-admin scoping. */
async function requireAuth(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string | null;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: null, error: "You are not signed in." };
  return { supabase, userId: user.id, error: null };
}

export type CampaignInput = {
  name: string;
  description: string;
  agentId: string;
  goalId: string;
  dailySpendCap: string;
  monthlySpendCap: string;
};

function parseSpendCap(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Create a campaign. */
export async function createCampaign(
  input: CampaignInput,
): Promise<CampaignResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the campaign a name." };
  if (!input.agentId) return { error: "Pick an agent." };
  if (!input.goalId) return { error: "Pick a goal." };

  const { supabase, userId, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { data: created, error } = await supabase
    .from("campaigns")
    .insert({
      owner_id: userId!,
      name,
      description: input.description.trim() || null,
      agent_id: input.agentId,
      goal_id: input.goalId,
      daily_spend_cap: parseSpendCap(input.dailySpendCap),
      monthly_spend_cap: parseSpendCap(input.monthlySpendCap),
    })
    .select("id")
    .single();
  if (error || !created) return { error: "Could not create the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: created.id };
}

/** Update an existing campaign. */
export async function updateCampaign(
  id: string,
  input: CampaignInput,
): Promise<CampaignResult> {
  const name = input.name.trim();
  if (!name) return { error: "Give the campaign a name." };
  if (!input.agentId) return { error: "Pick an agent." };
  if (!input.goalId) return { error: "Pick a goal." };

  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase
    .from("campaigns")
    .update({
      name,
      description: input.description.trim() || null,
      agent_id: input.agentId,
      goal_id: input.goalId,
      daily_spend_cap: parseSpendCap(input.dailySpendCap),
      monthly_spend_cap: parseSpendCap(input.monthlySpendCap),
    })
    .eq("id", id);
  if (error) return { error: "Could not update the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}

/**
 * Delete a campaign. Pause / Resume / End lifecycle actions arrive in
 * Step 18b; for now delete is the only removal mechanism.
 */
export async function deleteCampaign(id: string): Promise<CampaignResult> {
  const { supabase, error: authError } = await requireAuth();
  if (authError) return { error: authError };

  const { error } = await supabase.from("campaigns").delete().eq("id", id);
  if (error) return { error: "Could not delete the campaign." };

  revalidatePath(CAMPAIGNS_PATH);
  return { error: null, campaignId: id };
}
