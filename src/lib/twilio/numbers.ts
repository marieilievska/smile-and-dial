/**
 * Twilio phone-number management. Real Twilio calls cost money (numbers are
 * billed monthly), so they only run when TWILIO_LIVE=live. Otherwise a free
 * deterministic mock is used, keeping tests and development at zero cost.
 */

export type AvailableNumber = {
  phoneNumber: string;
  friendlyName: string;
  monthlyCost: number;
};

export type Country = "US" | "CA";

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

// Twilio's number search doesn't return price; this is a reasonable estimate.
const ESTIMATED_MONTHLY_COST = 1.15;

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
      monthlyCost: ESTIMATED_MONTHLY_COST,
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
      monthlyCost: ESTIMATED_MONTHLY_COST,
    }));
    return { numbers, error: null };
  } catch {
    return { numbers: [], error: "Twilio search failed." };
  }
}
