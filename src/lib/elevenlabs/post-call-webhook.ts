import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import { mergeLeadSummary } from "@/lib/openai/summary-merger";
import type { Database, Json } from "@/lib/supabase/database.types";

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
  voicemail: "voicemail",
};

/** ElevenLabs Conversational AI is billed in credits; the post-call payload
 *  reports the total as a number in metadata.cost. Convert to USD. Default is
 *  the Pro plan rate (~$0.000198/credit); override with ELEVENLABS_USD_PER_CREDIT
 *  if the workspace plan differs. */
const ELEVENLABS_USD_PER_CREDIT =
  Number(process.env.ELEVENLABS_USD_PER_CREDIT) || 0.000198;

/** Normalize the post-call cost into USD. Real ElevenLabs sends a credit count
 *  (number); our legacy tests send a pre-split { elevenlabs, openai } object. */
function elevenLabsCostUsd(
  cost: number | { elevenlabs?: number; openai?: number } | undefined,
): number {
  if (typeof cost === "number") {
    return Number((cost * ELEVENLABS_USD_PER_CREDIT).toFixed(4));
  }
  if (cost && typeof cost === "object") {
    return (cost.elevenlabs ?? 0) + (cost.openai ?? 0);
  }
  return 0;
}

/** Disposition from the real data_collection_results[*].value, else the legacy
 *  flat data_collection.disposition. */
function dispositionOf(
  analysis: ElevenLabsPostCallPayload["analysis"],
): string {
  const real = analysis?.data_collection_results?.disposition?.value;
  if (typeof real === "string" && real) return real;
  const legacy = analysis?.data_collection?.disposition;
  return typeof legacy === "string" ? legacy : "";
}

/** Flatten the data collection into a {key: value} map for extracted_data,
 *  reading the real results shape first, else the legacy flat object. */
function extractedDataOf(
  analysis: ElevenLabsPostCallPayload["analysis"],
): Record<string, unknown> | null {
  const results = analysis?.data_collection_results;
  if (results && typeof results === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(results)) {
      out[k] = v && typeof v === "object" && "value" in v ? v.value : v;
    }
    return out;
  }
  return (analysis?.data_collection ?? null) as Record<string, unknown> | null;
}

/** Extraction keys that must NOT become custom fields. These are operational
 *  (disposition → outcome, callback_datetime → callbacks) or already map onto
 *  the lead's built-in columns (email / names). Everything else the agent
 *  captures becomes a custom field. Compared against the slugified key. */
const RESERVED_EXTRACTION_KEYS = new Set([
  "disposition",
  "callback_datetime",
  "objection_summary",
  "business_email",
  "owner_name",
  "manager_name",
  "employee_name",
]);

/** Map an ElevenLabs termination reason to an UNAMBIGUOUS telephony outcome.
 *  Only the clear-cut carrier states are inferred here; a conversational
 *  "remote party ended" is intentionally left to the agent's disposition. */
function telephonyOutcome(reason: string): CallOutcome | null {
  const r = reason.toLowerCase();
  if (/voicemail/.test(r)) return "voicemail";
  if (/no[ _-]?answer|unanswered|not answered|timed? ?out|timeout|ring/.test(r))
    return "no_answer";
  if (/busy/.test(r)) return "busy";
  if (/fail|carrier|invalid number|rejected|\berror\b/.test(r)) return "failed";
  return null;
}

/** slug for a custom field, matching the custom-fields admin slugify. */
function slugifyKey(key: string): string {
  return key
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** "current_provider" → "Current provider" for the custom field's display name. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A captured value counts as "populated" when it's a non-blank string or any
 *  number/boolean. We never write or create fields for blanks. */
function isPopulated(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return typeof value === "number" || typeof value === "boolean";
}

/**
 * Mirror the AI's extracted data onto the lead's CUSTOM FIELDS. For each
 * captured value that has a value and isn't a reserved/operational key:
 *   - find the custom field whose slug matches (the field's name is the
 *     extraction's name), creating it if it doesn't exist yet;
 *   - upsert the value onto this lead.
 * Only populated values are written, so empty captures never create or clear a
 * field. Runs under the service role (custom_field_defs is admin-write).
 */
async function applyExtractionToCustomFields(
  supabase: SupabaseAdmin,
  leadId: string,
  extracted: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(extracted).filter(([key, value]) => {
    const slug = slugifyKey(key);
    return slug && !RESERVED_EXTRACTION_KEYS.has(slug) && isPopulated(value);
  });
  if (entries.length === 0) return;

  for (const [key, value] of entries) {
    const slug = slugifyKey(key);

    // Find the field by slug, or create it (name = the extraction's name).
    let fieldId: string | null = null;
    const { data: existing } = await supabase
      .from("custom_field_defs")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (existing) {
      fieldId = existing.id;
    } else {
      const { count } = await supabase
        .from("custom_field_defs")
        .select("id", { count: "exact", head: true });
      const { data: created } = await supabase
        .from("custom_field_defs")
        .insert({
          name: humanizeKey(key),
          slug,
          type: "text",
          required: false,
          options: [],
          sort_order: count ?? 0,
        })
        .select("id")
        .maybeSingle();
      if (created) {
        fieldId = created.id;
      } else {
        // Lost a create race against a concurrent call — re-read the slug.
        const { data: again } = await supabase
          .from("custom_field_defs")
          .select("id")
          .eq("slug", slug)
          .maybeSingle();
        fieldId = again?.id ?? null;
      }
    }
    if (!fieldId) continue;

    await supabase.from("lead_custom_values").upsert(
      {
        lead_id: leadId,
        custom_field_id: fieldId,
        value: value as Json,
      },
      { onConflict: "lead_id,custom_field_id" },
    );
  }
}

/**
 * The shape of the webhook body we accept. ElevenLabs's actual payload has
 * more fields than this; we only pluck what we need. Fields are loose-typed
 * because the source is external and we don't trust it.
 */
/**
 * The webhook envelope ElevenLabs actually POSTs. The real fields live under
 * `data`, with a top-level `type` discriminator and `event_timestamp`. We
 * support three event types on the one webhook URL:
 *   - post_call_transcription → transcript / analysis / cost (the main one)
 *   - post_call_audio         → base64 MP3 of the full call
 *   - call_initiation_failure → telephony failed to connect
 * For backward-compat we also accept a "flat" body (no type/data wrapper) and
 * treat it as transcription data — that's the shape our older tests post.
 */
export type ElevenLabsWebhookEnvelope = {
  type?: string;
  event_timestamp?: number;
  data?: Record<string, unknown>;
} & ElevenLabsPostCallPayload;

export type ElevenLabsAudioData = {
  conversation_id?: string;
  call_id?: string;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
    custom_llm_extra_body?: Record<string, unknown>;
  };
  /** Base64-encoded complete conversation audio, MP3. */
  full_audio?: string;
};

export type ElevenLabsFailureData = {
  conversation_id?: string;
  call_id?: string;
  conversation_initiation_client_data?: {
    dynamic_variables?: Record<string, unknown>;
    custom_llm_extra_body?: Record<string, unknown>;
  };
  failure_reason?: string;
};

/** The transcription event's `data` payload (also the legacy flat shape). */
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
    // REAL ElevenLabs field is `transcript_summary`; `summary` is the legacy
    // shape our older tests post. We read both (real first).
    transcript_summary?: string;
    summary?: string;
    // REAL ElevenLabs field is `data_collection_results`, keyed by the data-
    // collection field id, each `{ value, rationale, ... }`. Legacy tests post
    // a flat `data_collection` object. We read both.
    data_collection_results?: Record<
      string,
      { value?: unknown; rationale?: string } | undefined
    >;
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
    // REAL field is `call_duration_secs`; `duration_seconds` is legacy.
    call_duration_secs?: number;
    duration_seconds?: number;
    talk_time_seconds?: number;
    recording_url?: string;
    /** Why the conversation ended. When the agent's voicemail_detection
     *  system tool fires, this reads like "voicemail" — we use it to label the
     *  call's outcome when the agent didn't also set a disposition. */
    termination_reason?: string;
    // REAL ElevenLabs `cost` is a NUMBER (credits). Legacy tests post an object
    // of pre-split dollar costs. We handle both in elevenLabsCostUsd().
    cost?: number | { elevenlabs?: number; openai?: number };
  };
};

/**
 * Validate ElevenLabs's webhook signature (HMAC auth mode).
 *
 * ElevenLabs sends a Svix/Stripe-style header:
 *   ElevenLabs-Signature: t=<unix_seconds>,v0=<hex_hmac>[,v0=<hex_hmac>...]
 * where the HMAC-SHA256 is computed over `${timestamp}.${rawBody}` with the
 * webhook signing secret, hex-encoded. The header may carry more than one
 * v0= during secret rotation — any match passes. A 30-minute timestamp
 * tolerance guards against replay. (Format verified against the ElevenLabs
 * JS/Python SDK source.)
 *
 * IMPORTANT: `body` must be the RAW request text, byte-for-byte — re-
 * serializing parsed JSON would change the bytes and break the signature.
 *
 * In mock mode (`ELEVENLABS_LIVE != "live"`) validation is skipped so tests
 * can post freely without a real secret.
 */
const SIGNATURE_TOLERANCE_SECONDS = 30 * 60;

export function isValidElevenLabsSignature(input: {
  body: string;
  signature: string | null;
  /** The HMAC signing secret. Resolved by the caller (env → DB). When
   *  omitted, falls back to the env var so existing tests keep working. */
  secret?: string;
}): boolean {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  if (!input.signature) return false;
  const secret = input.secret ?? process.env.ELEVENLABS_WEBHOOK_SECRET ?? "";
  if (!secret) return false;

  // Parse "t=..." and one-or-more "v0=..." from the comma-separated header.
  const parts = input.signature.split(",");
  const timestamp = parts
    .find((p) => p.startsWith("t="))
    ?.slice(2)
    .trim();
  const provided = parts
    .filter((p) => p.startsWith("v0="))
    .map((p) => p.slice(3).trim());
  if (!timestamp || provided.length === 0) return false;

  // Replay guard: reject timestamps outside ±30 minutes.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${input.body}`)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");

  // Constant-time compare against each provided v0= (rotation-safe).
  return provided.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    if (sigBuf.length !== expectedBuf.length) return false;
    try {
      return timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}

/** Pull our internal call_id back out of the post-call payload. We attached
 *  it as a Twilio <Stream> custom <Parameter name="call_id">. ElevenLabs has
 *  surfaced echoed stream params under a few different keys across payload
 *  versions, so check each known location and accept a plain top-level
 *  `call_id` too. Returns null when absent (then we fall back to
 *  conversation_id correlation). */
/** Read an echoed call_id out of a conversation_initiation_client_data bag
 *  (the dynamic_variables / custom_llm_extra_body sub-objects). Shared by
 *  every event type since they all carry this same bag. */
export function extractEchoedCallIdFromBag(
  client:
    | {
        dynamic_variables?: Record<string, unknown>;
        custom_llm_extra_body?: Record<string, unknown>;
      }
    | undefined,
): string | null {
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

function extractEchoedCallId(
  payload: ElevenLabsPostCallPayload,
): string | null {
  const direct = typeof payload.call_id === "string" ? payload.call_id : null;
  if (direct) return direct;
  return extractEchoedCallIdFromBag(
    payload.conversation_initiation_client_data,
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

/** The post-call webhook's HMAC signing secret. Env wins; otherwise the value
 *  stored in app_settings (Vercel's env store has been unreliable for this
 *  project, so the DB is the dependable source). Returns null when neither is
 *  set, which makes signature validation fail closed. */
export async function getElevenLabsWebhookSecret(): Promise<string | null> {
  // DB-FIRST: the webhook secret that pairs with the registered post-call
  // webhook id lives in app_settings (written when we create the webhook). A
  // stale ELEVENLABS_WEBHOOK_SECRET in Vercel's (unreliable) env store would
  // otherwise win and make every delivery fail signature validation (403), so
  // the DB value is authoritative; env is only a fallback for local/dev.
  try {
    const supabase = makeServiceClient();
    const { data } = await supabase
      .from("app_settings")
      .select("elevenlabs_post_call_webhook_secret")
      .eq("id", 1)
      .maybeSingle();
    const v = data?.elevenlabs_post_call_webhook_secret;
    if (typeof v === "string" && v.length > 0) return v;
  } catch {
    // fall through to env
  }
  return process.env.ELEVENLABS_WEBHOOK_SECRET?.trim() || null;
}

export type ProcessResult =
  | { ok: true; status: "applied" }
  | { ok: true; status: "duplicate" }
  | { ok: true; status: "unknown_conversation" }
  | { ok: true; status: "ignored" }
  | { ok: false; reason: string };

/** Resolve our `calls` row from a webhook's conversation_id / echoed
 *  call_id, stamping the conversation_id on first match. Shared by every
 *  event type so audio / failure correlate the same way as transcription. */
async function resolveCall(
  supabase: SupabaseAdmin,
  conversationId: string,
  echoedCallId: string | null,
): Promise<{
  id: string;
  lead_id: string;
  campaign_id: string;
  cost_breakdown: unknown;
  elevenlabs_conversation_id: string | null;
} | null> {
  const cols =
    "id, lead_id, campaign_id, cost_breakdown, elevenlabs_conversation_id";
  let call = null as Awaited<ReturnType<typeof resolveCall>>;
  if (echoedCallId) {
    const { data } = await supabase
      .from("calls")
      .select(cols)
      .eq("id", echoedCallId)
      .maybeSingle();
    call = data ?? null;
  }
  if (!call) {
    const { data } = await supabase
      .from("calls")
      .select(cols)
      .eq("elevenlabs_conversation_id", conversationId)
      .maybeSingle();
    call = data ?? null;
  }
  if (call && !call.elevenlabs_conversation_id) {
    await supabase
      .from("calls")
      .update({ elevenlabs_conversation_id: conversationId })
      .eq("id", call.id);
  }
  return call;
}

/**
 * Top-level dispatcher. Unwraps the ElevenLabs envelope ({ type, data }),
 * falls back to the legacy flat shape, and routes to the right handler:
 *   post_call_transcription (or flat) → processTranscription
 *   post_call_audio                   → processAudio (store the recording)
 *   call_initiation_failure           → processInitiationFailure
 * Unknown types are acknowledged (200) and ignored so a newly-enabled event
 * never wedges ElevenLabs into a retry storm.
 */
export async function processElevenLabsPostCall(
  envelope: ElevenLabsWebhookEnvelope,
): Promise<ProcessResult> {
  const type = envelope.type;
  // Unwrap `data` when present; otherwise the envelope IS the (flat) data.
  const hasWrapper = type !== undefined && envelope.data !== undefined;

  if (!type || type === "post_call_transcription") {
    const data = (
      hasWrapper ? envelope.data : envelope
    ) as ElevenLabsPostCallPayload;
    return processTranscription(data, type ?? "post_call_transcription");
  }
  if (type === "post_call_audio") {
    return processAudio((envelope.data ?? {}) as ElevenLabsAudioData);
  }
  if (type === "call_initiation_failure") {
    return processInitiationFailure(
      (envelope.data ?? {}) as ElevenLabsFailureData,
    );
  }
  return { ok: true, status: "ignored" };
}

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
async function processTranscription(
  payload: ElevenLabsPostCallPayload,
  eventType: string,
): Promise<ProcessResult> {
  const conversationId = payload.conversation_id ?? "";
  if (!conversationId) return { ok: false, reason: "missing_conversation_id" };

  const supabase = makeServiceClient();

  // Idempotency guard, keyed on (conversation_id, event_type) so a replayed
  // transcription collapses to one but the separate audio/failure events for
  // the same conversation aren't mistaken for duplicates.
  const { error: insertError } = await supabase
    .from("elevenlabs_webhook_events")
    .insert({
      conversation_id: conversationId,
      event_type: eventType,
      raw_payload:
        payload as unknown as Database["public"]["Tables"]["elevenlabs_webhook_events"]["Insert"]["raw_payload"],
    });
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: true, status: "duplicate" };
    }
    return { ok: false, reason: "could_not_log_event" };
  }

  const call = await resolveCall(
    supabase,
    conversationId,
    extractEchoedCallId(payload),
  );
  if (!call) return { ok: true, status: "unknown_conversation" };

  // Map disposition → outcome. If the agent didn't set a disposition but its
  // voicemail_detection ended the call, fall back to labeling it voicemail
  // (we no longer use Twilio AMD, so the AI is the source of truth here).
  const disposition = dispositionOf(payload.analysis);
  const terminationReason = payload.metadata?.termination_reason ?? "";
  // Outcome priority: the agent's disposition (most accurate) → an unambiguous
  // telephony state read from the termination reason (voicemail / no-answer /
  // busy / failed). A conversational hang-up with NO disposition stays null on
  // purpose — only the agent's disposition can say whether "remote party ended"
  // was a polite goodbye or a rude hang-up. (Add a `disposition` data-collection
  // field to the agent to classify those.)
  const outcomeFromDisposition: CallOutcome | null =
    DISPOSITION_TO_OUTCOME[disposition] ?? telephonyOutcome(terminationReason);

  // Merge ElevenLabs's cost slice into whatever's already in cost_breakdown
  // (Twilio/lookup may have written there). ElevenLabs bundles LLM+TTS+telephony
  // into one credit figure, so it all lands under `elevenlabs`.
  const prevCost = (call.cost_breakdown ?? {}) as Record<string, number>;
  const elevenLabsCost = elevenLabsCostUsd(payload.metadata?.cost);
  const mergedCost = {
    twilio: prevCost.twilio ?? 0,
    elevenlabs: elevenLabsCost,
    openai: 0,
    lookup: prevCost.lookup ?? 0,
    total: (prevCost.twilio ?? 0) + elevenLabsCost + (prevCost.lookup ?? 0),
  };

  const callUpdate: Database["public"]["Tables"]["calls"]["Update"] = {
    // ElevenLabs places & owns the call now, so Twilio status callbacks don't
    // hit us — the post-call webhook is our completion signal. Mark the call
    // done so it doesn't sit on "dialing" forever.
    status: "completed",
    ended_at: new Date().toISOString(),
    transcript_json:
      payload.transcript === undefined
        ? null
        : (payload.transcript as Database["public"]["Tables"]["calls"]["Update"]["transcript_json"]),
    summary:
      payload.analysis?.transcript_summary ?? payload.analysis?.summary ?? null,
    score: payload.analysis?.evaluation?.score ?? null,
    extracted_data: extractedDataOf(
      payload.analysis,
    ) as Database["public"]["Tables"]["calls"]["Update"]["extracted_data"],
    cost_breakdown:
      mergedCost as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
  };
  if (outcomeFromDisposition) {
    callUpdate.outcome = outcomeFromDisposition;
    callUpdate.outcome_source = "elevenlabs";
    callUpdate.goal_met = outcomeFromDisposition === "goal_met";
  }
  const durationSecs =
    payload.metadata?.call_duration_secs ?? payload.metadata?.duration_seconds;
  if (durationSecs) {
    callUpdate.duration_seconds = durationSecs;
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

  // Auto-fill empty built-in lead fields from extracted data.
  await autoFillLeadFromExtraction(supabase, call.lead_id, payload);

  // Mirror the rest of the captured data onto the lead's custom fields
  // (creating fields on first sight, populating only non-blank values).
  await applyExtractionToCustomFields(
    supabase,
    call.lead_id,
    extractedDataOf(payload.analysis) ?? {},
  );

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
 * Audio event (type=post_call_audio): decode the base64 MP3 and store it in
 * the private call-recordings bucket, then point calls.recording_path at the
 * stored object. Idempotent on (conversation_id, "post_call_audio").
 */
async function processAudio(data: ElevenLabsAudioData): Promise<ProcessResult> {
  const conversationId = data.conversation_id ?? "";
  if (!conversationId) return { ok: false, reason: "missing_conversation_id" };
  if (!data.full_audio) return { ok: true, status: "ignored" };

  const supabase = makeServiceClient();

  // Idempotency: don't re-upload on a retry. We log the event WITHOUT the
  // base64 blob (it's large and we don't need it twice).
  const { error: insertError } = await supabase
    .from("elevenlabs_webhook_events")
    .insert({
      conversation_id: conversationId,
      event_type: "post_call_audio",
      raw_payload: { conversation_id: conversationId, audio: true } as Json,
    });
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: true, status: "duplicate" };
    }
    return { ok: false, reason: "could_not_log_event" };
  }

  const call = await resolveCall(
    supabase,
    conversationId,
    extractEchoedCallIdFromBag(data.conversation_initiation_client_data) ??
      data.call_id ??
      null,
  );
  if (!call) return { ok: true, status: "unknown_conversation" };

  // Decode base64 MP3 → upload. Path keyed by call id so it's stable.
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data.full_audio, "base64");
  } catch {
    return { ok: false, reason: "bad_audio_encoding" };
  }
  const path = `${call.id}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("call-recordings")
    .upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
  if (uploadError) return { ok: false, reason: "could_not_store_audio" };

  await supabase
    .from("calls")
    .update({ recording_path: path })
    .eq("id", call.id);

  return { ok: true, status: "applied" };
}

/**
 * Call-initiation-failure event (type=call_initiation_failure): the
 * telephony layer never connected. Mark the call failed and log a system
 * event so it surfaces on /system-health. Idempotent per conversation.
 */
async function processInitiationFailure(
  data: ElevenLabsFailureData,
): Promise<ProcessResult> {
  const conversationId = data.conversation_id ?? "";
  if (!conversationId) return { ok: false, reason: "missing_conversation_id" };

  const supabase = makeServiceClient();

  const { error: insertError } = await supabase
    .from("elevenlabs_webhook_events")
    .insert({
      conversation_id: conversationId,
      event_type: "call_initiation_failure",
      raw_payload: data as unknown as Json,
    });
  if (insertError) {
    if ((insertError as { code?: string }).code === "23505") {
      return { ok: true, status: "duplicate" };
    }
    return { ok: false, reason: "could_not_log_event" };
  }

  const call = await resolveCall(
    supabase,
    conversationId,
    extractEchoedCallIdFromBag(data.conversation_initiation_client_data) ??
      data.call_id ??
      null,
  );

  // Log regardless — useful even if we can't match a call row.
  await supabase.from("system_events").insert({
    kind: "call_initiation_failure",
    actor_user_id: null,
    ref_table: call ? "calls" : null,
    ref_id: call?.id ?? null,
    payload: {
      conversation_id: conversationId,
      failure_reason: data.failure_reason ?? null,
    },
  });

  if (!call) return { ok: true, status: "unknown_conversation" };

  await supabase
    .from("calls")
    .update({ status: "failed", outcome: "failed" })
    .eq("id", call.id);

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
  const ex = extractedDataOf(payload.analysis) ?? {};
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const candidates: Partial<Record<keyof LeadUpdate, string>> = {};
  const businessEmail = asStr(ex.business_email);
  if (businessEmail) candidates.business_email = businessEmail;
  const ownerName = asStr(ex.owner_name);
  if (ownerName) candidates.owner_name = ownerName;
  const managerName = asStr(ex.manager_name);
  if (managerName) candidates.manager_name = managerName;
  const employeeName = asStr(ex.employee_name);
  if (employeeName) candidates.employee_name = employeeName;
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
