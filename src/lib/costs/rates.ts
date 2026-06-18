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

/** Price a gpt-4o-mini completion from its token usage. Returns USD (4 dp). */
export function priceOpenAiTokens(
  promptTokens: number,
  completionTokens: number,
): number {
  const input =
    (Math.max(0, promptTokens) / 1_000_000) * gpt4oMiniInputUsdPerMillion();
  const output =
    (Math.max(0, completionTokens) / 1_000_000) *
    gpt4oMiniOutputUsdPerMillion();
  return Number((input + output).toFixed(4));
}

/** Price Whisper transcription from audio duration. Returns USD (4 dp). */
export function priceWhisper(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, durationSeconds ?? 0);
  return Number(((secs / 60) * whisperUsdPerMinute()).toFixed(4));
}
