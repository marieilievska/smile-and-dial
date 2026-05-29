import "server-only";

/** Round L4 — bridge a Twilio call to an ElevenLabs Convai agent over
 *  Media Streams.
 *
 *  Flow:
 *    1. Caller answers (or we answer the inbound).
 *    2. Twilio fetches our TwiML URL.
 *    3. We call ElevenLabs `/v1/convai/conversation/get_signed_url`
 *       with the agent's id to receive a single-use `wss://` URL.
 *    4. We return TwiML that bridges the call's audio to that URL via
 *       `<Connect><Stream/>`.
 *    5. ElevenLabs runs the conversation: ASR + LLM + TTS + tool
 *       calls. Twilio relays audio in both directions.
 *
 *  Signed URLs are short-lived (~30s last time we checked) so they
 *  must be generated just-in-time on every call answer. The TwiML
 *  itself is returned synchronously to Twilio; we never persist the
 *  signed URL anywhere.
 *
 *  All real API calls are guarded by `ELEVENLABS_LIVE === "live"`.
 *  In mock mode the helper returns null so the caller can fall back
 *  to the L3 placeholder TwiML (`<Say>this is a test call</Say>`).
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

function fetchApiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

/** XML-escape a string for embedding in TwiML. The signed URL itself
 *  is already safe (no XML reserved characters in ElevenLabs's
 *  `wss://api.elevenlabs.io/v1/convai/conversation?...` format), but
 *  the helper escapes anyway as defence-in-depth in case ElevenLabs
 *  changes their URL structure. */
function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type SignedUrlResult =
  | { ok: true; signedUrl: string }
  | { ok: false; error: string };

/** Mint a single-use signed conversation URL for the given agent.
 *  Mocked (returns ok=false with a noop reason) when
 *  ELEVENLABS_LIVE != live. The caller is expected to fall back to a
 *  placeholder TwiML in that case. */
export async function getConvaiSignedUrl(
  elevenlabsAgentId: string,
): Promise<SignedUrlResult> {
  if (!isLive()) {
    return { ok: false, error: "elevenlabs-live-not-enabled" };
  }
  const apiKey = fetchApiKey();
  if (!apiKey) {
    return { ok: false, error: "ELEVENLABS_API_KEY is not set." };
  }
  try {
    const res = await fetch(
      `${ELEVENLABS_BASE}/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(elevenlabsAgentId)}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": apiKey,
          Accept: "application/json",
        },
      },
    );
    if (!res.ok) {
      return {
        ok: false,
        error: `ElevenLabs signed-url request failed (${res.status}).`,
      };
    }
    const body = (await res.json()) as { signed_url?: string };
    if (!body.signed_url) {
      return {
        ok: false,
        error: "ElevenLabs response missing signed_url.",
      };
    }
    return { ok: true, signedUrl: body.signed_url };
  } catch {
    return { ok: false, error: "ElevenLabs signed-url request failed." };
  }
}

/** Build the TwiML that bridges a Twilio call to an ElevenLabs agent.
 *  Returns null when the signed-URL fetch fails so the caller can
 *  fall back to a placeholder TwiML rather than dropping the call
 *  with a parse error. */
export async function buildBridgeTwiml(input: {
  elevenlabsAgentId: string;
}): Promise<string | null> {
  const signed = await getConvaiSignedUrl(input.elevenlabsAgentId);
  if (!signed.ok) return null;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Connect>` +
    `<Stream url="${xml(signed.signedUrl)}"/>` +
    `</Connect>` +
    `</Response>`
  );
}
