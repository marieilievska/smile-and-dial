import "server-only";

/**
 * Hang up a live call at the Twilio layer.
 *
 * ElevenLabs' own `end_call` is not a reliable way to get rid of a caller: any
 * caller speech while a tool is pending makes ElevenLabs abandon it, and the
 * tool result comes back as the literal string "Tool execution was abandoned
 * due to user input". On 2026-09-11 a caller defeated the agent's loop-breaker
 * TWICE by chanting "I have a question" over the goodbye, and held the line for
 * 843 seconds. The friendlier the sign-off, the wider the window to barge in —
 * so any hangup that depends on the agent finishing a turn is cancellable.
 *
 * Terminating the Twilio call resource happens where the caller's voice has no
 * vote. Mirrors the credential shape in lib/twilio/numbers.ts (an API key +
 * secret against the account SID) and is a no-op off-live, so tests and
 * development can never drop a real call.
 */
const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

export type HangUpResult = { ok: boolean; error: string | null };

function isLive(): boolean {
  return process.env.TWILIO_LIVE === "live";
}

function twilioAuth(): { account: string; header: string } | null {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!account || !keySid || !keySecret) return null;
  return {
    account,
    header: "Basic " + Buffer.from(`${keySid}:${keySecret}`).toString("base64"),
  };
}

/**
 * End the call with this Twilio CallSid, now.
 *
 * Never throws: callers use this on a live call and must be able to carry on
 * (logging the failure) whatever Twilio says. A missing CallSid is reported
 * rather than silently succeeding — it means the call row never got one, which
 * is a real gap worth seeing in the audit trail.
 */
export async function hangUpCall(callSid: string): Promise<HangUpResult> {
  const sid = callSid.trim();
  if (!sid) return { ok: false, error: "No Twilio CallSid on this call." };
  if (!isLive()) return { ok: true, error: null };
  const auth = twilioAuth();
  if (!auth) return { ok: false, error: "Twilio credentials aren't set." };

  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/Calls/${encodeURIComponent(sid)}.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ Status: "completed" }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        error: `Twilio ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    return { ok: true, error: null };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Hangup failed.",
    };
  }
}
