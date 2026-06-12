/**
 * OpenAI features — the "Ask Smile" assistant, the AI agent-drafter, the
 * rolling per-lead summary merge, and call transcription/summarization — go
 * LIVE whenever an OpenAI API key is configured. This mirrors the "live when
 * the credential is present" rule the Twilio Lookup already uses, so there's no
 * separate OPENAI_LIVE flag to remember to set in production (a flag that has
 * silently left these features in mock mode before).
 *
 * Returns the trimmed key, or null when no key is set — in which case callers
 * fall back to their deterministic mock behaviour.
 */
export function openAiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key ? key : null;
}
