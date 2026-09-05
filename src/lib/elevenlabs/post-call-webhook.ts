import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { after } from "next/server";

import {
  resolveDueCallbacksForLead,
  syncLeadNextCallToEarliestCallback,
} from "@/lib/callbacks/sync-next-call";
import { callReachedDm, outcomeImpliesDm } from "@/lib/calls/decision-maker";
import { classifyCallOutcome } from "@/lib/calls/classify-outcome";
import { resolveOrCreateInboundCall } from "@/lib/elevenlabs/inbound-call";
import { fetchAndStoreRecording } from "@/lib/elevenlabs/recording-fetch";
import {
  deferSameDayCallbackIso,
  localHourDaysAheadIso,
  parseLeadLocalDatetime,
} from "@/lib/dialer/local-schedule";
import {
  applyRetryForCall,
  finalizeFailedCall,
} from "@/lib/dialer/retry-engine";
import { recordAiCharge } from "@/lib/costs/ai-charges";
import { numField, withRecomputedTotal } from "@/lib/costs/breakdown";
import { primeEffectiveRates } from "@/lib/costs/effective-rates";
import {
  elevenLabsUsdPerCredit,
  priceElevenLabsCredits,
  priceElevenLabsNativeTwilio,
} from "@/lib/costs/rates";
import { syncLeadCallCounters } from "@/lib/leads/call-counters";
import { mergeLeadSummary } from "@/lib/openai/summary-merger";
import type { Database, Json } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;
type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];

// ElevenLabs Conversational AI is billed in credits; the post-call payload
// reports the total as a number in metadata.cost. The per-credit USD rate lives
// in the central rates module (env ELEVENLABS_USD_PER_CREDIT).

/** Normalize the post-call cost into USD. Real ElevenLabs sends a credit count
 *  (number); our legacy tests send a pre-split { elevenlabs, openai } object. */
function elevenLabsCostUsd(
  cost: number | { elevenlabs?: number; openai?: number } | undefined,
): number {
  if (typeof cost === "number") {
    return priceElevenLabsCredits(cost);
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
 *  (disposition → outcome, callback_datetime → callbacks), already map onto
 *  the lead's built-in columns (email / names), or are surfaced by a dedicated
 *  built-in control — `decision_maker_reached` drives the lead's Decision-maker
 *  Yes/No flag (see callReachedDm), so mirroring it into a custom field would
 *  just duplicate that. Everything else the agent captures becomes a custom
 *  field. Compared against the slugified key. */
const RESERVED_EXTRACTION_KEYS = new Set([
  "disposition",
  "callback_datetime",
  "business_email",
  "owner_name",
  "manager_name",
  "employee_name",
  "decision_maker_reached",
]);

/** Factual identity/contact details worth keeping even when no real two-way
 *  conversation happened. If someone answers, says "this is Wilson", and hangs
 *  up — or a voicemail greeting names the owner — that name is still real and
 *  should be captured. Everything OUTSIDE this set (decision_maker_reached,
 *  sentiment, objection_summary, research answers, …) is a judgment the LLM
 *  can only make from an actual conversation, so it's dropped on
 *  voicemails / no-answers / immediate hang-ups. Compared against the
 *  slugified key. */
const IDENTITY_EXTRACTION_KEYS = new Set([
  "owner_name",
  "manager_name",
  "employee_name",
  "business_email",
  "callback_datetime",
]);

/** When a real conversation happened, keep the full extraction. Otherwise keep
 *  only the populated identity/contact fields (names, email, callback time) and
 *  drop the LLM's guesses (decision maker, sentiment, …). */
function sanitizeExtraction(
  extracted: Record<string, unknown>,
  conversationHappened: boolean,
): Record<string, unknown> {
  if (conversationHappened) return extracted;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (IDENTITY_EXTRACTION_KEYS.has(slugifyKey(key)) && isPopulated(value)) {
      out[key] = value;
    }
  }
  return out;
}

/** Non-answers the analysis LLM emits when it didn't actually learn anything.
 *  These must never create or fill a custom field (e.g. an "Objection category"
 *  field reading "none" is noise). */
const EMPTY_EXTRACTION_VALUES = new Set([
  "",
  "unknown",
  "none",
  "n/a",
  "na",
  "null",
  "not mentioned",
  "not provided",
]);

/** UTC ISO for "the next calling day at `hour`:00 in the lead's timezone" — a
 *  predictable, in-hours time to schedule a callback/retry when the lead didn't
 *  name one. Delegates to the shared weekday-aware helper so a "tomorrow" that
 *  would land on a weekend rolls to Monday (calls run Mon–Fri). */
function nextDayLocalHourIso(
  timeZone: string | null | undefined,
  hour = 10,
): string {
  return localHourDaysAheadIso(timeZone, 1, hour);
}

/** Turn the post-call transcript payload into plain "Agent:/Lead:" text for the
 *  rolling-summary generator. Mirrors the Call Reviewer's formatter — accepts a
 *  bare array of turns or an object wrapping a `transcript` array, and reads
 *  either `message` or `text` off each turn. */
function transcriptToText(raw: unknown): string {
  const turns = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { transcript?: unknown }).transcript)
      ? (raw as { transcript: unknown[] }).transcript
      : [];
  return (turns as Record<string, unknown>[])
    .map((t) => {
      const role = t.role === "user" ? "Lead" : "Agent";
      const msg =
        typeof t.message === "string"
          ? t.message
          : typeof t.text === "string"
            ? t.text
            : "";
      return msg ? `${role}: ${msg}` : "";
    })
    .filter(Boolean)
    .join("\n");
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

/** A captured value is worth mirroring to a custom field only when it carries
 *  real information: a meaningful string (not a blank/"unknown"/"none"
 *  non-answer), a number, or a `true` boolean. `false` and the non-answers are
 *  treated as "nothing learned" so they never create or fill a noise field. */
function isPopulated(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    return v.length > 0 && !EMPTY_EXTRACTION_VALUES.has(v);
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value === true;
  return false;
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

/** Lead identity columns the AI may hear on a call. */
const LEAD_IDENTITY_COLUMNS = [
  "owner_name",
  "manager_name",
  "employee_name",
  "business_email",
] as const;

/**
 * Fill the lead's identity fields (names, email) from what the call heard —
 * but ONLY where the lead's own value is blank. Imported CSV data always wins,
 * so a mis-transcribed name ("Jin" → "Jinmi") can never overwrite a good value;
 * a field the import left empty simply gets populated from the call.
 *
 * This deliberately reverses the earlier "never copy heard names/emails onto the
 * lead" rule (call-summary rewrite, 2026-07-28) at the operator's request — the
 * heard values were only visible on the call, never on the lead. The
 * fill-blank-only guard keeps the overwrite protection that motivated the
 * original rule. Applies regardless of whether a full conversation happened:
 * identity can come from a voicemail greeting or a "this is Wilson" + hang-up.
 */
async function fillLeadIdentityFromCall(
  supabase: SupabaseAdmin,
  leadId: string,
  extracted: Record<string, unknown>,
): Promise<void> {
  const heard: Record<string, string> = {};
  for (const col of LEAD_IDENTITY_COLUMNS) {
    const v = extracted[col];
    if (typeof v === "string" && v.trim()) heard[col] = v.trim();
  }
  // Emails are spelled out on calls and easily mis-heard — drop anything that
  // doesn't even look like an address rather than filling a field with garbage.
  if (
    heard.business_email &&
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(heard.business_email)
  ) {
    delete heard.business_email;
  }
  if (Object.keys(heard).length === 0) return;

  const { data: lead } = await supabase
    .from("leads")
    .select("owner_name, manager_name, employee_name, business_email")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return;

  const update: Database["public"]["Tables"]["leads"]["Update"] = {};
  for (const col of LEAD_IDENTITY_COLUMNS) {
    const value = heard[col];
    if (!value) continue;
    const current = lead[col];
    if (current == null || String(current).trim() === "") update[col] = value;
  }
  if (Object.keys(update).length > 0) {
    await supabase.from("leads").update(update).eq("id", leadId);
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
  /** The ElevenLabs agent that ran the conversation. Only read when the
   *  conversation matches no call row (a browser Test Call), to attribute
   *  its cost to the agent's owner. */
  agent_id?: string;
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
    /** REAL field: per-criterion success-evaluation results, keyed by
     *  criterion id. result ∈ success | failure | unknown. We average the
     *  gradable quality criteria into the call's 0–10 score. */
    evaluation_criteria_results?: Record<
      string,
      { result?: string; rationale?: string } | undefined
    >;
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
    // ElevenLabs splits the bundled credit figure into LLM vs the rest
    // (TTS/ASR/telephony). `cost` = total credits, `llm_charge` = LLM credits,
    // `call_charge` = voice + telephony credits. Captured so the Costs page can
    // break ElevenLabs apart into LLM vs voice/telephony (in $ and credits).
    charging?: {
      cost?: number;
      llm_charge?: number;
      call_charge?: number;
    };
    // ElevenLabs-NATIVE inbound: when EL answers an inbound call (the agent is
    // assigned to the number inside EL), the post-call payload carries the
    // call's phone details here. There's no echoed call_id, so we use this to
    // CREATE the inbound `calls` row + lead — otherwise inbound calls never get
    // logged in the app.
    phone_call?: {
      direction?: string;
      agent_number?: string;
      external_number?: string;
      call_sid?: string;
      phone_number_id?: string;
    };
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

/**
 * Fetch a call's recording from the ElevenLabs API once this webhook has
 * answered. Uses Next's after() so the fetch (up to ~16 MB for a 1000 s
 * call) never holds up the 200 ElevenLabs is waiting for. after() only works
 * inside a request scope — outside one (a script, a unit test) it throws, and
 * we fall back to an inline, bounded fetch instead. Either way nothing here
 * can throw out of the webhook: fetchAndStoreRecording returns typed failures
 * and records them on the call for the tick's backfill sweep to retry.
 */
function scheduleRecordingFetch(
  supabase: SupabaseAdmin,
  input: { callId: string; conversationId: string },
): void | Promise<void> {
  const run = async () => {
    try {
      await fetchAndStoreRecording(supabase, input);
    } catch {
      /* never let a recording fetch fail the post-call pipeline */
    }
  };
  try {
    after(run);
  } catch {
    return run();
  }
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
  started_at: string | null;
  direction: string | null;
} | null> {
  const cols =
    "id, lead_id, campaign_id, cost_breakdown, elevenlabs_conversation_id, started_at, direction";
  let call = null as Awaited<ReturnType<typeof resolveCall>>;
  if (echoedCallId) {
    const { data } = await supabase
      .from("calls")
      .select(cols)
      .eq("id", echoedCallId)
      .maybeSingle();
    call = (data ?? null) as typeof call;
  }
  if (!call) {
    const { data } = await supabase
      .from("calls")
      .select(cols)
      .eq("elevenlabs_conversation_id", conversationId)
      .maybeSingle();
    call = (data ?? null) as typeof call;
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
 * EL-native inbound fallback: when neither the echoed call_id nor the
 * conversation_id resolves a row, and the payload says it's an inbound phone
 * call, resolve/create the inbound `calls` row + lead (see
 * resolveOrCreateInboundCall — shared with the conversation-init webhook,
 * which normally creates this row at the START of the call so the agent has
 * context and a working call_id). Returns null when it isn't an attributable
 * inbound call.
 */
async function createInboundCallFromPayload(
  supabase: SupabaseAdmin,
  payload: ElevenLabsPostCallPayload,
  conversationId: string,
): Promise<Awaited<ReturnType<typeof resolveCall>>> {
  const pc = payload.metadata?.phone_call;
  if (!pc || pc.direction !== "inbound") return null;
  return resolveOrCreateInboundCall(supabase, {
    agentNumber: pc.agent_number ?? "",
    callerNumber: pc.external_number ?? "",
    callSid: pc.call_sid ?? "",
    conversationId,
  });
}

/**
 * A transcription we cannot match to any call row is almost always a Test
 * Call: the campaign's Test Call tab opens a browser conversation with the
 * real agent (lib/campaigns/test-call.ts), and ElevenLabs bills those credits
 * like any other. Book them to `ai_charges` (kind elevenlabs_test_call) —
 * owner = the agent's owner when `agent_id` resolves to one of ours, else the
 * first active admin — instead of dropping the cost. Best-effort; a replayed
 * webhook is already deduped by the idempotency row, so this never
 * double-books.
 */
async function recordTestCallCharge(
  supabase: SupabaseAdmin,
  payload: ElevenLabsPostCallPayload,
  conversationId: string,
): Promise<void> {
  const credits =
    typeof payload.metadata?.cost === "number" &&
    Number.isFinite(payload.metadata.cost)
      ? payload.metadata.cost
      : 0;
  if (credits <= 0) return;

  let ownerId: string | null = null;
  const elAgentId = payload.agent_id?.trim();
  if (elAgentId) {
    const { data: agent } = await supabase
      .from("agents")
      .select("owner_id")
      .eq("elevenlabs_agent_id", elAgentId)
      .maybeSingle();
    ownerId = agent?.owner_id ?? null;
  }
  if (!ownerId) {
    const { data: admin } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .eq("active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    ownerId = admin?.id ?? null;
  }
  if (!ownerId) return;

  await recordAiCharge(supabase, {
    ownerId,
    kind: "elevenlabs_test_call",
    model: null,
    cost: priceElevenLabsCredits(credits),
    detail: {
      conversation_id: conversationId,
      agent_id: elAgentId ?? null,
      credits,
      llm_credits: payload.metadata?.charging?.llm_charge ?? null,
      call_charge_credits: payload.metadata?.charging?.call_charge ?? null,
      duration_secs:
        payload.metadata?.call_duration_secs ??
        payload.metadata?.duration_seconds ??
        null,
    },
  });
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
  // Price this call at what the providers actually charge (cost_rates, cached
  // 10 min), not at the hard-coded defaults. Never throws.
  await primeEffectiveRates(supabase);

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

  let call = await resolveCall(
    supabase,
    conversationId,
    extractEchoedCallId(payload),
  );
  // EL-native inbound has no echoed call_id, so resolveCall misses. Create the
  // inbound call + lead so it's logged instead of dropped as unknown.
  if (!call) {
    call = await createInboundCallFromPayload(
      supabase,
      payload,
      conversationId,
    );
  }
  if (!call) {
    // No call row: a browser Test Call from the campaign's Test Call tab (or a
    // conversation started outside the app). ElevenLabs billed it all the
    // same, so book the credits to the ledger instead of dropping them.
    await recordTestCallCharge(supabase, payload, conversationId);
    return { ok: true, status: "unknown_conversation" };
  }

  // Decide the call's outcome from the transcript + the agent's disposition
  // guess + ElevenLabs' termination reason. The full priority ladder (AI
  // receptionist → confirmed voicemail greeting → EL voicemail_detection, unless
  // a real human conversation happened → dead-air/no-answer → disposition →
  // immediate hang-up) lives in one pure, unit-tested function so it can't drift
  // between here and its tests. It also tells us whether a real two-way human
  // conversation happened (drives whether we mirror extracted judgment fields).
  const disposition = dispositionOf(payload.analysis);
  const terminationReason = payload.metadata?.termination_reason ?? "";
  // How long the conversation actually ran (real field first, legacy second).
  const callDurationSecs =
    payload.metadata?.call_duration_secs ??
    payload.metadata?.duration_seconds ??
    0;
  const { outcome: outcomeFromDisposition, reachedHuman } = classifyCallOutcome(
    {
      transcript: payload.transcript,
      disposition,
      terminationReason,
      callDurationSecs,
      // Inbound (a returned missed call) can't be a voicemail / no-answer —
      // the classifier treats those signals as a caller hang-up instead.
      direction: call.direction,
      // Owner-only guard for not_interested: the classifier downgrades it to
      // gatekeeper_not_interested unless the extractor confirmed dm="yes".
      decisionMakerReached: extractedDataOf(payload.analysis)
        ?.decision_maker_reached,
    },
  );

  // Merge ElevenLabs's cost slice into whatever's already in cost_breakdown
  // (Twilio/lookup/in-call research may have written there). ElevenLabs
  // bundles LLM+TTS+telephony into one credit figure, so it all lands under
  // `elevenlabs`, priced at the EFFECTIVE $/credit (see lib/costs/rates).
  const prevCost = (call.cost_breakdown ?? {}) as Record<string, unknown>;
  const elevenLabsCost = elevenLabsCostUsd(payload.metadata?.cost);
  // ElevenLabs splits its bundled credit total into LLM (the agent's model) vs
  // call_charge (TTS + ASR + telephony). Capture both the credits and the USD
  // split so the Costs page can show LLM vs voice/telephony. Absent on legacy
  // payloads — then the split is 0 and only the bundled `elevenlabs` total shows.
  const elRate = elevenLabsUsdPerCredit();
  const charging = payload.metadata?.charging;
  const elNum = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;
  const elTotalCredits =
    typeof payload.metadata?.cost === "number"
      ? payload.metadata.cost
      : elNum(charging?.cost);
  const elLlmCredits = elNum(charging?.llm_charge);
  const elVoiceCredits = elNum(charging?.call_charge);
  const elLlmUsd = Number((elLlmCredits * elRate).toFixed(4));
  const elVoiceUsd = Number((elVoiceCredits * elRate).toFixed(4));
  // Twilio bills the call leg even though ElevenLabs places the call — the
  // voice minutes at the INBOUND or OUTBOUND rate (they differ ~2x), PLUS a
  // media-stream minute for every call minute (ElevenLabs-native telephony
  // streams the audio through Twilio's <Stream>; verified on the usage
  // records). If a prior path (e.g. a human-call recording webhook) already
  // wrote a Twilio cost, keep it; otherwise price this call's duration.
  const prevTwilio = numField(prevCost, "twilio");
  const twilioParts =
    prevTwilio > 0
      ? {
          call: numField(prevCost, "twilio_call") || prevTwilio,
          mediaStream: numField(prevCost, "twilio_media_stream"),
          total: prevTwilio,
        }
      : priceElevenLabsNativeTwilio(callDurationSecs, call.direction);
  const mergedCost = withRecomputedTotal({
    // Carry every prior key (an in-call research charge under `openai`, a
    // lookup, a reviewer's `openai_review`) — this webhook owns the vendor
    // figures it computes, not the whole object.
    ...prevCost,
    twilio: twilioParts.total,
    // Sub-parts of `twilio` (NOT added into total again).
    twilio_call: twilioParts.call,
    twilio_media_stream: twilioParts.mediaStream,
    elevenlabs: elevenLabsCost,
    // ElevenLabs LLM vs voice/telephony split (sub-components of `elevenlabs`;
    // NOT added into total again). Both USD and the raw credits.
    elevenlabs_llm: elLlmUsd,
    elevenlabs_voice: elVoiceUsd,
    elevenlabs_credits: elTotalCredits,
    elevenlabs_llm_credits: elLlmCredits,
    elevenlabs_voice_credits: elVoiceCredits,
    openai: numField(prevCost, "openai"),
    lookup: numField(prevCost, "lookup"),
  });

  // The real per-call summary ElevenLabs sends is `transcript_summary`;
  // `summary` is only the legacy test shape. This single value is written to
  // the call row AND fed to mergeLeadSummary below, so the rolling lead summary
  // tracks the same text the call shows.
  const callSummary =
    payload.analysis?.transcript_summary ?? payload.analysis?.summary ?? null;

  // The sanitized extraction (judgment/research fields dropped when no human
  // was reached). Hoisted so it feeds both the call row and the hot-lead seed.
  const cleanedExtraction = sanitizeExtraction(
    extractedDataOf(payload.analysis) ?? {},
    reachedHuman,
  );

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
    // Only keep a summary when a real human conversation happened. A voicemail
    // greeting, no-answer, or instant hang-up has nothing worth summarizing —
    // and the analysis LLM otherwise "summarizes" the agent's own scripted
    // monologue, which then pollutes the per-campaign rolling summary.
    summary: reachedHuman ? callSummary : null,
    extracted_data: (Object.keys(cleanedExtraction).length > 0
      ? cleanedExtraction
      : null) as Database["public"]["Tables"]["calls"]["Update"]["extracted_data"],
    cost_breakdown:
      mergedCost as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
  };
  if (outcomeFromDisposition) {
    callUpdate.outcome = outcomeFromDisposition;
    callUpdate.outcome_source = "elevenlabs";
    callUpdate.goal_met = outcomeFromDisposition === "goal_met";
  }
  if (callDurationSecs) {
    callUpdate.duration_seconds = callDurationSecs;
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
  if (callError) {
    // Compensating delete: we claimed the idempotency row FIRST, but the
    // critical call-row update just failed (route returns 500). ElevenLabs will
    // retry — but the retry would hit the unique violation and dedupe away as a
    // "duplicate", permanently dropping the transcript/outcome/cost/callback
    // effects. Delete the row WE inserted (this conversation_id + event_type)
    // so the retry re-processes cleanly. Scoped to this invocation's row only;
    // the success path is untouched.
    await supabase
      .from("elevenlabs_webhook_events")
      .delete()
      .eq("conversation_id", conversationId)
      .eq("event_type", eventType);
    return { ok: false, reason: "could_not_update_call" };
  }

  // Pull the recording ourselves now that the call row is final. ElevenLabs
  // used to PUSH it as a base64 MP3 in the post_call_audio body, but Vercel
  // rejects bodies over 4.5 MB (HTTP 413) before the route runs, so most
  // calls over ~3 minutes never got one. Scheduled with after() so this
  // webhook still answers fast; the dialer tick's backfill sweep covers any
  // miss here (audio not ready yet, a network blip). Skipped when the payload
  // already handed us a recording location.
  if (!callUpdate.recording_path) {
    await scheduleRecordingFetch(supabase, {
      callId: call.id,
      conversationId,
    });
  }

  // Surface the identity the call heard (names, email) on the lead, filling
  // only fields the lead left BLANK — imported CSV data always wins, so a
  // mis-transcription can't overwrite a good value. Runs regardless of whether
  // a full conversation happened (a voicemail greeting can name the owner).
  // This reverses the earlier "never copy heard names/emails" rule (call-summary
  // rewrite, 2026-07-28) at the operator's request; the fill-blank-only guard
  // preserves the overwrite protection that rule was built for.
  await fillLeadIdentityFromCall(
    supabase,
    call.lead_id,
    extractedDataOf(payload.analysis) ?? {},
  );

  // The judgment fields + research answers (decision maker, sentiment, …) only
  // mean something when a human actually talked with us, so mirror those onto
  // the lead's custom fields only for a real conversation — never from a
  // voicemail, no-answer, or immediate hang-up.
  if (reachedHuman) {
    await applyExtractionToCustomFields(
      supabase,
      call.lead_id,
      extractedDataOf(payload.analysis) ?? {},
    );

    // Sticky lead-level "we reached the decision maker" flag for the Leads
    // table. Only ever set it TRUE (a later voicemail shouldn't un-reach a DM
    // we already spoke to), and only from a real conversation. Set it when the
    // AI explicitly flagged the DM, OR when the disposition definitionally means
    // we reached them (e.g. not_interested = the decision-maker declined) — the
    // AI rarely writes the standalone flag, so leaning on the outcome recovers
    // the many DM conversations it silently drops.
    if (
      callReachedDm(extractedDataOf(payload.analysis)) ||
      outcomeImpliesDm(outcomeFromDisposition)
    ) {
      await supabase
        .from("leads")
        .update({ decision_maker_reached: true })
        .eq("id", call.lead_id);
    }
  }

  // Keep the lead's call counters in sync with its calls. These used to be
  // recomputed ONLY when a call was deleted, so on a normally-completed call
  // they stayed at 0. Recompute from the calls table on every call:
  // call_attempts = every call placed; conversations = the calls that became a
  // real two-way conversation.
  await syncLeadCallCounters(supabase, call.lead_id);

  // Outcome-driven side effects: DNC insertion, callback row creation, and
  // lead-status transitions. Per BUILD_PLAN §8 outcome table:
  //   dnc / invalid_number / language_barrier → status=dnc, auto-DNC insert
  //   callback                                → status=callback, callbacks row
  //   everything else                         → handled by Step 24
  // Source the agreed callback time from the REAL payload shape via
  // extractedDataOf (data_collection_results.callback_datetime.value), which
  // also falls back to the legacy flat data_collection.callback_datetime. The
  // old code read only the legacy field, which real ElevenLabs payloads never
  // send — so an agreed callback always defaulted to tomorrow-10am.
  const extractedCallbackDatetime = extractedDataOf(
    payload.analysis,
  )?.callback_datetime;
  await applyOutcomeSideEffects(supabase, {
    callId: call.id,
    leadId: call.lead_id,
    campaignId: call.campaign_id,
    outcome: outcomeFromDisposition,
    callbackDatetime:
      typeof extractedCallbackDatetime === "string"
        ? extractedCallbackDatetime
        : null,
  });

  // Step 39: roll this connected call into the lead's per-campaign rolling
  // summary (lead_campaign_summaries) AND generate this call's callback pickup
  // note (calls.callback_notes). Both come from ONE gpt-5.4-mini pass over the
  // TRANSCRIPT — richer than ElevenLabs' terse recap, so the who/role/anchor
  // detail actually lands in the note. Mock without an OpenAI key. The merger
  // logs its own cost into cost_breakdown.openai on the call.
  // Same gate as the call's summary above: only a connected call has real
  // content worth summarizing (a voicemail / no-answer / hang-up is just the
  // agent's own words). We feed the transcript, falling back to the terse recap
  // (transcript_summary, legacy `summary`) when a transcript isn't present.
  const transcriptText = reachedHuman
    ? transcriptToText(payload.transcript)
    : "";
  const latestSummary =
    reachedHuman && typeof callSummary === "string" && callSummary.trim()
      ? callSummary
      : null;
  if (call.campaign_id && (transcriptText || latestSummary)) {
    const { cost } = await mergeLeadSummary({
      leadId: call.lead_id,
      campaignId: call.campaign_id,
      callId: call.id,
      transcript: transcriptText || null,
      latestSummary,
    });
    if (cost > 0) {
      // Bump cost_breakdown.openai on this call and recompute the total.
      const next = withRecomputedTotal({
        ...mergedCost,
        openai: Number((mergedCost.openai + cost).toFixed(4)),
      });
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
 *
 * We no longer ASK for this event (agents sync with send_audio=false and no
 * "audio" in the webhook events — see agents.ts): the base64 body blew past
 * Vercel's 4.5 MB request limit on any call over ~3 minutes, so recordings are
 * pulled from the API instead (recording-fetch.ts). This handler stays so an
 * agent that hasn't been re-synced yet still gets its short recordings stored.
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

  // Compensating delete for every failure below: we claimed the idempotency
  // row FIRST, so if we bail before the recording is stored a retry would
  // dedupe as "duplicate" and the recording would be lost for good. Release
  // the claim (this conversation's audio row only) so a later attempt —
  // ElevenLabs's retry, or our own API pull — can succeed.
  const releaseClaim = async () => {
    await supabase
      .from("elevenlabs_webhook_events")
      .delete()
      .eq("conversation_id", conversationId)
      .eq("event_type", "post_call_audio");
  };

  const call = await resolveCall(
    supabase,
    conversationId,
    extractEchoedCallIdFromBag(data.conversation_initiation_client_data) ??
      data.call_id ??
      null,
  );
  if (!call) {
    await releaseClaim();
    return { ok: true, status: "unknown_conversation" };
  }

  // Decode base64 MP3 → upload. Path keyed by call id so it's stable.
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data.full_audio, "base64");
  } catch {
    await releaseClaim();
    return { ok: false, reason: "bad_audio_encoding" };
  }
  const path = `${call.id}.mp3`;
  const { error: uploadError } = await supabase.storage
    .from("call-recordings")
    .upload(path, bytes, { contentType: "audio/mpeg", upsert: true });
  if (uploadError) {
    await releaseClaim();
    return { ok: false, reason: "could_not_store_audio" };
  }

  const { error: updateError } = await supabase
    .from("calls")
    .update({ recording_path: path, recording_fetch_error: null })
    .eq("id", call.id);
  if (updateError) {
    await releaseClaim();
    return { ok: false, reason: "could_not_update_call" };
  }

  return { ok: true, status: "applied" };
}

/**
 * Call-initiation-failure event (type=call_initiation_failure): the
 * telephony layer never connected. Mark the call failed and log a system
 * event to the system_events audit log. Idempotent per conversation.
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

  // FIX A (#6 / #8): mark the call failed AND run the retry engine so the lead
  // is rescheduled onto the proper 'failed' 2-day backoff. Without this the
  // lead kept its short claim-lease / placeholder next_call_at and got redialed
  // almost immediately, never reaching cool-off.
  await finalizeFailedCall(supabase, call.id);
  // A failed-to-connect call is still an attempt on the lead. This path never
  // reaches the transcription handler's recompute, so inbound callers who hung
  // up while we answered (and busy/no-answer outbound legs) were leaving the
  // lead's "Attempts" one short.
  await syncLeadCallCounters(supabase, call.lead_id);

  return { ok: true, status: "applied" };
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
export async function applyOutcomeSideEffects(
  supabase: SupabaseAdmin,
  input: {
    callId: string;
    leadId: string;
    campaignId: string;
    outcome: CallOutcome;
    callbackDatetime: string | null;
    /** Overrides the dnc_entries `reason` for a DNC-family outcome. The AI +
     *  human-call paths leave this unset (a real caller asked → 'dnc_requested');
     *  a manual outcome override passes 'manual' so the DNC page doesn't read
     *  "Caller requested" for something an operator set by hand. */
    dncReasonOverride?: "manual";
  },
): Promise<void> {
  // We just dialed this lead. A due callback is only FULFILLED when the call
  // actually connected to a human — pass the outcome so a voicemail / no-answer
  // leaves the callback PENDING (#23). Otherwise the callback would be wrongly
  // marked 'completed' here and the retry engine's voicemail-escalation ladder
  // (escalateCallbackVoicemail, run via applyRetryForCall below) would find no
  // pending callback and the lead would fall into the generic 2-day retry.
  await resolveDueCallbacksForLead(supabase, input.leadId, {
    outcome: input.outcome,
  });

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
    .select("business_phone, company, owner_id, timezone, calendly_event_uri")
    .eq("id", input.leadId)
    .single();
  if (!lead) return;

  // --- goal_met booking guard (booking campaigns only) ---
  // The "goal_met means an actual booking" rule is otherwise PROMPT-ONLY, and
  // the post-call LLM over-claims goal_met from a gatekeeper "I'll email the
  // owner" — permanently closing an un-won lead. Enforce it in code: for a
  // booking / fixed-time campaign, a goal_met with NO recorded registration is
  // downgraded to gatekeeper (retry) so we keep chasing. Non-booking campaigns
  // (e.g. research/survey) are untouched — their goal isn't a booking.
  if (input.outcome === "goal_met") {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("calendly_event_id, fixed_time_booking")
      .eq("id", input.campaignId)
      .maybeSingle();
    const isBookingCampaign = Boolean(
      campaign?.calendly_event_id || campaign?.fixed_time_booking,
    );
    if (isBookingCampaign && !lead.calendly_event_uri) {
      const { data: booking } = await supabase
        .from("calendly_events")
        .select("id")
        .eq("lead_id", input.leadId)
        .eq("status", "scheduled")
        .limit(1)
        .maybeSingle();
      if (!booking) {
        await supabase
          .from("calls")
          .update({ outcome: "gatekeeper", goal_met: false })
          .eq("id", input.callId);
        await supabase.from("system_events").insert({
          kind: "goal_met_downgraded_no_booking",
          ref_table: "calls",
          ref_id: input.callId,
          payload: { campaign_id: input.campaignId, lead_id: input.leadId },
        });
        // Reschedule as a normal gatekeeper (2-day retry) instead of closing.
        await supabase
          .from("calls")
          .update({ retry_applied_at: null })
          .eq("id", input.callId);
        await applyRetryForCall(input.callId);
        return;
      }
    }
  }

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

  // goal_met / transferred_to_human are TERMINAL — the lead is won, no more
  // calls. Clear next_call_at authoritatively here instead of leaning on the
  // retry engine: for a MANUAL call the engine usually already ran (FIX C, no
  // outcome yet) before the disposition, so its CAS lock no-ops and a stale
  // retry date is left behind (the Pure Balance Yoga bug). Mirrors how DNC is
  // handled explicitly just below.
  if (
    input.outcome === "goal_met" ||
    input.outcome === "transferred_to_human"
  ) {
    await supabase
      .from("leads")
      .update({
        status: "goal_met",
        next_call_at: null,
        resting_until: null,
        retry_counter: 0,
        retry_position: 0,
        call_back_later_count: 0,
      })
      .eq("id", input.leadId);
    return;
  }

  // --- DNC ---
  // Only override the reason when the outcome is genuinely DNC-family, so a
  // stray override can never turn a non-DNC outcome into a DNC insert.
  const baseDncReason = dncReasonForOutcome(input.outcome);
  const dncReason = baseDncReason
    ? (input.dncReasonOverride ?? baseDncReason)
    : null;
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

  // --- agent-scheduled callback (any disposition) ---
  // If the agent scheduled a callback mid-call (via the schedule_callback tool),
  // honor it no matter how the final disposition came out. A gatekeeper who says
  // "call back at 9 to reach the owner" is a real callback even though the
  // disposition is "gatekeeper" — without this the callback row exists but the
  // lead is never pointed at it and falls into the generic retry instead. DNC
  // already returned above; goal_met is terminal and keeps its own status.
  if (input.outcome !== "goal_met") {
    const { data: scheduledCallback } = await supabase
      .from("callbacks")
      .select("id, scheduled_at")
      .eq("originating_call_id", input.callId)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (scheduledCallback) {
      // A real `callback` outcome is an agreed appointment — honor its time
      // as-is, same-day included. But a "call back" the agent booked off a
      // NON-appointment disposition (gatekeeper, etc.) must never re-dial the
      // same number the SAME day — defer it to the next calling day. This is
      // what caused a gatekeeper at 3:40pm to be re-dialed at 5:45pm.
      if (input.outcome !== "callback") {
        const deferred = deferSameDayCallbackIso(
          scheduledCallback.scheduled_at,
          lead.timezone,
        );
        if (deferred !== scheduledCallback.scheduled_at) {
          await supabase
            .from("callbacks")
            .update({ scheduled_at: deferred })
            .eq("id", scheduledCallback.id);
        }
      }
      await supabase
        .from("leads")
        .update({ status: "callback" })
        .eq("id", input.leadId);
      await syncLeadNextCallToEarliestCallback(supabase, input.leadId);
      return;
    }
  }

  // --- callback ---
  if (input.outcome === "callback") {
    // Don't double-book. The in-call `schedule_callback` tool may have already
    // created a callback for THIS call (with the exact time the agent agreed).
    // If so, defer to it — just make sure the lead points at its earliest
    // pending callback — instead of inserting a second from our default time.
    const { data: alreadyBooked } = await supabase
      .from("callbacks")
      .select("id")
      .eq("originating_call_id", input.callId)
      .limit(1)
      .maybeSingle();
    if (alreadyBooked) {
      await syncLeadNextCallToEarliestCallback(supabase, input.leadId);
      return;
    }
    // Use the time the lead actually named; otherwise schedule for tomorrow
    // morning in the LEAD's timezone (a predictable, in-hours slot) rather than
    // copying the original call's arbitrary clock time. Pull the timezone once:
    // it both interprets an offset-less named time (so it isn't read as UTC) and
    // anchors the default slot.
    const { data: leadTz } = await supabase
      .from("leads")
      .select("timezone")
      .eq("id", input.leadId)
      .maybeSingle();
    // Lead-local wall clock; the model's offset is ignored (see
    // parseLeadLocalDatetime).
    const parsed = parseLeadLocalDatetime(
      input.callbackDatetime,
      leadTz?.timezone,
    );
    // Honor the exact time the lead named, weekends included (agreed callbacks
    // dial on weekends now). Only the DEFAULT slot (no time given) rolls to a
    // weekday via nextDayLocalHourIso.
    const scheduledAt = parsed
      ? parsed.toISOString()
      : nextDayLocalHourIso(leadTz?.timezone, 10);

    await supabase.from("callbacks").insert({
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      originating_call_id: input.callId,
      scheduled_at: scheduledAt,
      status: "pending",
      // created_by left null — the agent auto-scheduled this.
    });
    // Point the lead at its EARLIEST pending callback (this one, or a sooner
    // still-pending one) so a later callback can't strand an earlier overdue
    // one out of the dial queue.
    await syncLeadNextCallToEarliestCallback(supabase, input.leadId);
    return;
  }

  // Everything else routes through the retry engine: voicemail / no_answer
  // / gatekeeper / not_interested / ai_receptionist / goal_met / etc. The
  // engine is the single source of truth for retry_counter / retry_position
  // / status / next_call_at / resting_until and is idempotent on the call,
  // so it's safe even if the Twilio webhook beat us to it.
  await applyRetryForCall(input.callId);
}
