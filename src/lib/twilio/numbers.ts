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

import { appBaseUrl } from "@/lib/app-url";

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

export type Country = "US" | "CA";

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

// Twilio's number-search API doesn't return your account's price (and the
// Pricing API only returns list price, not negotiated rates), so the monthly
// cost shown on search results is an estimate. Set TWILIO_NUMBER_MONTHLY_COST
// to your real per-number monthly cost to make it accurate; defaults to
// Twilio's US local list price.
function estimatedMonthlyCost(): number {
  const raw = Number(process.env.TWILIO_NUMBER_MONTHLY_COST);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1.15;
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

/** Build the webhook URLs this deployment expects on every Twilio
 *  number. Resolved via `appBaseUrl()` (NEXT_PUBLIC_APP_URL, else the
 *  Vercel production domain) so a deployment routes to itself even when
 *  NEXT_PUBLIC_APP_URL was never set. Returns null when nothing resolves
 *  so the caller can surface "deployment URL isn't configured" instead of
 *  pointing numbers at a string like "undefined/api/twilio/voice-inbound". */
export function appWebhookUrls(): {
  voiceUrl: string;
  statusCallback: string;
} | null {
  const base = appBaseUrl();
  if (!base) return null;
  return {
    voiceUrl: `${base}/api/twilio/voice-inbound`,
    statusCallback: `${base}/api/twilio/status`,
  };
}

/** Point a Twilio number's webhooks at this deployment. Used both
 *  immediately after purchase and from the admin "Repoint webhooks"
 *  button. Mocked unless TWILIO_LIVE=live so tests don't hit Twilio. */
export async function pointNumberWebhooks(twilioSid: string): Promise<{
  voiceUrl: string | null;
  statusCallback: string | null;
  error: string | null;
}> {
  if (!isLive()) {
    // In mock mode we still return the URLs the caller would have
    // pointed at, so the DB writes the expected values and the UI
    // can show "webhooks ok" without round-tripping Twilio.
    const urls = appWebhookUrls();
    return {
      voiceUrl: urls?.voiceUrl ?? null,
      statusCallback: urls?.statusCallback ?? null,
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
  const urls = appWebhookUrls();
  if (!urls) {
    return {
      voiceUrl: null,
      statusCallback: null,
      error: "NEXT_PUBLIC_APP_URL isn't set on this deployment.",
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

/** Search for purchasable numbers. Mocked unless TWILIO_LIVE=live. */
export async function searchAvailableNumbers(
  country: Country,
  areaCode: string,
): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  if (!isLive()) {
    return { numbers: mockSearch(country, areaCode), error: null };
  }
  return liveSearch(country, areaCode);
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
    if (!res.ok) return { twilioSid: null, error: "Twilio purchase failed." };
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
function mockSearch(country: Country, areaCode: string): AvailableNumber[] {
  const ac = /^\d{3}$/.test(areaCode)
    ? areaCode
    : country === "CA"
      ? "416"
      : "415";
  return Array.from({ length: 5 }, (_, index) => {
    const phoneNumber = `+1${ac}555${1000 + index}`;
    return {
      phoneNumber,
      friendlyName: formatUsNumber(phoneNumber),
      monthlyCost: estimatedMonthlyCost(),
    };
  });
}

async function liveSearch(
  country: Country,
  areaCode: string,
): Promise<{ numbers: AvailableNumber[]; error: string | null }> {
  const auth = twilioAuth();
  if (!auth) return { numbers: [], error: "Twilio is not configured." };
  try {
    const url = new URL(
      `${TWILIO_API}/${auth.account}/AvailablePhoneNumbers/${country}/Local.json`,
    );
    if (/^\d{3}$/.test(areaCode)) url.searchParams.set("AreaCode", areaCode);
    url.searchParams.set("PageSize", "10");

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
      monthlyCost: estimatedMonthlyCost(),
    }));
    return { numbers, error: null };
  } catch {
    return { numbers: [], error: "Twilio search failed." };
  }
}
