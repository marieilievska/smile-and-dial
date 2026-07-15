/**
 * Single source of truth for every per-unit cost in the product. Each rate has
 * an env-overridable default so a live value can be corrected without a deploy.
 * Pure module (no "use server") — importable from server libs, route handlers,
 * and the analytics layer alike.
 */

/** Read a non-negative number from an env var, falling back to `fallback`. */
function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Twilio outbound voice, USD per minute (Twilio bills per whole minute). */
export function twilioVoiceUsdPerMinute(): number {
  return envNum("TWILIO_VOICE_USD_PER_MINUTE", 0.0185);
}

/** ElevenLabs Conversational AI, USD per credit. The credit figure bundles
 *  voice (TTS/ASR) + LLM + telephony — ElevenLabs does not break it out. */
export function elevenLabsUsdPerCredit(): number {
  return envNum("ELEVENLABS_USD_PER_CREDIT", 0.000198);
}

/** Twilio Lookup (Line Type Intelligence), USD per lookup. */
export function twilioLookupUsd(): number {
  return envNum("TWILIO_LOOKUP_USD", 0.005);
}

/** Twilio phone-number rental, USD per month. */
export function twilioNumberMonthlyUsd(): number {
  return envNum("TWILIO_NUMBER_MONTHLY_COST", 0.04);
}

/** OpenAI Whisper transcription, USD per minute of audio. */
export function whisperUsdPerMinute(): number {
  return envNum("OPENAI_WHISPER_USD_PER_MINUTE", 0.006);
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

/** Price a Twilio voice call from its duration. Twilio bills per whole minute,
 *  rounded UP, so a 61-second call is 2 minutes. Returns USD rounded to 4 dp. */
export function priceTwilioCall(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, Math.floor(durationSeconds ?? 0));
  if (secs === 0) return 0;
  const minutes = Math.ceil(secs / 60);
  return Number((minutes * twilioVoiceUsdPerMinute()).toFixed(4));
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
