import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

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
 * per-call context. Read-only.
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
    transfer_number: string;
    // Our internal calls.id, bound into every server tool's request so the
    // tool webhook can resolve the lead/campaign. Blank when unresolved.
    call_id: string;
    // Lead context for the agent's opening + personalization. All strings
    // (ElevenLabs dynamic variables are string-valued); numbers are
    // stringified, blank when we have no value.
    owner_name: string;
    city: string;
    category: string;
    google_rating: string;
    google_reviews: string;
  };
};

/**
 * Validate the shared-secret header configured on the ElevenLabs side
 * ("Request headers" on the Initiation Data Webhook). In non-live mode
 * (ELEVENLABS_LIVE != "live") validation is skipped so tests can POST
 * freely; in live mode a matching secret is required.
 */
export function isValidConversationInitSecret(
  provided: string | null,
): boolean {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  const expected = process.env.ELEVENLABS_INIT_WEBHOOK_SECRET ?? "";
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

/** Empty-but-complete variable set — what we return when we can't resolve
 *  the call (unknown sid, race before twilio_call_sid was stamped, etc.).
 *  The agent still starts; its prompt just sees blank placeholders. */
function emptyVariables(): ConversationInitResponse["dynamic_variables"] {
  return {
    call_type: "cold",
    last_call_summary: "",
    last_callback_notes: "",
    transfer_number: "",
    call_id: "",
    owner_name: "",
    city: "",
    category: "",
    google_rating: "",
    google_reviews: "",
  };
}

/** Stringify a numeric column for a dynamic variable: blank when null,
 *  otherwise the plain number as text (no trailing ".0"). */
function numStr(v: number | null | undefined): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "";
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

  // Resolve the call by the Twilio CallSid we stamped at dial time.
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id, campaign_id")
    .eq("twilio_call_sid", callSid)
    .maybeSingle();
  if (!call) return wrap(emptyVariables());

  // Pull, in parallel: the lead (rolling summary + status), the campaign's
  // transfer number, the lead's pending callback, and the lead's most recent
  // prior call summary (for "what happened last time" callback context).
  const [{ data: lead }, { data: campaign }, { data: pendingCallback }] =
    await Promise.all([
      supabase
        .from("leads")
        .select(
          "ai_summary, status, owner_name, city, category, google_rating, google_reviews",
        )
        .eq("id", call.lead_id)
        .maybeSingle(),
      supabase
        .from("campaigns")
        .select("transfer_destination_phone")
        .eq("id", call.campaign_id)
        .maybeSingle(),
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

  return wrap({
    call_type: isCallback ? "callback" : "cold",
    last_call_summary: lead?.ai_summary?.trim() ?? "",
    last_callback_notes: lastCallbackNotes,
    transfer_number: campaign?.transfer_destination_phone?.trim() ?? "",
    call_id: call.id,
    owner_name: lead?.owner_name?.trim() ?? "",
    city: lead?.city?.trim() ?? "",
    category: lead?.category?.trim() ?? "",
    google_rating: numStr(lead?.google_rating),
    google_reviews: numStr(lead?.google_reviews),
  });
}
