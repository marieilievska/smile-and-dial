"use server";

import { revalidatePath } from "next/cache";

import { siblingAreaCodes } from "@/lib/dialer/nanp-metros";
import {
  countryForAreaCode,
  regionForAreaCode,
} from "@/lib/dialer/nanp-states";
import { areaCodeOf } from "@/lib/dialer/number-pool";
import {
  buildPoolPlan,
  buildStatePlan,
  type AreaCodePlan,
  type StatePlan,
} from "@/lib/dialer/pool-plan";
import { createClient } from "@/lib/supabase/server";
import {
  assignAgentToNumber,
  ensureNumberImportedToElevenLabs,
} from "@/lib/twilio/place-call";

import {
  pointNumberWebhooks,
  purchaseTwilioNumber,
  searchAvailableNumbers,
  type AvailableNumber,
  type Country,
} from "./numbers";

/**
 * Server actions for a campaign's NUMBER POOL (Phase 3 provisioning). Buy numbers
 * straight into a campaign's pool (with ElevenLabs import + inbound agent
 * assignment), manage each number's pool state (retire / rest / flag), and
 * suggest an area-code buying plan from the campaign's lead geography. Owner-
 * scoped: members manage numbers on their OWN campaigns, admins see all —
 * owner-or-admin RLS on twilio_numbers enforces it. Mirrors number-actions.ts.
 */

type ActionResult = { error: string | null };

const NUMBERS_PATH = "/settings/twilio-numbers";
const CAMPAIGNS_PATH = "/campaigns";
/** Cap a single buy batch so a fat-fingered count can't drain the Twilio account. */
const MAX_BATCH = 25;

/** Confirm the caller is signed in. Members (builders) manage their OWN pool
 *  numbers; owner-or-admin RLS on twilio_numbers scopes every read/write, so a
 *  member only ever touches numbers — and destination campaigns — they own. */
async function requireSignedIn(): Promise<{
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
}): Promise<{
  bought: number;
  failed: number;
  /** How many landed per area code, so the UI can say "8 bought: 5 x 305,
   *  3 x 786" instead of silently substituting a different city. */
  byAreaCode: Record<string, number>;
  error: string | null;
}> {
  const empty = { bought: 0, failed: 0, byAreaCode: {} };
  const { supabase, error: authError } = await requireSignedIn();
  if (authError) return { ...empty, error: authError };

  const count = Math.max(1, Math.min(MAX_BATCH, Math.floor(input.count || 0)));
  const areaCode = input.areaCode.replace(/\D/g, "").slice(0, 3);
  if (areaCode.length !== 3) {
    return { ...empty, error: "Enter a 3-digit area code." };
  }

  // Canadian numbers come from a different Twilio catalogue and carry their own
  // address requirements, so the country follows the area code rather than
  // being assumed.
  const country: Country = countryForAreaCode(areaCode) === "CA" ? "CA" : "US";

  // Campaign + its ElevenLabs agent (for the inbound assignment).
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id, agent:agents(elevenlabs_agent_id)")
    .eq("id", input.campaignId)
    .maybeSingle();
  if (!campaign) return { ...empty, error: "Campaign not found." };
  const agentElId =
    (campaign.agent as { elevenlabs_agent_id: string | null } | null)
      ?.elevenlabs_agent_id ?? null;

  // Local presence, nearest first: the requested area code, then the rest of
  // its metro, then the rest of its state or province. Miami's 305 sold out
  // falls to 786/954/754 before it ever considers Pensacola. Never leaves the
  // state — a random out-of-state number is the robocall pattern this exists to
  // avoid, so running out means reporting it, not substituting.
  const candidateAreaCodes = [areaCode, ...siblingAreaCodes(areaCode)];

  const toBuy: AvailableNumber[] = [];
  let firstSearchError: string | null = null;
  for (const ac of candidateAreaCodes) {
    if (toBuy.length >= count) break;
    const { numbers, error: searchErr } = await searchAvailableNumbers(
      country,
      ac,
      count - toBuy.length,
    );
    // One area code failing to search shouldn't abort the whole plan; remember
    // the first error in case nothing at all is found.
    if (searchErr) {
      firstSearchError ??= searchErr;
      continue;
    }
    toBuy.push(...numbers.slice(0, count - toBuy.length));
  }

  if (toBuy.length === 0) {
    return {
      ...empty,
      error:
        firstSearchError ??
        `No numbers available in ${areaCode} or anywhere else in ${regionForAreaCode(areaCode) ?? "that region"}.`,
    };
  }

  let bought = 0;
  let failed = 0;
  const byAreaCode: Record<string, number> = {};
  let firstBuyError: string | null = null;
  for (const n of toBuy) {
    const { twilioSid, error: buyErr } = await purchaseTwilioNumber(
      n.phoneNumber,
    );
    if (buyErr) {
      failed++;
      firstBuyError ??= buyErr;
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
        // Ownership follows the campaign, so the campaign's owner (themselves,
        // for a member buying into their own campaign) can manage it.
        owner_id: campaign.owner_id,
        phone_number: n.phoneNumber,
        friendly_name: n.friendlyName,
        country,
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
    const boughtAc = areaCodeOf(n.phoneNumber) ?? areaCode;
    byAreaCode[boughtAc] = (byAreaCode[boughtAc] ?? 0) + 1;
  }

  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  // Nothing landed at all — surface why rather than reporting a silent success.
  if (bought === 0) {
    return {
      bought,
      failed,
      byAreaCode,
      error: firstBuyError ?? "No numbers could be purchased.",
    };
  }
  return { bought, failed, byAreaCode, error: null };
}

/** Retire a number from the pool (permanent until reactivated) — selection skips
 *  it. Does NOT release the Twilio number; use the numbers page for that. */
export async function retirePoolNumber(id: string): Promise<ActionResult> {
  const { supabase, error } = await requireSignedIn();
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
  const { supabase, error } = await requireSignedIn();
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
  const { supabase, error } = await requireSignedIn();
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
  const { supabase, error } = await requireSignedIn();
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

/** The per-number half of a campaign move, shared by the single- and bulk-move
 *  actions: re-stamp attached_campaign_id, sever any legacy single-number
 *  pointer (campaigns.twilio_number_id) so a later campaign-settings save can't
 *  re-claim it, re-point the number's ElevenLabs inbound agent, and hand
 *  OWNERSHIP to the destination campaign's owner — so moving a number onto a
 *  member's campaign makes it theirs to see and manage. The caller has already
 *  resolved the destination (RLS-scoped) and that the number is in-pool. EL is
 *  best-effort; returns false only when the DB re-stamp itself fails. */
async function applyCampaignMove(
  supabase: Awaited<ReturnType<typeof createClient>>,
  numberId: string,
  campaignId: string,
  agentElId: string | null,
  newOwnerId: string | null,
): Promise<boolean> {
  const { error: updErr } = await supabase
    .from("twilio_numbers")
    .update({
      attached_campaign_id: campaignId,
      // Ownership follows the campaign. Guarded so a (schema-impossible) null
      // campaign owner never orphans the number into admin-only limbo.
      ...(newOwnerId ? { owner_id: newOwnerId } : {}),
    })
    .eq("id", numberId);
  if (updErr) return false;

  await supabase
    .from("campaigns")
    .update({ twilio_number_id: null })
    .eq("twilio_number_id", numberId);

  // Re-point INBOUND to the destination campaign's agent. Import is idempotent
  // (returns the existing EL phone-number id if already imported).
  const imported = await ensureNumberImportedToElevenLabs(supabase, numberId);
  if (imported.ok && agentElId) {
    try {
      await assignAgentToNumber(imported.phoneNumberId, agentElId);
    } catch {
      /* inbound assignment is best-effort */
    }
  }
  return true;
}

/** The destination campaign's ElevenLabs agent id (for the inbound
 *  re-assignment), or a "not found" flag so callers can 404 cleanly. */
async function destinationAgentElId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  campaignId: string,
): Promise<{
  found: boolean;
  agentElId: string | null;
  ownerId: string | null;
}> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, owner_id, agent:agents(elevenlabs_agent_id)")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) return { found: false, agentElId: null, ownerId: null };
  const agentElId =
    (campaign.agent as { elevenlabs_agent_id: string | null } | null)
      ?.elevenlabs_agent_id ?? null;
  return { found: true, agentElId, ownerId: campaign.owner_id ?? null };
}

/**
 * Move a pool number from whatever campaign it's on to `campaignId`. Re-stamps
 * attached_campaign_id and re-points the number's ElevenLabs agent so INBOUND
 * callbacks reach the destination campaign's agent (OUTBOUND follows on its own —
 * the from-number is chosen per call by selectPoolNumber). Warm-up / health state
 * is preserved — it's the same physical number. EL side is best-effort; the DB
 * move never fails on an EL hiccup (the numbers page has repair buttons).
 */
export async function movePoolNumberToCampaign(
  numberId: string,
  campaignId: string,
): Promise<ActionResult> {
  const { supabase, error: adminError } = await requireSignedIn();
  if (adminError) return { error: adminError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("id, released_at")
    .eq("id", numberId)
    .maybeSingle();
  if (!number) return { error: "Number not found." };
  if (number.released_at) {
    return { error: "This number is released — re-add it before moving." };
  }

  const { found, agentElId, ownerId } = await destinationAgentElId(
    supabase,
    campaignId,
  );
  if (!found) return { error: "Campaign not found." };

  const ok = await applyCampaignMove(
    supabase,
    numberId,
    campaignId,
    agentElId,
    ownerId,
  );
  if (!ok) return { error: "Could not move the number." };

  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  return { error: null };
}

/**
 * Bulk version of movePoolNumberToCampaign: move several in-pool numbers to one
 * campaign in a single action, so the numbers table can reassign a whole
 * selection at once instead of one row at a time. Best-effort per number (one
 * failure never aborts the rest); numbers that are released or already on the
 * destination are silently skipped. Returns how many actually moved vs failed.
 */
export async function moveNumbersToCampaign(
  numberIds: string[],
  campaignId: string,
): Promise<{ moved: number; failed: number; error: string | null }> {
  const { supabase, error: adminError } = await requireSignedIn();
  if (adminError) return { moved: 0, failed: 0, error: adminError };

  const ids = [...new Set(numberIds.filter(Boolean))];
  if (ids.length === 0) {
    return { moved: 0, failed: 0, error: "No numbers selected." };
  }

  const { found, agentElId, ownerId } = await destinationAgentElId(
    supabase,
    campaignId,
  );
  if (!found) return { moved: 0, failed: 0, error: "Campaign not found." };

  // Only in-pool numbers not already on the destination can move.
  const { data: rows } = await supabase
    .from("twilio_numbers")
    .select("id, released_at, attached_campaign_id")
    .in("id", ids);
  const movable = (rows ?? []).filter(
    (r) => !r.released_at && r.attached_campaign_id !== campaignId,
  );

  let moved = 0;
  let failed = 0;
  for (const r of movable) {
    const ok = await applyCampaignMove(
      supabase,
      r.id,
      campaignId,
      agentElId,
      ownerId,
    );
    if (ok) moved++;
    else failed++;
  }

  revalidatePath(NUMBERS_PATH);
  revalidatePath(CAMPAIGNS_PATH);
  if (moved === 0) {
    return {
      moved,
      failed,
      error:
        failed > 0
          ? "Could not move the selected numbers."
          : "Nothing to move — the selected numbers are already on that campaign (or released).",
    };
  }
  return { moved, failed, error: null };
}

/** Suggest how many numbers to buy per area code so a campaign's leads are dialed
 *  locally, based on the campaign's lead geography vs. what its pool already owns.
 *  Read-only. */
export async function suggestPoolPlan(campaignId: string): Promise<{
  /** Recommended: one row per state/province, buying in its densest area code. */
  byState: StatePlan[];
  /** Per-area-code detail, useful for a geographically concentrated campaign. */
  plan: AreaCodePlan[];
  totalLeads: number;
  error: string | null;
}> {
  const { supabase, error } = await requireSignedIn();
  if (error) return { byState: [], plan: [], totalLeads: 0, error };

  // Lists attached to this campaign.
  const { data: atts } = await supabase
    .from("list_campaign_attachments")
    .select("list_id")
    .eq("campaign_id", campaignId)
    .is("detached_at", null);
  const listIds = (atts ?? []).map((a) => a.list_id);
  if (listIds.length === 0)
    return { byState: [], plan: [], totalLeads: 0, error: null };

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
  // How many numbers to BUY still needs a per-number throughput figure, even
  // when dialing itself is uncapped (daily_cap <= 0) — otherwise the planner
  // divides by ~1 and suggests buying thousands. Fall back to the standard
  // reputation-safe figure for the suggestion only; it does not throttle
  // anything at dial time.
  const configuredCap =
    (settingsRow?.number_pool_settings as { daily_cap?: number } | null)
      ?.daily_cap ?? 100;
  const dailyCap = configuredCap > 0 ? configuredCap : 100;

  const plan = buildPoolPlan({
    leadAreaCodes,
    ownedByAreaCode,
    dailyCap,
    workdays: 5,
  });
  const byState = buildStatePlan({
    leadAreaCodes,
    ownedByAreaCode,
    regionOf: regionForAreaCode,
    dailyCap,
    workdays: 5,
  });
  return { byState, plan, totalLeads: leadAreaCodes.length, error: null };
}
