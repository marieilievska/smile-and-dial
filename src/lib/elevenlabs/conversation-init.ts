import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { CONVERSATION_OUTCOMES } from "@/lib/calls/outcomes";
import { stripLeftOff } from "@/lib/openai/summary-note";
import type { Database } from "@/lib/supabase/database.types";
import { hangUpCall } from "@/lib/twilio/hangup";

import { resolveBlockedInbound } from "./blocked-inbound";
import { resolveOrCreateInboundCall } from "./inbound-call";
import {
  pickOpeningSituation,
  renderOpeningInstruction,
  whenPhrase,
} from "./opening-line";

/**
 * Conversation-initiation client-data webhook.
 *
 * ElevenLabs calls this at the START of a conversation (the agent's
 * "Initiation Data Webhook Override"). It POSTs four fields — caller_id,
 * agent_id, called_number, call_sid — and expects back a
 * `conversation_initiation_client_data` event whose `dynamic_variables`
 * fill the {{call_type}}, {{last_call_summary}}, {{last_callback_notes}}
 * placeholders our agents' prompts reference.
 *
 * We correlate on call_sid → calls.twilio_call_sid (stamped the moment the
 * dialer places the call), which gives us the lead + campaign to build the
 * per-call context.
 *
 * EL-NATIVE INBOUND (someone returning our missed call) has no such row yet —
 * nothing on our side placed the call. For those we resolve the dialed number
 * → campaign and the caller → lead, CREATE the calls row right here, and hand
 * back call_type "inbound" plus the new call_id, so the agent opens as the
 * returned call it is and its tools (callback / booking / DNC) can find the
 * lead. Before this, every inbound call got blank "cold" context and every
 * tool failed with "couldn't find the right record".
 *
 * One inbound caller never gets that far: a number on the dialed campaign
 * owner's DNC list is hung up on here, at the Twilio layer, before any lead or
 * call row exists (see blocked-inbound). This is the ONLY place we can stop a
 * nuisance caller cheaply — past this point the conversation is running and
 * ElevenLabs' own end_call can be talked over indefinitely.
 *
 * ALL dynamic variables an agent declares must be present in the response
 * or the conversation can fail to start, so we always return the three keys
 * (empty strings when we have nothing) plus the per-campaign transfer
 * number. Overrides are optional; we send none beyond the variables.
 */

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

export type ConversationInitRequest = {
  caller_id?: string;
  agent_id?: string;
  called_number?: string;
  call_sid?: string;
  conversation_id?: string;
};

/** Fallback greeting when an inbound call's campaign has no custom one set, so
 *  an EL-native inbound call is never silent (the agent waits for the caller
 *  otherwise, and the caller waits for the agent → dead air). */
export const DEFAULT_INBOUND_GREETING =
  "Hi, thanks for calling! How can I help you today?";

export type ConversationInitResponse = {
  type: "conversation_initiation_client_data";
  /** Per-call config overrides. We only set the agent's first_message — the
   *  inbound greeting for the dialed number's campaign. Requires the agent to
   *  allow this override (platform_settings.overrides.conversation_config_override
   *  .agent.first_message, set on agent sync). Omitted entirely on outbound,
   *  which never hits this webhook. */
  conversation_config_override?: {
    agent: { first_message: string };
  };
  dynamic_variables: {
    call_type: string;
    last_call_summary: string;
    last_callback_notes: string;
    // How long ago the previous call was, in plain words ("yesterday", "3 days
    // ago"). Anchors the agent in time so a callback doesn't sound like it's
    // continuing a conversation that happened moments ago.
    last_contact: string;
    transfer_number: string;
    // Our internal calls.id, bound into every server tool's request so the
    // tool webhook can resolve the lead/campaign. Blank when unresolved.
    call_id: string;
    // Lead context for the agent's opening + personalization. All strings
    // (ElevenLabs dynamic variables are string-valued); numbers are
    // stringified, blank when we have no value.
    business_name: string;
    // Contact names — kept current from the lead row, so a name an operator
    // corrected (after ASR mangled it) is what the agent uses, not the stale
    // name embedded in last_call_summary.
    owner_name: string;
    manager_name: string;
    employee_name: string;
    city: string;
    category: string;
    google_rating: string;
    google_reviews: string;
    // Today's date (in the lead's timezone) + the lead's IANA timezone, so the
    // agent can resolve "tomorrow at 3" / "next Tuesday" into an absolute time
    // when booking a callback. Without these it has no anchor for relative times.
    current_date: string;
    // The clock time right now in the lead's timezone ("3:43 PM"), so "in two
    // hours" / "later today" resolve against the lead's clock, not the model's
    // guess at it.
    current_time: string;
    lead_timezone: string;
    // The business's imported CRM / booking / scheduling software (the
    // `booking_crm_software` custom field). Reference-only context the agent can
    // mention — NOT extracted on the call. Blank when the lead has no value.
    booking_crm_software: string;
    // The one plain instruction for how the agent opens THIS call, picked by
    // code (opening-line.ts), never by the model. On a follow-up it carries
    // the exact first reply to say once the business has answered.
    opening_instruction: string;
  };
};

/**
 * The complete set of dynamic-variable keys this webhook returns, as an
 * all-blank placeholder map. SINGLE SOURCE OF TRUTH: the agent sync imports
 * this to declare each agent's `dynamic_variable_placeholders` (see
 * lib/elevenlabs/agents), so the variables an agent is allowed to reference in
 * its prompt can never drift from the ones we actually send here.
 * `buildVarsForCall` / `emptyVariables` fill these with real per-call values;
 * the "" here are the declared defaults used when a field is empty.
 *
 * The `satisfies` clause makes the compiler enforce the lockstep: add a key to
 * the response type above and this constant fails to build until it's added
 * here too — which in turn declares it on every agent.
 */
export const DYNAMIC_VARIABLE_PLACEHOLDERS = {
  call_type: "",
  last_call_summary: "",
  last_callback_notes: "",
  last_contact: "",
  transfer_number: "",
  call_id: "",
  business_name: "",
  owner_name: "",
  manager_name: "",
  employee_name: "",
  city: "",
  category: "",
  google_rating: "",
  google_reviews: "",
  current_date: "",
  current_time: "",
  lead_timezone: "",
  booking_crm_software: "",
  opening_instruction: "",
} as const satisfies Record<
  keyof ConversationInitResponse["dynamic_variables"],
  string
>;

/** The clock time right now (e.g. "3:43 PM") in the given timezone, for the
 *  agent's "in two hours" / "later today" callback reasoning. */
function nowInTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

/** Today's date spelled out (e.g. "Thursday, June 12, 2026") in the given
 *  timezone, for the agent's callback-time reasoning. */
function todayInTimezone(timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date());
}

/**
 * Validate the shared-secret header configured on the ElevenLabs side
 * ("Request headers" on the Initiation Data Webhook). In non-live mode
 * (ELEVENLABS_LIVE != "live") validation is skipped so tests can POST
 * freely; in live mode a matching secret is required.
 */
export function isValidConversationInitSecret(
  provided: string | null,
  expectedSecret?: string,
): boolean {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  const expected =
    expectedSecret ?? process.env.ELEVENLABS_INIT_WEBHOOK_SECRET ?? "";
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Conversation-init webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The init webhook's shared secret. Env wins; otherwise the value stored in
 *  app_settings (Vercel's env store has been unreliable for this project).
 *  Returns null when neither is set, so validation fails closed. */
export async function getConversationInitSecret(): Promise<string | null> {
  const env = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET?.trim();
  if (env) return env;
  try {
    const supabase = makeServiceClient();
    const { data } = await supabase
      .from("app_settings")
      .select("elevenlabs_init_webhook_secret")
      .eq("id", 1)
      .maybeSingle();
    const v = data?.elevenlabs_init_webhook_secret;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Empty-but-complete variable set — what we return when we can't resolve
 *  the call (unknown sid, race before twilio_call_sid was stamped, etc.).
 *  The agent still starts; its prompt just sees blank placeholders. */
function emptyVariables(): ConversationInitResponse["dynamic_variables"] {
  return {
    ...DYNAMIC_VARIABLE_PLACEHOLDERS,
    // The only fields that aren't blank even on an unresolved call: default to
    // a cold call (type + opener), and always give the agent today's date (in
    // the default timezone) so its callback-time reasoning has an anchor.
    call_type: "cold",
    current_date: todayInTimezone("America/New_York"),
    current_time: nowInTimezone("America/New_York"),
    opening_instruction: renderOpeningInstruction({
      situation: "cold",
      when: "",
    }),
  };
}

/** The variable set for a call the inbound webhook can't match to a row. Only
 *  inbound calls reach that webhook (outbound placement passes its own
 *  variables), so whoever this is dialed us: open as inbound, not cold. */
function unmatchedInboundVariables(): ConversationInitResponse["dynamic_variables"] {
  return {
    ...emptyVariables(),
    opening_instruction: renderOpeningInstruction({
      situation: "inbound",
      when: "",
    }),
  };
}

/** A resolved call's variables, marked as the inbound call it is: someone
 *  dialed one of our numbers. Used for the row we create on the first init AND
 *  for a repeat init that finds that row by its CallSid. */
function asInbound(
  vars: ConversationInitResponse["dynamic_variables"],
): ConversationInitResponse["dynamic_variables"] {
  return {
    ...vars,
    call_type: "inbound",
    opening_instruction: renderOpeningInstruction({
      situation: "inbound",
      when: "",
    }),
  };
}

/** Stringify a numeric column for a dynamic variable: blank when null,
 *  otherwise the plain number as text (no trailing ".0"). */
function numStr(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/**
 * Build the agent's dynamic variables for a resolved call row. Shared by the
 * inbound init webhook (resolves by call_sid) AND outbound placement (resolves
 * by our call_id) — ElevenLabs does NOT call the init webhook for API-placed
 * outbound calls, so we must pass these directly when dialing.
 */
async function buildVarsForCall(
  supabase: SupabaseAdmin,
  call: { id: string; lead_id: string; campaign_id: string | null },
): Promise<ConversationInitResponse["dynamic_variables"]> {
  // Pull, in parallel: the lead (status + display fields), the campaign's
  // transfer number and opener lines, the lead's pending callbacks, and the
  // most recent REAL conversation with this business in this campaign. The
  // rolling summary comes from the per-campaign lead_campaign_summaries row,
  // fetched below.
  const [
    { data: lead },
    { data: campaign },
    { data: pendingCallbacks },
    { data: lastConversation },
  ] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "company, status, owner_name, manager_name, employee_name, city, category, google_rating, google_reviews, timezone",
      )
      .eq("id", call.lead_id)
      .maybeSingle(),
    call.campaign_id
      ? supabase
          .from("campaigns")
          .select(
            "transfer_destination_phone, callback_opener, spoken_before_opener",
          )
          .eq("id", call.campaign_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Earliest first, the order the dialer works them in. A lead rarely holds
    // more than one or two, so ten is plenty.
    supabase
      .from("callbacks")
      .select("id, originating_call_id, campaign_id")
      .eq("lead_id", call.lead_id)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true })
      .limit(10),
    // A "real conversation" is the app-wide CONVERSATION_OUTCOMES: hang-ups,
    // "call me later" brush-offs, voicemail, bots and ai_error don't count.
    // The call being placed right now has no outcome yet, so it never matches.
    call.campaign_id
      ? supabase
          .from("calls")
          .select("started_at")
          .eq("lead_id", call.lead_id)
          .eq("campaign_id", call.campaign_id)
          .in("outcome", [...CONVERSATION_OUTCOMES])
          .order("started_at", { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // call_type: a pending callback (or callback-status lead) means we've
  // talked before and promised to circle back; otherwise it's a cold dial.
  const isCallback =
    (pendingCallbacks ?? []).length > 0 || lead?.status === "callback";

  // The callback that shapes THIS call: the earliest one booked in this
  // campaign. One booked under another campaign never reaches this call's
  // opener or notes — the same no-bleed rule as the summary below.
  const campaignCallback = call.campaign_id
    ? ((pendingCallbacks ?? []).find(
        (cb) => cb.campaign_id === call.campaign_id,
      ) ?? null)
    : null;

  // last_callback_notes: the pickup note of the call that booked that
  // callback, so the agent can reference where things left off. Its start time
  // is also the "when" in the callback opener ("I called yesterday").
  let lastCallbackNotes = "";
  let bookedAt: string | null = null;
  if (campaignCallback?.originating_call_id) {
    const { data: originating } = await supabase
      .from("calls")
      .select("summary, callback_notes, campaign_id, started_at")
      .eq("id", campaignCallback.originating_call_id)
      .maybeSingle();
    // Require a real campaign on both sides — never treat two campaign-less
    // (null) calls as a match. Prefer the structured pickup note we generate
    // per call; fall back to the raw per-call recap for callbacks whose
    // originating call predates calls.callback_notes.
    if (call.campaign_id && originating?.campaign_id === call.campaign_id) {
      lastCallbackNotes =
        originating?.callback_notes?.trim() ||
        originating?.summary?.trim() ||
        "";
      bookedAt = originating?.started_at ?? null;
    }
  }

  // Anchor the note in time from the last REAL conversation, in calendar days
  // on the lead's clock. Not leads.last_call_at — every voicemail and no-answer
  // stamps that — and not 24-hour blocks, which read a 5 PM call as "earlier
  // today" the next morning.
  const now = new Date();
  const lastConversationAt = lastConversation?.started_at ?? null;
  const recency = lastConversationAt
    ? whenPhrase(lastConversationAt, now, lead?.timezone)
    : "";

  let summaryText = "";
  if (call.campaign_id) {
    const { data: cs } = await supabase
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", call.lead_id)
      .eq("campaign_id", call.campaign_id)
      .maybeSingle();
    summaryText = cs?.ai_summary?.trim() ?? "";
  }
  // The note's "Left off:" line is a pickup point. With no callback booked in
  // this campaign that point has passed, so the agent never gets handed last
  // week's "try tomorrow". The stored note is untouched.
  const noteText = campaignCallback ? summaryText : stripLeftOff(summaryText);
  const lastCallSummary =
    noteText && recency
      ? `(Our last call with them was ${recency}.) ${noteText}`
      : noteText;

  // How the agent opens: code picks the situation, the model never chooses.
  const situation = pickOpeningSituation({
    inbound: false,
    hasPendingCallbackInCampaign: campaignCallback !== null,
    latestConversationAt: lastConversationAt,
  });
  const openingInstruction = renderOpeningInstruction({
    situation,
    template:
      situation === "callback_booked"
        ? campaign?.callback_opener
        : campaign?.spoken_before_opener,
    when: whenPhrase(
      situation === "callback_booked"
        ? (bookedAt ?? lastConversationAt)
        : lastConversationAt,
      now,
      lead?.timezone,
    ),
  });

  // Imported "Booking / CRM software" custom-field value, exposed so the agent's
  // prompt can reference {{booking_crm_software}}. This is context we already
  // know (from import) — the agent does NOT extract it on the call. Two small
  // lookups: the def id by slug, then the lead's value.
  let bookingCrmSoftware = "";
  const { data: bcsDef } = await supabase
    .from("custom_field_defs")
    .select("id")
    .eq("slug", "booking_crm_software")
    .maybeSingle();
  if (bcsDef?.id) {
    const { data: bcsVal } = await supabase
      .from("lead_custom_values")
      .select("value")
      .eq("lead_id", call.lead_id)
      .eq("custom_field_id", bcsDef.id)
      .maybeSingle();
    const v = bcsVal?.value;
    bookingCrmSoftware = typeof v === "string" ? v : v != null ? String(v) : "";
  }

  return {
    call_type: isCallback ? "callback" : "cold",
    last_call_summary: lastCallSummary,
    last_callback_notes: lastCallbackNotes,
    last_contact: recency,
    transfer_number: campaign?.transfer_destination_phone?.trim() ?? "",
    call_id: call.id,
    business_name: lead?.company?.trim() ?? "",
    owner_name: lead?.owner_name?.trim() ?? "",
    manager_name: lead?.manager_name?.trim() ?? "",
    employee_name: lead?.employee_name?.trim() ?? "",
    city: lead?.city?.trim() ?? "",
    category: lead?.category?.trim() ?? "",
    google_rating: numStr(lead?.google_rating),
    google_reviews: numStr(lead?.google_reviews),
    current_date: todayInTimezone(lead?.timezone || "America/New_York"),
    current_time: nowInTimezone(lead?.timezone || "America/New_York"),
    lead_timezone: lead?.timezone ?? "",
    booking_crm_software: bookingCrmSoftware,
    opening_instruction: openingInstruction,
  };
}

/** Build the agent's dynamic variables by our internal call_id. Used at
 *  outbound placement time so the agent gets full lead context (the init
 *  webhook only fires for inbound). Returns the empty-but-complete set when the
 *  call can't be resolved. */
export async function buildCallDynamicVariables(
  supabase: SupabaseAdmin,
  callId: string,
): Promise<ConversationInitResponse["dynamic_variables"]> {
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id, campaign_id")
    .eq("id", callId)
    .maybeSingle();
  if (!call) return emptyVariables();
  return buildVarsForCall(supabase, call);
}

/**
 * Resolve the inbound greeting (first_message override) for a dialed number.
 *
 * Keyed on `called_number` — the number the caller dialed — because that's the
 * only identifier we have for an EL-native inbound call at init time: the call
 * row doesn't exist yet (it's created from the post-call webhook). We map the
 * number → its attached campaign → the campaign's inbound_greeting, falling
 * back to the default so the agent always opens with something. Returns
 * undefined only when no number was provided (e.g. an outbound init, which in
 * practice never reaches this webhook).
 */
async function resolveGreetingOverride(
  supabase: SupabaseAdmin,
  calledNumber: string | undefined,
): Promise<ConversationInitResponse["conversation_config_override"]> {
  const dialed = calledNumber?.trim();
  if (!dialed) return undefined;

  let greeting = DEFAULT_INBOUND_GREETING;
  const { data: num } = await supabase
    .from("twilio_numbers")
    .select("attached_campaign_id")
    .eq("phone_number", dialed)
    .maybeSingle();
  if (num?.attached_campaign_id) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("inbound_greeting")
      .eq("id", num.attached_campaign_id)
      .maybeSingle();
    const custom = campaign?.inbound_greeting?.trim();
    if (custom) greeting = custom;
  }
  return { agent: { first_message: greeting } };
}

export async function buildConversationInitData(
  body: ConversationInitRequest,
  /** Test seam: the service client to use (defaults to the real one). */
  supabaseOverride?: SupabaseAdmin,
): Promise<ConversationInitResponse> {
  const supabase = supabaseOverride ?? makeServiceClient();

  // The inbound greeting is keyed on the dialed number, independent of whether
  // we can resolve the call row — so a brand-new inbound caller (no call row
  // yet) still gets the campaign's greeting instead of dead air.
  const override = await resolveGreetingOverride(supabase, body.called_number);

  const wrap = (
    vars: ConversationInitResponse["dynamic_variables"],
  ): ConversationInitResponse => ({
    type: "conversation_initiation_client_data",
    ...(override ? { conversation_config_override: override } : {}),
    dynamic_variables: vars,
  });

  const callSid = body.call_sid?.trim() ?? "";
  if (!callSid) return wrap(unmatchedInboundVariables());

  // Resolve the call by the Twilio CallSid we stamped at dial time.
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id, campaign_id, direction")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (call) {
    const vars = await buildVarsForCall(supabase, call);
    // A row with this CallSid that we created as inbound means a repeat init
    // for a call someone placed to us: it opens as inbound again.
    return wrap(call.direction === "inbound" ? asInbound(vars) : vars);
  }

  // No row → we didn't place this call. If the dialed number is one of ours,
  // it's an EL-native INBOUND call (a returned missed call): attribute it to
  // the caller's lead, create the row now, and mark the context "inbound".
  // A dialed number that isn't ours (an outbound-shaped init, which in
  // practice never reaches this webhook) resolves to nothing and stays blank.
  // A caller the owner has blocked never reaches the agent. Terminating the
  // Twilio call here costs one API request; letting it through costs an
  // ElevenLabs conversation whose length the CALLER decides — one nuisance
  // caller ran up ~124 minutes over 40 calls on 2026-09-10/11, and releasing
  // the number he was dialing was the only lever available. Checked BEFORE
  // resolveOrCreateInboundCall so he doesn't leave an orphan Inbound lead
  // behind either.
  const blocked = await resolveBlockedInbound(supabase, {
    agentNumber: body.called_number ?? "",
    callerNumber: body.caller_id ?? "",
  });
  if (blocked.blocked) {
    const hangup = await hangUpCall(callSid);
    // Best-effort audit — never fail the response over a log row. Scoped to
    // the campaign rather than a lead because we deliberately created neither,
    // so this is informational: the block already happened when she listed the
    // number. It's here so the saved calls are visible and countable.
    try {
      await supabase.from("system_events").insert({
        kind: "inbound_blocked",
        actor_user_id: null,
        ref_table: "campaigns",
        ref_id: blocked.campaignId,
        payload: {
          caller: (body.caller_id ?? "").trim(),
          called_number: (body.called_number ?? "").trim(),
          call_sid: callSid,
          conversation_id: body.conversation_id?.trim() || null,
          hangup_ok: hangup.ok,
          hangup_error: hangup.error,
        },
      });
    } catch {
      // best-effort — never fail the webhook over an audit row
    }
    return wrap(emptyVariables());
  }

  const inbound = await resolveOrCreateInboundCall(supabase, {
    agentNumber: body.called_number ?? "",
    callerNumber: body.caller_id ?? "",
    callSid,
    conversationId: body.conversation_id?.trim() || null,
  });
  if (!inbound) return wrap(unmatchedInboundVariables());

  const vars = await buildVarsForCall(supabase, inbound);
  return wrap(asInbound(vars));
}
