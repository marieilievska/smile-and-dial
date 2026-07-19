"use server";

import { revalidatePath } from "next/cache";

import { areaCodeOf } from "@/lib/dialer/number-pool";
import { buildPoolPlan, type AreaCodePlan } from "@/lib/dialer/pool-plan";
import { createClient } from "@/lib/supabase/server";
import {
  assignAgentToNumber,
  ensureNumberImportedToElevenLabs,
} from "@/lib/twilio/place-call";

import {
  pointNumberWebhooks,
  purchaseTwilioNumber,
  searchAvailableNumbers,
} from "./numbers";

/**
 * Server actions for a campaign's NUMBER POOL (Phase 3 provisioning). Buy numbers
 * straight into a campaign's pool (with ElevenLabs import + inbound agent
 * assignment), manage each number's pool state (retire / rest / flag), and
 * suggest an area-code buying plan from the campaign's lead geography. All
 * admin-gated, mirroring src/lib/twilio/number-actions.ts.
 */

type ActionResult = { error: string | null };

const NUMBERS_PATH = "/settings/twilio-numbers";
const CAMPAIGNS_PATH = "/campaigns";
/** Cap a single buy batch so a fat-fingered count can't drain the Twilio account. */
const MAX_BATCH = 25;

async function requireAdmin(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { supabase, error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return { supabase, error: "Only admins can manage the number pool." };
  }
  return { supabase, error: null };
}

/**
 * Buy up to `count` numbers in `areaCode` straight into a campaign's pool:
 * purchase at Twilio, point webhooks at ElevenLabs' native inbound, record the
 * row (attached to the campaign, area code stamped, warm-up starting now), import
 * into ElevenLabs for outbound, and assign the campaign's agent so the number
 * also answers inbound. Best-effort PER NUMBER — one failure never aborts the
 * batch. Returns how many landed vs failed.
 */
export async function addNumbersToPool(input: {
  campaignId: string;
  areaCode: string;
  count: number;
}): Promise<{ bought: number; failed: number; error: string | null }> {
  const { supabase, error: adminError } = await requireAdmin();
  if (adminError) return { bought: 0, failed: 0, error: adminError };

  const count = Math.max(1, Math.min(MAX_BATCH, Math.floor(input.count || 0)));
  const areaCode = input.areaCode.replace(/\D/g, "").slice(0, 3);
  if (areaCode.length !== 3) {
    return { bought: 0, failed: 0, error: "Enter a 3-digit area code." };
  }

  // Campaign + its ElevenLabs agent (for the inbound assignment).
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, agent:agents(elevenlabs_agent_id)")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return { bought: 0, failed: 0, error: "Campaign not found." };
  const agentElId =
    (campaign.agent as { elevenlabs_agent_id: string | null } | null)
      ?.elevenlabs_agent_id ?? null;

  const { numbers, error: searchErr } = await searchAvailableNumbers(
    "US",
    areaCode,
  );
  if (searchErr) return { bought: 0, failed: 0, error: searchErr };
  const toBuy = numbers.slice(0, count);
  if (toBuy.length === 0) {
    return {
      bought: 0,
      failed: 0,
      error: `No numbers available in area code ${areaCode}.`,
    };
  }

  let bought = 0;
  let failed = 0;
  for (const n of toBuy) {
    const { twilioSid, error: buyErr } = await purchaseTwilioNumber(
      n.phoneNumber,
    );
    if (buyErr) {
      failed++;
      continue;
    }

    let voiceUrl: string | null = null;
    let statusCallback: string | null = null;
    if (twilioSid) {
      const wh = await pointNumberWebhooks(twilioSid);
      voiceUrl = wh.voiceUrl;
      statusCallback = wh.statusCallback;
    }

    const { data: row, error: insErr } = await supabase
      .from("twilio_numbers")
      .insert({
        phone_number: n.phoneNumber,
        friendly_name: n.friendlyName,
        country: "US",
        monthly_cost: n.monthlyCost,
        twilio_sid: twilioSid,
        voice_webhook_url: voiceUrl,
        status_webhook_url: statusCallback,
        attached_campaign_id: input.campaignId,
        area_code: areaCodeOf(n.phoneNumber),
        pool_status: "active",
        warmup_started_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (insErr || !row) {
      failed++;
      continue;
    }

    // Import for OUTBOUND + assign the campaign's agent for INBOUND. Best-effort:
    // a hiccup here doesn't lose the number — the numbers page has repair buttons
    // ("Connect to ElevenLabs" / "Repoint webhooks").
    const imported = await ensureNumberImportedToElevenLabs(supabase, row.id);
    if (imported.ok && agentElId) {
      try {
        await assignAgentToNumber(imported.phoneNumberId, agentElId);
      } catch {
        /* inbound assignment is best-effort */
      }
    }
    bought++;
  }

  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { bought, failed, error: null };
}

/** Retire a number from the pool (permanent until reactivated) — selection skips
 *  it. Does NOT release the Twilio number; use the numbers page for that. */
export async function retirePoolNumber(id: string): Promise<ActionResult> {
  const { supabase, error } = await requireAdmin();
  if (error) return { error };
  const { error: e } = await supabase
    .from("twilio_numbers")
    .update({ pool_status: "retired" })
    .eq("id", id);
  if (e) return { error: "Could not retire the number." };
  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null };
}

/** Reactivate a retired number back into the pool. */
export async function activatePoolNumber(id: string): Promise<ActionResult> {
  const { supabase, error } = await requireAdmin();
  if (error) return { error };
  const { error: e } = await supabase
    .from("twilio_numbers")
    .update({ pool_status: "active" })
    .eq("id", id);
  if (e) return { error: "Could not reactivate the number." };
  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null };
}

/** Manually flag/unflag a number for rotation — held out of selection while
 *  flagged, but reusable (unflag to bring it back). */
export async function setPoolNumberFlag(
  id: string,
  flagged: boolean,
): Promise<ActionResult> {
  const { supabase, error } = await requireAdmin();
  if (error) return { error };
  const { error: e } = await supabase
    .from("twilio_numbers")
    .update({ flagged_for_rotation: flagged })
    .eq("id", id);
  if (e) return { error: "Could not update the number." };
  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null };
}

/** Manually rest a number for `hours` (auto-returns after), or clear its rest
 *  when `hours <= 0`. */
export async function setPoolNumberRest(
  id: string,
  hours: number,
): Promise<ActionResult> {
  const { supabase, error } = await requireAdmin();
  if (error) return { error };
  const restedUntil =
    hours > 0
      ? new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()
      : null;
  const { error: e } = await supabase
    .from("twilio_numbers")
    .update({ rested_until: restedUntil })
    .eq("id", id);
  if (e) return { error: "Could not update the number." };
  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null };
}

/** Suggest how many numbers to buy per area code so a campaign's leads are dialed
 *  locally, based on the campaign's lead geography vs. what its pool already owns.
 *  Read-only. */
export async function suggestPoolPlan(
  campaignId: string,
): Promise<{ plan: AreaCodePlan[]; totalLeads: number; error: string | null }> {
  const { supabase, error } = await requireAdmin();
  if (error) return { plan: [], totalLeads: 0, error };

  // Lists attached to this campaign.
  const { data: atts } = await supabase
    .from("list_campaign_attachments")
    .select("list_id")
    .eq("campaign_id", campaignId)
    .is("detached_at", null);
  const listIds = (atts ?? []).map((a) => a.list_id);
  if (listIds.length === 0) return { plan: [], totalLeads: 0, error: null };

  // Lead area codes (paginate business_phone — an occasional admin action, so
  // scanning the list is fine; PostgREST caps each page at 1,000 rows).
  const leadAreaCodes: string[] = [];
  const PAGE = 1000;
  for (let from = 0; from < 200_000; from += PAGE) {
    const { data } = await supabase
      .from("leads")
      .select("business_phone")
      .in("list_id", listIds)
      .is("deleted_at", null)
      .not("business_phone", "is", null)
      .range(from, from + PAGE - 1);
    const rows = data ?? [];
    for (const r of rows) {
      const ac = areaCodeOf(r.business_phone);
      if (ac) leadAreaCodes.push(ac);
    }
    if (rows.length < PAGE) break;
  }

  // Active pool numbers already owned, per area code.
  const { data: owned } = await supabase
    .from("twilio_numbers")
    .select("area_code")
    .eq("attached_campaign_id", campaignId)
    .is("released_at", null)
    .eq("pool_status", "active");
  const ownedByAreaCode: Record<string, number> = {};
  for (const o of owned ?? []) {
    if (o.area_code)
      ownedByAreaCode[o.area_code] = (ownedByAreaCode[o.area_code] ?? 0) + 1;
  }

  const { data: settingsRow } = await supabase
    .from("app_settings")
    .select("number_pool_settings")
    .limit(1)
    .maybeSingle();
  const dailyCap =
    (settingsRow?.number_pool_settings as { daily_cap?: number } | null)
      ?.daily_cap ?? 100;

  const plan = buildPoolPlan({
    leadAreaCodes,
    ownedByAreaCode,
    dailyCap,
    workdays: 5,
  });
  return { plan, totalLeads: leadAreaCodes.length, error: null };
}
