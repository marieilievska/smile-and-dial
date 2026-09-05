/**
 * Single source of truth for every per-unit cost in the product.
 *
 * Pure module (no "use server", no DB imports) — importable from server libs,
 * route handlers, the analytics layer, client components (the import wizard
 * shows an estimate) and the unit tests alike.
 *
 * Resolution order for the provider rates (ElevenLabs $/credit, Twilio voice /
 * media-stream / lookup):
 *
 *   1. the EFFECTIVE rate the daily refresh derived from the provider's own
 *      billing (table `cost_rates`, loaded into this module by
 *      lib/costs/effective-rates.ts — call `primeEffectiveRates()` first);
 *   2. an env override (so a live value can be corrected without a deploy);
 *   3. the hard-coded default below, which is what the providers were
 *      actually charging on 2026-09-05.
 *
 * Twilio number rental and the OpenAI rates are env → default only: the
 * rental is a negotiated flat fee and OpenAI publishes its token prices.
 */

/** Read a non-negative number from an env var, falling back to `fallback`. */
function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

// ---------------------------------------------------------------------------
// Effective (provider-derived) rates
// ---------------------------------------------------------------------------

/** The rates the daily refresh derives from the providers' own billing. Each
 *  is optional: a missing key falls through to env → default. */
export type EffectiveRates = {
  elevenlabs_usd_per_credit: number;
  twilio_outbound_usd_per_min: number;
  twilio_inbound_usd_per_min: number;
  twilio_media_stream_usd_per_min: number;
  twilio_lookup_usd: number;
};

export const EFFECTIVE_RATE_KEYS = [
  "elevenlabs_usd_per_credit",
  "twilio_outbound_usd_per_min",
  "twilio_inbound_usd_per_min",
  "twilio_media_stream_usd_per_min",
  "twilio_lookup_usd",
] as const satisfies readonly (keyof EffectiveRates)[];

export type EffectiveRateKey = (typeof EFFECTIVE_RATE_KEYS)[number];

let effective: Partial<EffectiveRates> = {};

/** Install the stored effective rates (called by primeEffectiveRates). Only
 *  finite, non-negative numbers are kept; anything else falls through. */
export function setEffectiveRates(rates: Partial<EffectiveRates>): void {
  const next: Partial<EffectiveRates> = {};
  for (const k of EFFECTIVE_RATE_KEYS) {
    const v = rates[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) next[k] = v;
  }
  effective = next;
}

/** Forget the installed effective rates (tests; the refresh route after an
 *  upsert, so the next prime re-reads the table). */
export function clearEffectiveRates(): void {
  effective = {};
}

/** A snapshot of what is currently installed (diagnostics). */
export function currentEffectiveRates(): Partial<EffectiveRates> {
  return { ...effective };
}

function rate(key: EffectiveRateKey, env: string, fallback: number): number {
  const stored = effective[key];
  if (typeof stored === "number") return stored;
  return envNum(env, fallback);
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

/** Twilio OUTBOUND voice, USD per minute (billed per whole minute, rounded
 *  up). 2026-09-05 sub-account usage: 8,947 min → $107.61 = $0.01203/min. */
export function twilioOutboundUsdPerMinute(): number {
  return rate(
    "twilio_outbound_usd_per_min",
    "TWILIO_VOICE_USD_PER_MINUTE",
    0.01203,
  );
}

/** Twilio INBOUND voice, USD per minute. 2026-09-05: 367 min → $2.50 =
 *  $0.0068/min. */
export function twilioInboundUsdPerMinute(): number {
  return rate(
    "twilio_inbound_usd_per_min",
    "TWILIO_INBOUND_USD_PER_MINUTE",
    0.0068,
  );
}

/** Twilio Media Streams, USD per minute. ElevenLabs-native telephony streams
 *  the audio through Twilio's <Stream>, which Twilio bills as
 *  `calls-media-stream-minutes` ON TOP of the call minutes — on every
 *  ElevenLabs call, inbound or outbound. 2026-09-05: 9,278 min → $40.82 =
 *  $0.0044/min. */
export function twilioMediaStreamUsdPerMinute(): number {
  return rate(
    "twilio_media_stream_usd_per_min",
    "TWILIO_MEDIA_STREAM_USD_PER_MINUTE",
    0.0044,
  );
}

/** @deprecated direction-blind alias kept for older callers; prefer
 *  twilioOutboundUsdPerMinute / twilioInboundUsdPerMinute. */
export function twilioVoiceUsdPerMinute(): number {
  return twilioOutboundUsdPerMinute();
}

/** Twilio Lookup (Line Type Intelligence), USD per lookup. Twilio's list price
 *  is $0.008; the refresh derives the real figure from usage once there is
 *  any (none this month as of 2026-09-05). */
export function twilioLookupUsd(): number {
  return rate("twilio_lookup_usd", "TWILIO_LOOKUP_USD", 0.008);
}

/** Twilio phone-number rental, USD per month. A negotiated deal — env →
 *  default only, never derived from usage. Do not change the default. */
export function twilioNumberMonthlyUsd(): number {
  return envNum("TWILIO_NUMBER_MONTHLY_COST", 0.04);
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

/** ElevenLabs Conversational AI, USD per credit. The credit figure bundles
 *  voice (TTS/ASR) + LLM + telephony — ElevenLabs does not break it out.
 *
 *  PLAN-DEPENDENT. The convention is the amortized rate: monthly plan price ÷
 *  credits included in the plan, both read off the live account:
 *
 *      GET https://api.elevenlabs.io/v1/user/subscription
 *      -> next_invoice.amount_due_cents  (plan price, cents)
 *         character_limit                (credits included; EL renamed
 *                                         characters to credits, field didn't)
 *
 *  History:
 *    Pro    $99  / 500,000   = 0.000198
 *    Scale  $299 / 1,800,000 = 0.00016611   (2026-08-03)
 *    Scale  $990 / 6,269,494 = 0.00015791   (verified live 2026-09-05)
 *
 *  The daily refresh keeps this current; the default is the last verified
 *  figure. Historical `calls.cost_breakdown` rows are deliberately NOT
 *  re-priced on a plan change: a call placed on the old plan really did cost
 *  the old rate. */
export function elevenLabsUsdPerCredit(): number {
  return rate(
    "elevenlabs_usd_per_credit",
    "ELEVENLABS_USD_PER_CREDIT",
    0.00015791,
  );
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

/** OpenAI Whisper transcription, USD per minute of audio. */
export function whisperUsdPerMinute(): number {
  return envNum("OPENAI_WHISPER_USD_PER_MINUTE", 0.006);
}

/** OpenAI Responses API `web_search` tool, USD per search call. OpenAI bills
 *  the tool per call on top of tokens; this is an ESTIMATE (the published
 *  per-call price for the low-context tier), env-overridable. Used by the
 *  demo_front_desk live research. */
export function openAiWebSearchUsdPerCall(): number {
  return envNum("OPENAI_WEB_SEARCH_USD_PER_CALL", 0.01);
}

/** gpt-4o-mini input tokens, USD per 1,000,000 tokens. */
export function gpt4oMiniInputUsdPerMillion(): number {
  return envNum("OPENAI_GPT4OMINI_USD_PER_1M_INPUT", 0.15);
}

/** gpt-4o-mini output tokens, USD per 1,000,000 tokens. */
export function gpt4oMiniOutputUsdPerMillion(): number {
  return envNum("OPENAI_GPT4OMINI_USD_PER_1M_OUTPUT", 0.6);
}

/** gpt-5.4 input tokens, USD per 1,000,000 tokens (Call Reviewer's Pass 2). */
export function gpt54InputUsdPerMillion(): number {
  return envNum("OPENAI_GPT54_USD_PER_1M_INPUT", 2.5);
}

/** gpt-5.4 output tokens, USD per 1,000,000 tokens. */
export function gpt54OutputUsdPerMillion(): number {
  return envNum("OPENAI_GPT54_USD_PER_1M_OUTPUT", 15);
}

/** gpt-5.4-mini input tokens, USD per 1,000,000 tokens (Reviewer's Pass 1 and
 *  the rolling-summary writer). */
export function gpt54MiniInputUsdPerMillion(): number {
  return envNum("OPENAI_GPT54MINI_USD_PER_1M_INPUT", 0.75);
}

/** gpt-5.4-mini output tokens, USD per 1,000,000 tokens. */
export function gpt54MiniOutputUsdPerMillion(): number {
  return envNum("OPENAI_GPT54MINI_USD_PER_1M_OUTPUT", 4.5);
}

/** Per-1M input/output token rates for a chat model. Falls back to the
 *  gpt-4o-mini rates for any model we don't explicitly price, so an unknown or
 *  env-overridden model name never silently prices at $0. Check the more
 *  specific "gpt-5.4-mini" before the bare "gpt-5.4" prefix. */
function tokenRatesForModel(model: string): { input: number; output: number } {
  const m = model.trim().toLowerCase();
  if (m.startsWith("gpt-5.4-mini")) {
    return {
      input: gpt54MiniInputUsdPerMillion(),
      output: gpt54MiniOutputUsdPerMillion(),
    };
  }
  if (m.startsWith("gpt-5.4")) {
    return {
      input: gpt54InputUsdPerMillion(),
      output: gpt54OutputUsdPerMillion(),
    };
  }
  return {
    input: gpt4oMiniInputUsdPerMillion(),
    output: gpt4oMiniOutputUsdPerMillion(),
  };
}

// ---------------------------------------------------------------------------
// Pricing helpers
// ---------------------------------------------------------------------------

export type CallDirection = "inbound" | "outbound";

/** Twilio bills per whole minute, rounded UP: a 61-second call is 2 minutes. */
export function billableMinutes(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, Math.floor(durationSeconds ?? 0));
  return secs === 0 ? 0 : Math.ceil(secs / 60);
}

/** Normalize a stored `calls.direction` to a pricing direction (anything
 *  that isn't literally "inbound" is priced as outbound). */
export function pricingDirection(
  direction: string | null | undefined,
): CallDirection {
  return direction === "inbound" ? "inbound" : "outbound";
}

/** Price the Twilio VOICE leg of a call from its duration and direction.
 *  Returns USD rounded to 4 dp. Direction defaults to outbound. */
export function priceTwilioCall(
  durationSeconds: number | null | undefined,
  direction: string | null | undefined = "outbound",
): number {
  const minutes = billableMinutes(durationSeconds);
  if (minutes === 0) return 0;
  const perMin =
    pricingDirection(direction) === "inbound"
      ? twilioInboundUsdPerMinute()
      : twilioOutboundUsdPerMinute();
  return Number((minutes * perMin).toFixed(4));
}

/** Price the Twilio MEDIA STREAM of an ElevenLabs-native call: the same
 *  whole-minute count as the voice leg, at the media-stream rate. Zero for a
 *  zero-length call. */
export function priceTwilioMediaStream(
  durationSeconds: number | null | undefined,
): number {
  const minutes = billableMinutes(durationSeconds);
  if (minutes === 0) return 0;
  return Number((minutes * twilioMediaStreamUsdPerMinute()).toFixed(4));
}

/** Everything Twilio bills for one ElevenLabs-native call: the voice leg
 *  (direction-aware) plus the media stream. Returns the parts and their sum
 *  (USD, 4 dp) so the call row can store both the total and the split. */
export function priceElevenLabsNativeTwilio(
  durationSeconds: number | null | undefined,
  direction: string | null | undefined,
): { call: number; mediaStream: number; total: number } {
  const call = priceTwilioCall(durationSeconds, direction);
  const mediaStream = priceTwilioMediaStream(durationSeconds);
  return { call, mediaStream, total: Number((call + mediaStream).toFixed(4)) };
}

/** Price ElevenLabs credits at the effective $/credit. USD, 4 dp. */
export function priceElevenLabsCredits(
  credits: number | null | undefined,
): number {
  const c =
    typeof credits === "number" && Number.isFinite(credits) ? credits : 0;
  if (c <= 0) return 0;
  return Number((c * elevenLabsUsdPerCredit()).toFixed(4));
}

/** Price a chat completion from its token usage. `model` selects the rate:
 *  gpt-5.4 and gpt-5.4-mini are priced at their own rates; anything else (the
 *  default) falls back to gpt-4o-mini. Returns USD (4 dp). */
export function priceOpenAiTokens(
  promptTokens: number,
  completionTokens: number,
  model = "gpt-4o-mini",
): number {
  const rate = tokenRatesForModel(model);
  const input = (Math.max(0, promptTokens) / 1_000_000) * rate.input;
  const output = (Math.max(0, completionTokens) / 1_000_000) * rate.output;
  return Number((input + output).toFixed(4));
}

/** Price Whisper transcription from audio duration. Returns USD (4 dp). */
export function priceWhisper(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, durationSeconds ?? 0);
  return Number(((secs / 60) * whisperUsdPerMinute()).toFixed(4));
}
