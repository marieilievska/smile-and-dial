import "server-only";

import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type OnboardingStep = {
  key: "leads" | "number" | "agent" | "campaign";
  done: boolean;
  detail: string | null;
};

export type OnboardingProgress = {
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  complete: boolean;
  agentName: string | null;
};

/** Derive first-campaign progress for one user from live data. Order is
 *  load-bearing: Leads → Number → Agent → Campaign. Numbers are a shared
 *  pool, so "number ready" = an unattached pool number exists OR the user
 *  already attached one to a campaign. */
export async function fetchOnboardingProgress(
  supabase: Supabase,
  userId: string,
): Promise<OnboardingProgress> {
  const [
    { count: leadCount },
    { count: freeNumberCount },
    { data: agentRow },
    { count: agentCount },
    { data: campaignRow },
    { count: activeCampaignCount },
    { count: userNumberCount },
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId),
    supabase
      .from("twilio_numbers")
      .select("id", { count: "exact", head: true })
      .is("released_at", null)
      .is("attached_campaign_id", null),
    supabase
      .from("agents")
      .select("name")
      .eq("owner_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId),
    supabase
      .from("campaigns")
      .select("name")
      .eq("owner_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId)
      .eq("status", "active"),
    // A number attached to one of THIS user's campaigns also counts as
    // "number ready" even if the shared pool has no free numbers.
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId)
      .not("twilio_number_id", "is", null),
  ]);

  const leads = (leadCount ?? 0) > 0;
  const number = (freeNumberCount ?? 0) > 0 || (userNumberCount ?? 0) > 0;
  const agent = (agentCount ?? 0) > 0;
  const campaign = (activeCampaignCount ?? 0) > 0;

  const steps: OnboardingStep[] = [
    {
      key: "leads",
      done: leads,
      detail: leads ? `${(leadCount ?? 0).toLocaleString()} imported` : null,
    },
    {
      key: "number",
      done: number,
      detail: number ? "Ready to dial from" : null,
    },
    {
      key: "agent",
      done: agent,
      detail: agent ? (agentRow?.name ?? "Ready") : null,
    },
    {
      key: "campaign",
      done: campaign,
      detail: campaign ? (campaignRow?.name ?? "Live") : null,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return {
    steps,
    doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
    agentName: agentRow?.name ?? null,
  };
}
