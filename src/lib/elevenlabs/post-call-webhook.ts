import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import { mergeLeadSummary } from "@/lib/openai/summary-merger";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;
type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

/**
 * The disposition values our agents are configured to extract via
 * ElevenLabs Data Collection. These map 1:1 to a subset of our outcome
 * enum (BUILD_PLAN §8 / §15).
 */
const DISPOSITION_TO_OUTCOME: Record<string, CallOutcome> = {
  gatekeeper: "gatekeeper",
  not_interested: "not_interested",
  callback: "callback",
  dnc: "dnc",
  goal_met: "goal_met",
};

/**
 * The shape of the webhook body we accept. ElevenLabs's actual payload has
 * more fields than this; we only pluck what we need. Fields are loose-typed
 * because the source is external and we don't trust it.
 */
export type ElevenLabsPostCallPayload = {
  conversation_id?: string;
  /** Custom params we attached to the Twilio <Stream> (our internal
   *  call_id). ElevenLabs echoes stream/SDK custom parameters back here.
   *  We read several documented shapes defensively since the exact nesting
   *  has shifted across ElevenLabs payload versions. */
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
    custom_llm_extra_body?: Record<string, unknown>;
  };
  call_id?: string;
  transcript?: unknown;
  analysis?: {
    summary?: string;
    data_collection?: {
      disposition?: string;
      business_email?: string;
      owner_name?: string;
      manager_name?: string;
      employee_name?: string;
      callback_datetime?: string;
      objection_summary?: string;
    };
    evaluation?: { score?: number };
  };
  metadata?: {
    duration_seconds?: number;
    talk_time_seconds?: number;
    recording_url?: string;
    cost?: {
      elevenlabs?: number;
      openai?: number;
    };
  };
};

/**
 * Validate ElevenLabs's webhook signature.
 *
 * ElevenLabs signs the request body with HMAC-SHA256 using a shared signing
 * secret, and sends the hex digest in `ElevenLabs-Signature`. In mock mode
 * (`ELEVENLABS_LIVE != "live"`) validation is skipped so tests can post
 * freely without a real secret.
 */
export function isValidElevenLabsSignature(input: {
  body: string;
  signature: string | null;
}): boolean {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  if (!input.signature) return false;
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET ?? "";
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(input.body)
    .digest("hex");
  if (expected.length !== input.signature.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(input.signature, "utf8"),
    );
  } catch {
    return false;
  }
}

/** Pull our internal call_id back out of the post-call payload. We attached
 *  it as a Twilio <Stream> custom <Parameter name="call_id">. ElevenLabs has
 *  surfaced echoed stream params under a few different keys across payload
 *  versions, so check each known location and accept a plain top-level
 *  `call_id` too. Returns null when absent (then we fall back to
 *  conversation_id correlation). */
function extractEchoedCallId(
  payload: ElevenLabsPostCallPayload,
): string | null {
  const direct = typeof payload.call_id === "string" ? payload.call_id : null;
  if (direct) return direct;

  const client = payload.conversation_initiation_client_data;
  const fromBag = (bag: Record<string, unknown> | undefined): string | null => {
    const v = bag?.["call_id"];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return (
    fromBag(client?.dynamic_variables) ??
    fromBag(client?.custom_llm_extra_body) ??
    null
  );
}

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "ElevenLabs webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type ProcessResult =
  | { ok: true; status: "applied" }
  | { ok: true; status: "duplicate" }
  | { ok: true; status: "unknown_conversation" }
  | { ok: false; reason: string };

/**
 * Process one ElevenLabs post-call webhook. Idempotent on conversation_id:
 * a replayed webhook returns `duplicate` without touching the call row.
 * If we don't know about the conversation_id, return `unknown_conversation`.
 *
 * The work itself is what BUILD_PLAN §8 / §11 call out for the post-call
 * pipeline:
 *   1. Write outcome / transcript / summary / score / extracted / cost
 *      onto the matching `calls` row.
 *   2. Auto-fill the LEAD's currently-empty contact fields from the
 *      extracted data (don't overwrite a field that's already filled).
 *   3. Push next_call_at out by 30 minutes as a placeholder. The real
 *      per-outcome retry scheduling lands in Step 24.
 *
 * DNC insertion (for outcome=dnc / invalid_number / language_barrier),
 * callback row creation (for outcome=callback), and Goal Met notifications
 * are deferred to Step 23b and Step 24.
 */
export async function processElevenLabsPostCall(
  payload: ElevenLabsPostCallPayload,
): Promise<ProcessResult> {
  const conversationId = payload.conversation_id ?? "";
  if (!conversationId) return { ok: false, reason: "missing_conversation_id" };

  const supabase = makeServiceClient();

  // Idempotency guard. Cast the loose payload to `Json` for the column type.
  const { error: insertError } = await supabase
    .from("elevenlabs_webhook_events")
    .insert({
      conversation_id: conversationId,
      raw_payload:
        payload as unknown as Database["public"]["Tables"]["elevenlabs_webhook_events"]["Insert"]["raw_payload"],
    });
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: true, status: "duplicate" };
    }
    return { ok: false, reason: "could_not_log_event" };
  }

  // Resolve the matching call. Two correlation paths:
  //  1. Our internal call_id, echoed back from the Twilio <Stream>
  //     <Parameter name="call_id">. This is the live-mode path — the
  //     ElevenLabs conversation_id is minted at connect time and is never
  //     known to us synchronously, so we can't have stored it up front.
  //  2. elevenlabs_conversation_id, for rows where it was pre-stamped
  //     (tests + any future flow that learns the id another way).
  const echoedCallId = extractEchoedCallId(payload);
  let call: {
    id: string;
    lead_id: string;
    campaign_id: string;
    cost_breakdown: unknown;
    elevenlabs_conversation_id: string | null;
  } | null = null;

  if (echoedCallId) {
    const { data } = await supabase
      .from("calls")
      .select(
        "id, lead_id, campaign_id, cost_breakdown, elevenlabs_conversation_id",
      )
      .eq("id", echoedCallId)
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) {
    const { data } = await supabase
      .from("calls")
      .select(
        "id, lead_id, campaign_id, cost_breakdown, elevenlabs_conversation_id",
      )
      .eq("elevenlabs_conversation_id", conversationId)
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) return { ok: true, status: "unknown_conversation" };

  // Stamp the conversation_id onto the row the first time we see it so the
  // /calls UI and any later replay can correlate without the echoed param.
  if (!call.elevenlabs_conversation_id) {
    await supabase
      .from("calls")
      .update({ elevenlabs_conversation_id: conversationId })
      .eq("id", call.id);
  }

  // Map disposition → outcome.
  const disposition = payload.analysis?.data_collection?.disposition ?? "";
  const outcomeFromDisposition = DISPOSITION_TO_OUTCOME[disposition] ?? null;

  // Merge ElevenLabs's cost slice into whatever's already in cost_breakdown
  // (which Twilio has been updating in parallel).
  const prevCost = (call.cost_breakdown ?? {}) as Record<string, number>;
  const elevenLabsCost = payload.metadata?.cost?.elevenlabs ?? 0;
  const openaiCost = payload.metadata?.cost?.openai ?? 0;
  const mergedCost = {
    twilio: prevCost.twilio ?? 0,
    elevenlabs: elevenLabsCost,
    openai: openaiCost,
    lookup: prevCost.lookup ?? 0,
    total:
      (prevCost.twilio ?? 0) +
      elevenLabsCost +
      openaiCost +
      (prevCost.lookup ?? 0),
  };

  const callUpdate: Database["public"]["Tables"]["calls"]["Update"] = {
    transcript_json:
      payload.transcript === undefined
        ? null
        : (payload.transcript as Database["public"]["Tables"]["calls"]["Update"]["transcript_json"]),
    summary: payload.analysis?.summary ?? null,
    score: payload.analysis?.evaluation?.score ?? null,
    extracted_data: (payload.analysis?.data_collection ??
      null) as Database["public"]["Tables"]["calls"]["Update"]["extracted_data"],
    cost_breakdown:
      mergedCost as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
  };
  if (outcomeFromDisposition) {
    callUpdate.outcome = outcomeFromDisposition;
    callUpdate.outcome_source = "elevenlabs";
    callUpdate.goal_met = outcomeFromDisposition === "goal_met";
  }
  if (payload.metadata?.duration_seconds) {
    callUpdate.duration_seconds = payload.metadata.duration_seconds;
  }
  if (payload.metadata?.talk_time_seconds) {
    callUpdate.talk_time_seconds = payload.metadata.talk_time_seconds;
  }
  if (payload.metadata?.recording_url) {
    // We store the URL ElevenLabs gives us for now. Step deferred: download
    // the recording into Supabase Storage and replace with a storage path.
    callUpdate.recording_path = payload.metadata.recording_url;
  }

  const { error: callError } = await supabase
    .from("calls")
    .update(callUpdate)
    .eq("id", call.id);
  if (callError) return { ok: false, reason: "could_not_update_call" };

  // Auto-fill empty lead fields from extracted data.
  await autoFillLeadFromExtraction(supabase, call.lead_id, payload);

  // Outcome-driven side effects: DNC insertion, callback row creation, and
  // lead-status transitions. Per BUILD_PLAN §8 outcome table:
  //   dnc / invalid_number / language_barrier → status=dnc, auto-DNC insert
  //   callback                                → status=callback, callbacks row
  //   everything else                         → handled by Step 24
  await applyOutcomeSideEffects(supabase, {
    callId: call.id,
    leadId: call.lead_id,
    campaignId: call.campaign_id,
    outcome: outcomeFromDisposition,
    callbackDatetime:
      payload.analysis?.data_collection?.callback_datetime ?? null,
  });

  // Step 39: roll the per-call summary into the lead's running ai_summary.
  // Mock by default; OPENAI_LIVE=live calls gpt-4o-mini. The merger logs
  // its own cost into cost_breakdown.openai on the call.
  const latestSummary = payload.analysis?.summary ?? null;
  if (latestSummary) {
    const { cost } = await mergeLeadSummary({
      leadId: call.lead_id,
      latestSummary,
    });
    if (cost > 0) {
      // Bump cost_breakdown.openai on this call and update total.
      const cb = (mergedCost ?? {}) as Record<string, number>;
      const next = {
        ...cb,
        openai: (cb.openai ?? 0) + cost,
        total: (cb.total ?? 0) + cost,
      };
      await supabase
        .from("calls")
        .update({
          cost_breakdown:
            next as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
        })
        .eq("id", call.id);
    }
  }

  return { ok: true, status: "applied" };
}

/**
 * Auto-populate currently-empty lead contact fields from ElevenLabs's
 * extracted data. Per BUILD_PLAN §8 line 810, this NEVER overwrites a
 * field that's already filled — manual edits and prior calls take
 * precedence over a fresh extraction.
 */
async function autoFillLeadFromExtraction(
  supabase: SupabaseAdmin,
  leadId: string,
  payload: ElevenLabsPostCallPayload,
): Promise<void> {
  const ex = payload.analysis?.data_collection ?? {};
  const candidates: Partial<Record<keyof LeadUpdate, string>> = {};
  if (ex.business_email) candidates.business_email = ex.business_email;
  if (ex.owner_name) candidates.owner_name = ex.owner_name;
  if (ex.manager_name) candidates.manager_name = ex.manager_name;
  if (ex.employee_name) candidates.employee_name = ex.employee_name;
  if (Object.keys(candidates).length === 0) return;

  const { data: lead } = await supabase
    .from("leads")
    .select("business_email, owner_name, manager_name, employee_name")
    .eq("id", leadId)
    .single();
  if (!lead) return;

  const patch: LeadUpdate = {};
  for (const key of Object.keys(candidates) as (keyof typeof candidates)[]) {
    // Only fill if the lead's existing value is null/empty.
    if (!lead[key as keyof typeof lead]) {
      (patch as Record<string, string>)[key] = candidates[key]!;
    }
  }
  if (Object.keys(patch).length > 0) {
    await supabase.from("leads").update(patch).eq("id", leadId);
  }
}

/**
 * Map a "this conversation went badly" outcome onto the right DNC reason.
 * Returns null when the outcome is something we don't auto-DNC.
 */
function dncReasonForOutcome(
  outcome: CallOutcome,
): "dnc_requested" | "invalid_number" | "language_barrier" | null {
  if (outcome === "dnc") return "dnc_requested";
  if (outcome === "invalid_number") return "invalid_number";
  if (outcome === "language_barrier") return "language_barrier";
  return null;
}

/**
 * Apply the post-call side effects driven by the call outcome:
 *
 *   * `dnc` / `invalid_number` / `language_barrier` →
 *     - insert the lead's phone into `dnc_entries` (silently skip if it's
 *       already there — phone is unique workspace-wide)
 *     - set lead.status = 'dnc' so the queue drops it on the next tick
 *
 *   * `callback` →
 *     - insert a row in `callbacks` at `callback_datetime` (or now+1h if
 *       the agent didn't capture a datetime — Step 24's retry engine
 *       refines this)
 *     - set lead.status = 'callback' and lead.next_call_at to the
 *       scheduled time so the dialer picks it back up then
 *
 * Everything else (voicemail, no_answer, gatekeeper, not_interested,
 * goal_met, ai_*, transferred_to_human) is the retry engine's job in
 * Step 24. For those outcomes we leave lead.status alone here.
 */
async function applyOutcomeSideEffects(
  supabase: SupabaseAdmin,
  input: {
    callId: string;
    leadId: string;
    campaignId: string;
    outcome: CallOutcome;
    callbackDatetime: string | null;
  },
): Promise<void> {
  // If THIS webhook didn't change the outcome, still drive the retry
  // engine — the call row may already have an outcome set by Twilio
  // (busy/no-answer/failed) or by a manual override. The engine's
  // CAS lock handles double-firing.
  if (!input.outcome) {
    await applyRetryForCall(input.callId);
    return;
  }

  // The lead's phone + company are needed for both DNC inserts and (in
  // theory) callback enrichment. One lookup either way.
  const { data: lead } = await supabase
    .from("leads")
    .select("business_phone, company, owner_id")
    .eq("id", input.leadId)
    .single();
  if (!lead) return;

  // --- Goal Met notification (Step 40) ---
  // Insert into notifications for the lead's owner so the bell badges them.
  // Idempotency: spend-cap / connect-rate monitors guard against dupes via
  // their cron windows; here we rely on the post-call webhook's CAS check
  // upstream — once per call.
  if (input.outcome === "goal_met" && lead.owner_id) {
    const messageBits = [
      "Goal Met:",
      lead.company || "this lead",
      "moved to scheduled.",
    ];
    await supabase.from("notifications").insert({
      user_id: lead.owner_id,
      kind: "goal_met",
      message: messageBits.join(" "),
      ref_table: "calls",
      ref_id: input.callId,
    });
  }

  // --- DNC ---
  const dncReason = dncReasonForOutcome(input.outcome);
  if (dncReason && lead.business_phone) {
    // upsert with ignoreDuplicates so the unique-on-phone constraint
    // doesn't error if the number is already on the list.
    await supabase.from("dnc_entries").upsert(
      {
        phone: lead.business_phone,
        company_snapshot: lead.company,
        reason: dncReason,
        source_call_id: input.callId,
      },
      { onConflict: "phone", ignoreDuplicates: true },
    );
    await supabase
      .from("leads")
      .update({ status: "dnc", next_call_at: null })
      .eq("id", input.leadId);
    return;
  }

  // --- callback ---
  if (input.outcome === "callback") {
    // If the agent didn't capture a datetime, fall back to "tomorrow same
    // time" so we at least have a scheduled time. Step 24 will refine this
    // when the retry engine lands.
    const parsed = input.callbackDatetime
      ? new Date(input.callbackDatetime)
      : null;
    const scheduledAt =
      parsed && !isNaN(parsed.getTime())
        ? parsed
        : new Date(Date.now() + 24 * 60 * 60 * 1000);

    await supabase.from("callbacks").insert({
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      originating_call_id: input.callId,
      scheduled_at: scheduledAt.toISOString(),
      status: "pending",
      // created_by left null — the agent auto-scheduled this.
    });
    await supabase
      .from("leads")
      .update({
        status: "callback",
        next_call_at: scheduledAt.toISOString(),
      })
      .eq("id", input.leadId);
    return;
  }

  // Everything else routes through the retry engine: voicemail / no_answer
  // / gatekeeper / not_interested / ai_receptionist / goal_met / etc. The
  // engine is the single source of truth for retry_counter / retry_position
  // / status / next_call_at / resting_until and is idempotent on the call,
  // so it's safe even if the Twilio webhook beat us to it.
  await applyRetryForCall(input.callId);
}
