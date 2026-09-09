/**
 * Twilio phone-number management. Real Twilio calls cost money (numbers are
 * billed monthly), so they only run when TWILIO_LIVE=live. Otherwise a free
 * deterministic mock is used, keeping tests and development at zero cost.
 *
 * Round L2 — gained `pointNumberWebhooks` and `listOwnedNumbers` so the
 * Twilio Numbers admin page can (a) auto-wire freshly purchased numbers
 * at our Vercel deployment, and (b) show every number in the Twilio
 * account, not just the ones bought through the app.
 */

import { twilioNumberMonthlyUsd } from "@/lib/costs/rates";

export type AvailableNumber = {
  phoneNumber: string;
  friendlyName: string;
  monthlyCost: number;
};

/** One number returned by Twilio's IncomingPhoneNumbers listing, after
 *  mapping to the shape we use in the UI. The `voiceUrl` /
 *  `statusCallback` strings come straight from Twilio so they tell us
 *  whether the number is currently routed to our deployment or
 *  somewhere else (e.g. a different environment, or unset). */
export type OwnedNumber = {
  twilioSid: string;
  phoneNumber: string;
  friendlyName: string;
  voiceUrl: string | null;
  statusCallback: string | null;
};

/** The minimum needed to reason about a number the account owns: which one it
 *  is, and enough to tell its country. `phoneNumber` is nullable because it is
 *  Twilio's field and we never assume a payload shape we did not check. */
export type OwnedNumberRef = {
  sid: string;
  phoneNumber: string | null;
};

export type Country = "US" | "CA";

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

// Twilio's number-search API doesn't return your account's price (and the
// Pricing API only returns list price, not negotiated rates), so the monthly
// cost shown on search results is an estimate. The rate lives in the central
// rates module, and it is PER COUNTRY: the negotiated $0.04 is US-only, while
// Canadian numbers bill at the full $1.15. Passing the country is what keeps a
// mixed pool's recorded rental from reading at a fifth of the real bill.
function estimatedMonthlyCost(country: Country): number {
  return twilioNumberMonthlyUsd(country);
}

function isLive(): boolean {
  return process.env.TWILIO_LIVE === "live";
}

/** Format a +1XXXXXXXXXX number as (XXX) XXX-XXXX. */
function formatUsNumber(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return e164;
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

/** The webhook endpoints every in-service Twilio number must point at.
 *
 *  Inbound is ElevenLabs-NATIVE: ElevenLabs answers the call directly with the
 *  agent assigned to the number, so the Twilio VoiceUrl + StatusCallback must
 *  point at ElevenLabs — NOT at this app. The app used to expose a
 *  `/api/twilio/voice-inbound` Media Streams bridge, and pointing a number back
 *  at it re-broke inbound (Twilio Media Streams ≠ EL's convai socket: it
 *  answered, logged an empty `calls` row, and dropped the caller — the #222
 *  regression that silently killed every inbound call to a number; see the
 *  lesson in place-call.ts). That bridge has since been deleted, so the app no
 *  longer answers inbound voice at all. These are constants (no deployment URL
 *  needed), so unlike the old app-relative URLs this can never be null. */
export function expectedNumberWebhooks(): {
  voiceUrl: string;
  statusCallback: string;
} {
  return {
    voiceUrl: "https://api.elevenlabs.io/twilio/inbound_call",
    statusCallback: "https://api.elevenlabs.io/twilio/status-callback",
  };
}

/** Point a Twilio number's webhooks at ElevenLabs' native inbound endpoints
 *  (so EL answers inbound directly with the number's assigned agent). Used both
 *  immediately after purchase and from the admin "Point to ElevenLabs" button.
 *  Mocked unless TWILIO_LIVE=live so tests don't hit Twilio. */
export async function pointNumberWebhooks(twilioSid: string): Promise<{
  voiceUrl: string | null;
  statusCallback: string | null;
  error: string | null;
}> {
  const urls = expectedNumberWebhooks();
  if (!isLive()) {
    // In mock mode we still return the URLs the caller would have
    // pointed at, so the DB writes the expected values and the UI
    // can show "webhooks ok" without round-tripping Twilio.
    return {
      voiceUrl: urls.voiceUrl,
      statusCallback: urls.statusCallback,
      error: null,
    };
  }
  const auth = twilioAuth();
  if (!auth) {
    return {
      voiceUrl: null,
      statusCallback: null,
      error: "Twilio is not configured.",
    };
  }
  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers/${twilioSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          VoiceUrl: urls.voiceUrl,
          VoiceMethod: "POST",
          StatusCallback: urls.statusCallback,
          StatusCallbackMethod: "POST",
        }),
      },
    );
    if (!res.ok) {
      return {
        voiceUrl: null,
        statusCallback: null,
        error: `Twilio webhook update failed (${res.status}).`,
      };
    }
    return {
      voiceUrl: urls.voiceUrl,
      statusCallback: urls.statusCallback,
      error: null,
    };
  } catch {
    return {
      voiceUrl: null,
      statusCallback: null,
      error: "Twilio webhook update failed.",
    };
  }
}

/** Set a number's FriendlyName on Twilio so the console matches the name
 *  the admin gave it in-app. Best-effort and mocked unless TWILIO_LIVE=live;
 *  the in-app name (stored in our DB) is the source of truth either way, so a
 *  failure here never blocks the rename. */
export async function setNumberFriendlyName(
  twilioSid: string | null,
  friendlyName: string,
): Promise<{ error: string | null }> {
  if (!isLive() || !twilioSid) return { error: null };
  const auth = twilioAuth();
  if (!auth) return { error: "Twilio is not configured." };
  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers/${twilioSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ FriendlyName: friendlyName }),
      },
    );
    if (!res.ok) return { error: `Twilio rename failed (${res.status}).` };
    return { error: null };
  } catch {
    return { error: "Twilio rename failed." };
  }
}

/** List every IncomingPhoneNumber on the Twilio account. The result
 *  feeds the "Sync from Twilio" flow on the admin page so admins can
 *  see (and adopt) numbers bought outside Smile & Dial. Mocked
 *  unless TWILIO_LIVE=live. */
export async function listOwnedNumbers(): Promise<{
  numbers: OwnedNumber[];
  error: string | null;
}> {
  if (!isLive()) return { numbers: [], error: null };
  const auth = twilioAuth();
  if (!auth) return { numbers: [], error: "Twilio is not configured." };
  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers.json?PageSize=200`,
      { headers: { Authorization: auth.header } },
    );
    if (!res.ok) {
      return { numbers: [], error: `Twilio listing failed (${res.status}).` };
    }
    const body = (await res.json()) as {
      incoming_phone_numbers?: {
        sid: string;
        phone_number: string;
        friendly_name?: string;
        voice_url?: string;
        status_callback?: string;
      }[];
    };
    const numbers = (body.incoming_phone_numbers ?? []).map((n) => ({
      twilioSid: n.sid,
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name || "",
      voiceUrl: n.voice_url?.trim() || null,
      statusCallback: n.status_callback?.trim() || null,
    }));
    return { numbers, error: null };
  } catch {
    return { numbers: [], error: "Twilio listing failed." };
  }
}

/** Upper bound on number pages walked, so a malformed `next_page_uri` can
 *  never loop forever (50 × 200 = 10,000 numbers, far beyond the pool). */
const MAX_NUMBER_PAGES = 50;

/**
 * Every IncomingPhoneNumber the account currently owns — SID and E.164 —
 * following Twilio's `next_page_uri` so a pool larger than one page is seen in
 * full.
 *
 * Unlike `listOwnedNumbers` this NEVER reports an empty list without having
 * actually read Twilio: mock mode and a missing config are errors here, not
 * `{ [], null }`. The SHAKEN reconcile is the caller, and it treats an empty
 * read as "the account owns nothing, remove every assignment" — so "we didn't
 * look" and "there is nothing there" must not arrive as the same answer.
 *
 * The phone number rides along because the caller has to tell US numbers from
 * Canadian ones: SHAKEN/STIR is a US framework and the Trust Hub rejects a
 * Canadian number, so signing one is a permanent, repeating failure rather than
 * a transient one. A SID alone cannot answer that question.
 */
export async function listOwnedNumberRefs(): Promise<{
  refs: OwnedNumberRef[];
  error: string | null;
}> {
  if (!isLive()) return { refs: [], error: "Twilio is not live." };
  const auth = twilioAuth();
  if (!auth) return { refs: [], error: "Twilio is not configured." };
  try {
    const refs: OwnedNumberRef[] = [];
    let next: string | null =
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers.json?PageSize=200`;
    for (let page = 0; next && page < MAX_NUMBER_PAGES; page++) {
      const res = await fetch(next, {
        headers: { Authorization: auth.header },
      });
      if (!res.ok) {
        return { refs: [], error: `Twilio listing failed (${res.status}).` };
      }
      const body = (await res.json()) as {
        incoming_phone_numbers?: { sid: string; phone_number?: string }[];
        next_page_uri?: string | null;
      };
      for (const n of body.incoming_phone_numbers ?? []) {
        refs.push({ sid: n.sid, phoneNumber: n.phone_number ?? null });
      }
      // Twilio returns the next page as a path relative to the API host.
      next = body.next_page_uri
        ? `https://api.twilio.com${body.next_page_uri}`
        : null;
    }
    return { refs, error: null };
  } catch {
    return { refs: [], error: "Twilio listing failed." };
  }
}

/** Search for purchasable numbers. Mocked unless TWILIO_LIVE=live.
 *
 *  `limit` is how many candidates to ask Twilio for. It used to be pinned at 10,
 *  which silently capped every bulk buy at 10 numbers however many were
 *  requested (the pool batch limit is 25). Twilio accepts a PageSize up to 1000;
 *  we clamp to a sane range. */
export async function searchAvailableNumbers(
  country: Country,
  areaCode: string,
  limit = 10,
): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(limit) || 10));
  if (!isLive()) {
    return { numbers: mockSearch(country, areaCode, pageSize), error: null };
  }
  return liveSearch(country, areaCode, pageSize);
}

/** Purchase a number. Mocked unless TWILIO_LIVE=live. */
export async function purchaseTwilioNumber(
  phoneNumber: string,
): Promise<{ twilioSid: string | null; error: string | null }> {
  if (!isLive()) return { twilioSid: null, error: null };

  const auth = twilioAuth();
  if (!auth) return { twilioSid: null, error: "Twilio is not configured." };
  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ PhoneNumber: phoneNumber }),
      },
    );
    if (!res.ok) {
      // Surface Twilio's own message. Canadian numbers in particular fail for
      // actionable reasons — they require a validated local Canadian address
      // (no P.O. boxes or virtual addresses) and sometimes a regulatory bundle.
      // A bare "purchase failed" sends the operator hunting for a bug that
      // isn't there.
      let detail = "";
      try {
        const body = (await res.json()) as { message?: string; code?: number };
        detail = body.message ? ` ${body.message}` : "";
        if (body.code) detail += ` (Twilio code ${body.code})`;
      } catch {
        /* non-JSON error body — the status alone will have to do */
      }
      return {
        twilioSid: null,
        error: `Twilio purchase failed (${res.status}).${detail}`,
      };
    }
    const body = (await res.json()) as { sid?: string };
    return { twilioSid: body.sid ?? null, error: null };
  } catch {
    return { twilioSid: null, error: "Twilio purchase failed." };
  }
}

/** Release a number back to Twilio. Mocked unless TWILIO_LIVE=live. */
export async function releaseTwilioNumber(
  twilioSid: string | null,
): Promise<{ error: string | null }> {
  if (!isLive() || !twilioSid) return { error: null };

  const auth = twilioAuth();
  if (!auth) return { error: "Twilio is not configured." };
  try {
    const res = await fetch(
      `${TWILIO_API}/${auth.account}/IncomingPhoneNumbers/${twilioSid}.json`,
      { method: "DELETE", headers: { Authorization: auth.header } },
    );
    if (!res.ok && res.status !== 404) {
      return { error: "Twilio release failed." };
    }
    return { error: null };
  } catch {
    return { error: "Twilio release failed." };
  }
}

/**
 * Deterministic stand-in for Twilio's number search. Returns five numbers in
 * the requested area code (defaulting to 415 for US, 416 for CA).
 */
function mockSearch(
  country: Country,
  areaCode: string,
  limit = 5,
): AvailableNumber[] {
  const ac = /^\d{3}$/.test(areaCode)
    ? areaCode
    : country === "CA"
      ? "416"
      : "415";
  return Array.from({ length: Math.min(limit, 5) }, (_, index) => {
    const phoneNumber = `+1${ac}555${1000 + index}`;
    return {
      phoneNumber,
      friendlyName: formatUsNumber(phoneNumber),
      monthlyCost: estimatedMonthlyCost(country),
    };
  });
}

async function liveSearch(
  country: Country,
  areaCode: string,
  pageSize: number,
): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  const auth = twilioAuth();
  if (!auth) return { numbers: [], error: "Twilio is not configured." };
  try {
    const url = new URL(
      `${TWILIO_API}/${auth.account}/AvailablePhoneNumbers/${country}/Local.json`,
    );
    if (/^\d{3}$/.test(areaCode)) url.searchParams.set("AreaCode", areaCode);
    url.searchParams.set("PageSize", String(pageSize));

    const res = await fetch(url, { headers: { Authorization: auth.header } });
    if (!res.ok) return { numbers: [], error: "Twilio search failed." };

    const body = (await res.json()) as {
      available_phone_numbers?: {
        phone_number: string;
        friendly_name: string;
      }[];
    };
    const numbers = (body.available_phone_numbers ?? []).map((n) => ({
      phoneNumber: n.phone_number,
      friendlyName: n.friendly_name,
      monthlyCost: estimatedMonthlyCost(country),
    }));
    return { numbers, error: null };
  } catch {
    return { numbers: [], error: "Twilio search failed." };
  }
}
