import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { ensureInboundCallRow } from "@/lib/twilio/inbound-webhook";

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
 * For an INBOUND call (EL-native answer), there's no row yet — ElevenLabs only
 * calls this webhook for inbound, never for API-placed outbound — so an unknown
 * call_sid here means a fresh incoming call. We create the inbound `calls` row +
 * match/create the lead on the spot (via ensureInboundCallRow) and return its
 * call_id, so the call is logged, the agent gets full lead context, and the
 * post-call webhook can link the recording/transcript/outcome back to it.
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
};

export type ConversationInitResponse = {
  type: "conversation_initiation_client_data";
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
    owner_name: string;
    city: string;
    category: string;
    google_rating: string;
    google_reviews: string;
    // Today's date (in the lead's timezone) + the lead's IANA timezone, so the
    // agent can resolve "tomorrow at 3" / "next Tuesday" into an absolute time
    // when booking a callback. Without these it has no anchor for relative times.
    current_date: string;
    lead_timezone: string;
  };
};

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

/** Plain-English "how long ago" for the previous call, so the agent knows time
 *  has passed and a callback doesn't sound like it's continuing a conversation
 *  from moments ago. Empty string when there's no prior call. */
function humanRecency(fromIso: string | null | undefined): string {
  if (!fromIso) return "";
  const then = new Date(fromIso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "about a week ago";
  if (days < 31) return `${Math.round(days / 7)} weeks ago`;
  if (days < 60) return "about a month ago";
  return `${Math.round(days / 30)} months ago`;
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
    call_type: "cold",
    last_call_summary: "",
    last_callback_notes: "",
    last_contact: "",
    transfer_number: "",
    call_id: "",
    business_name: "",
    owner_name: "",
    city: "",
    category: "",
    google_rating: "",
    google_reviews: "",
    current_date: todayInTimezone("America/New_York"),
    lead_timezone: "",
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
  // Pull, in parallel: the lead (rolling summary + status), the campaign's
  // transfer number, and the lead's pending callback.
  const [{ data: lead }, { data: campaign }, { data: pendingCallback }] =
    await Promise.all([
      supabase
        .from("leads")
        .select(
          "company, ai_summary, status, owner_name, city, category, google_rating, google_reviews, timezone, last_call_at",
        )
        .eq("id", call.lead_id)
        .maybeSingle(),
      call.campaign_id
        ? supabase
            .from("campaigns")
            .select("transfer_destination_phone")
            .eq("id", call.campaign_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase
        .from("callbacks")
        .select("id, originating_call_id")
        .eq("lead_id", call.lead_id)
        .eq("status", "pending")
        .order("scheduled_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

  // call_type: a pending callback (or callback-status lead) means we've
  // talked before and promised to circle back; otherwise it's a cold dial.
  const isCallback = Boolean(pendingCallback) || lead?.status === "callback";

  // last_callback_notes: the summary of the call that originated the pending
  // callback, so the agent can reference where things left off.
  let lastCallbackNotes = "";
  if (pendingCallback?.originating_call_id) {
    const { data: originating } = await supabase
      .from("calls")
      .select("summary")
      .eq("id", pendingCallback.originating_call_id)
      .maybeSingle();
    lastCallbackNotes = originating?.summary?.trim() ?? "";
  }

  // Anchor the rolling summary in time: prefix it with how long ago the last
  // call was, so the agent doesn't treat a 2-day-old "left off on hold" as if
  // it just happened. lead.last_call_at is still the PREVIOUS call here (the
  // current call hasn't stamped it yet).
  const recency = humanRecency(lead?.last_call_at);
  const summaryText = lead?.ai_summary?.trim() ?? "";
  const lastCallSummary =
    summaryText && recency
      ? `(Our last call with them was ${recency}.) ${summaryText}`
      : summaryText;

  return {
    call_type: isCallback ? "callback" : "cold",
    last_call_summary: lastCallSummary,
    last_callback_notes: lastCallbackNotes,
    last_contact: recency,
    transfer_number: campaign?.transfer_destination_phone?.trim() ?? "",
    call_id: call.id,
    business_name: lead?.company?.trim() ?? "",
    owner_name: lead?.owner_name?.trim() ?? "",
    city: lead?.city?.trim() ?? "",
    category: lead?.category?.trim() ?? "",
    google_rating: numStr(lead?.google_rating),
    google_reviews: numStr(lead?.google_reviews),
    current_date: todayInTimezone(lead?.timezone || "America/New_York"),
    lead_timezone: lead?.timezone ?? "",
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

export async function buildConversationInitData(
  body: ConversationInitRequest,
): Promise<ConversationInitResponse> {
  const wrap = (
    vars: ConversationInitResponse["dynamic_variables"],
  ): ConversationInitResponse => ({
    type: "conversation_initiation_client_data",
    dynamic_variables: vars,
  });

  const callSid = body.call_sid?.trim() ?? "";
  if (!callSid) return wrap(emptyVariables());

  const supabase = makeServiceClient();

  // Resolve the call by the Twilio CallSid we stamped at dial time (outbound).
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id, campaign_id")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (call) return wrap(await buildVarsForCall(supabase, call));

  // No row for this CallSid → an EL-native INBOUND call we haven't logged yet
  // (this webhook only fires for inbound). Create the inbound call + lead now so
  // it's tracked in-app, and return its call_id so the post-call webhook links
  // the recording/transcript/outcome. Falls back to blank context if we can't
  // resolve the caller/called numbers to a campaign (unknown number, etc.).
  const fromNumber = body.caller_id?.trim() ?? "";
  const toNumber = body.called_number?.trim() ?? "";
  if (fromNumber && toNumber) {
    const ensured = await ensureInboundCallRow(supabase, {
      callSid,
      fromNumber,
      toNumber,
    });
    if ("status" in ensured && ensured.status === "routed") {
      return wrap(
        await buildVarsForCall(supabase, {
          id: ensured.callId,
          lead_id: ensured.leadId,
          campaign_id: ensured.campaignId,
        }),
      );
    }
  }

  return wrap(emptyVariables());
}
