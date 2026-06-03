import "server-only";

/** Place outbound calls via ElevenLabs' NATIVE Twilio integration.
 *
 *  Why not a home-grown bridge? We previously dialed Twilio directly and
 *  returned `<Connect><Stream>` TwiML pointing at an ElevenLabs signed URL.
 *  That never worked: Twilio Media Streams and the ElevenLabs conversation
 *  socket speak different protocols, so every call dropped within seconds and
 *  no conversation ever started.
 *
 *  ElevenLabs supports Twilio natively: you import your Twilio number into the
 *  workspace once (POST /v1/convai/phone-numbers → phone_number_id), then ask
 *  ElevenLabs to place the call (POST /v1/convai/twilio/outbound-call). It dials
 *  through your Twilio account, owns the media end-to-end, runs the agent, and
 *  fires the post-call webhook (correlated back to our row via the call_id we
 *  pass as a dynamic variable). This is how every other Referrizer agent runs.
 *
 *  All real API calls are guarded by `ELEVENLABS_LIVE === "live"`. In mock mode
 *  (tests / default) the helpers return deterministic fakes so the pipeline has
 *  something to write without touching ElevenLabs or Twilio.
 */

const ELEVENLABS_BASE = "https://api.elevenlabs.io";

function isLive(): boolean {
  return process.env.ELEVENLABS_LIVE === "live";
}

function elevenLabsApiKey(): string | null {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
}

export type ImportNumberInput = {
  phoneNumber: string;
  label: string;
  twilioSid: string;
  twilioToken: string;
};

export type ImportNumberResult =
  | { ok: true; phoneNumberId: string }
  | { ok: false; error: string };

/** Import a Twilio number into the ElevenLabs workspace, returning the
 *  phone_number_id used as agent_phone_number_id when placing calls. Done once
 *  per number, then cached on twilio_numbers.elevenlabs_phone_number_id. */
export async function importTwilioNumberToElevenLabs(
  input: ImportNumberInput,
): Promise<ImportNumberResult> {
  if (!isLive()) {
    return { ok: true, phoneNumberId: `phnum_mock_${input.phoneNumber}` };
  }
  const apiKey = elevenLabsApiKey();
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY is not set." };

  try {
    const res = await fetch(`${ELEVENLABS_BASE}/v1/convai/phone-numbers`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        phone_number: input.phoneNumber,
        label: input.label,
        provider: "twilio",
        sid: input.twilioSid,
        token: input.twilioToken,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `ElevenLabs number import failed (${res.status})${detail ? ` ${detail.slice(0, 200)}` : ""}.`,
      };
    }
    const body = (await res.json()) as { phone_number_id?: string };
    if (!body.phone_number_id) {
      return {
        ok: false,
        error: "ElevenLabs response missing phone_number_id.",
      };
    }
    return { ok: true, phoneNumberId: body.phone_number_id };
  } catch {
    return { ok: false, error: "ElevenLabs number import request failed." };
  }
}

export type PlaceCallInput = {
  /** Our internal call_id. Passed to ElevenLabs as a dynamic variable so the
   *  post-call webhook can resolve our `calls` row deterministically. */
  callId: string;
  /** The lead's phone, E.164. */
  toNumber: string;
  /** The agent to run (agents.elevenlabs_agent_id). */
  elevenlabsAgentId: string;
  /** The imported Twilio number to dial from
   *  (twilio_numbers.elevenlabs_phone_number_id). */
  elevenlabsPhoneNumberId: string;
  /** Extra dynamic variables to personalize the conversation. call_id is added
   *  automatically. */
  dynamicVariables?: Record<string, string | number | boolean | null>;
};

export type PlaceCallResult =
  | { ok: true; twilioCallSid: string | null; conversationId: string | null }
  | { ok: false; error: string };

/** Ask ElevenLabs to place one outbound call through Twilio. Mocked unless
 *  ELEVENLABS_LIVE=live. */
export async function placeAgentCall(
  input: PlaceCallInput,
): Promise<PlaceCallResult> {
  if (!isLive()) {
    // Deterministic-looking fakes so the rest of the pipeline has something to
    // write. Tests never run live.
    return {
      ok: true,
      twilioCallSid: `CA${input.callId.replace(/-/g, "").slice(0, 32)}`,
      conversationId: `conv_mock_${input.callId.replace(/-/g, "").slice(0, 24)}`,
    };
  }
  const apiKey = elevenLabsApiKey();
  if (!apiKey) return { ok: false, error: "ELEVENLABS_API_KEY is not set." };

  try {
    const res = await fetch(
      `${ELEVENLABS_BASE}/v1/convai/twilio/outbound-call`,
      {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: input.elevenlabsAgentId,
          agent_phone_number_id: input.elevenlabsPhoneNumberId,
          to_number: input.toNumber,
          conversation_initiation_client_data: {
            dynamic_variables: {
              call_id: input.callId,
              ...(input.dynamicVariables ?? {}),
            },
          },
        }),
      },
    );
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      message?: string;
      conversation_id?: string | null;
      callSid?: string | null;
    } | null;
    if (!res.ok || !body || body.success === false) {
      const detail = body?.message || `status ${res.status}`;
      return {
        ok: false,
        error: `ElevenLabs outbound call failed (${detail}).`,
      };
    }
    return {
      ok: true,
      twilioCallSid: body.callSid ?? null,
      conversationId: body.conversation_id ?? null,
    };
  } catch {
    return { ok: false, error: "ElevenLabs outbound call request failed." };
  }
}
