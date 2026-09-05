import "server-only";

/**
 * Read-only access to Twilio's Usage Records — what the sub-account was
 * actually billed for a category over a period. Used by the daily cost-rate
 * refresh to derive the real $/minute (and $/lookup) instead of trusting a
 * constant.
 *
 *   GET /2010-04-01/Accounts/{sid}/Usage/Records/{ThisMonth|LastMonth}.json
 *       ?Category=calls-outbound
 *   -> usage_records[0]: { usage: "8959", usage_unit: "minutes",
 *                          price: "107.748", price_unit: "usd", count: "7560" }
 *
 * Verified live 2026-09-05. Authenticates with the same API key SID/secret the
 * number-management code uses (numbers.ts). Never throws — returns null on any
 * failure so the refresh can skip that rate and keep the previous one.
 */

export type TwilioUsageCategory =
  | "calls-outbound"
  | "calls-inbound"
  | "calls-media-stream-minutes"
  | "lookups";

export type TwilioUsagePeriod = "ThisMonth" | "LastMonth";

export type TwilioUsageRecord = {
  category: string;
  /** Billable units (minutes for calls / media streams, lookups for lookups). */
  usage: number;
  usageUnit: string;
  /** What Twilio charged for that usage, USD. */
  price: number;
  /** Number of calls / streams / lookups. */
  count: number;
  startDate: string | null;
  endDate: string | null;
};

function twilioUsageAuth(): { account: string; header: string } | null {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const keySid = process.env.TWILIO_API_KEY_SID;
  const keySecret = process.env.TWILIO_API_KEY_SECRET;
  if (!account || !keySid || !keySecret) return null;
  return {
    account,
    header: "Basic " + Buffer.from(`${keySid}:${keySecret}`).toString("base64"),
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Parse Twilio's `usage_records` body into the first record, or null. Pure —
 *  exported so the refresh's derivation can be unit-tested on a fixture. */
export function parseTwilioUsageBody(body: unknown): TwilioUsageRecord | null {
  if (!body || typeof body !== "object") return null;
  const records = (body as { usage_records?: unknown }).usage_records;
  if (!Array.isArray(records) || records.length === 0) return null;
  const r = records[0] as Record<string, unknown>;
  if (!r || typeof r !== "object") return null;
  return {
    category: typeof r.category === "string" ? r.category : "",
    usage: num(r.usage),
    usageUnit: typeof r.usage_unit === "string" ? r.usage_unit : "",
    price: num(r.price),
    count: num(r.count),
    startDate: typeof r.start_date === "string" ? r.start_date : null,
    endDate: typeof r.end_date === "string" ? r.end_date : null,
  };
}

export async function fetchTwilioUsage(
  category: TwilioUsageCategory,
  period: TwilioUsagePeriod,
): Promise<TwilioUsageRecord | null> {
  const auth = twilioUsageAuth();
  if (!auth) return null;
  try {
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(auth.account)}` +
      `/Usage/Records/${period}.json?Category=${encodeURIComponent(category)}`;
    const res = await fetch(url, {
      headers: { Authorization: auth.header },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return parseTwilioUsageBody((await res.json()) as unknown);
  } catch {
    return null;
  }
}
