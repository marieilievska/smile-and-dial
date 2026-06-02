import type { LineType } from "./import-fields";

const LOOKUP_URL = "https://lookups.twilio.com/v2/PhoneNumbers";

/** True for US/Canada numbers in E.164 form (`+1` followed by 10 digits). */
export function isUsCaNumber(phone: string): boolean {
  return /^\+1\d{10}$/.test(phone.replace(/[^\d+]/g, ""));
}

/**
 * Coerce a US/Canada phone number into E.164 (`+1XXXXXXXXXX`), the format
 * Twilio Lookup and outbound dialing both require. CSV exports commonly carry
 * pretty formats like "(205) 259-8928" or bare 10-digit "2052598928" with no
 * country code; without this they'd fail the US/CA check, skip the lookup
 * (so no line type, no cost), and later fail to dial. Returns null when the
 * value can't be a US/CA number (e.g. an international or malformed number),
 * in which case the caller imports it as-is.
 */
export function toE164UsCa(phone: string): string | null {
  const cleaned = phone.replace(/[^\d+]/g, "");
  if (/^\+1\d{10}$/.test(cleaned)) return cleaned; // already E.164
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * True when real Twilio Lookups should run. Lookup goes live whenever Twilio
 * is live for the workspace (`TWILIO_LIVE=live`) — the same flag that gates
 * number search/purchase — so a live deployment verifies numbers for real
 * without needing a second flag set. `TWILIO_LOOKUP_MODE=live` is still
 * honoured for backward compatibility. Per-import spend control lives in the
 * "Skip number verification" toggle, not here.
 */
function isLookupLive(): boolean {
  return (
    process.env.TWILIO_LIVE === "live" ||
    process.env.TWILIO_LOOKUP_MODE === "live"
  );
}

/**
 * Classify a phone number's line type via Twilio Lookup.
 *
 * Real Twilio lookups cost money, so they only run in live mode. Otherwise a
 * deterministic mock is used — this keeps tests free and prevents accidental
 * spend during development.
 */
export async function lookupLineType(phone: string): Promise<LineType> {
  if (!isLookupLive()) {
    return mockLineType(phone);
  }
  return liveLineType(phone);
}

/**
 * Deterministic stand-in for Twilio Lookup. The line type is encoded in the
 * number prefix so tests can rely on it:
 *   `+1700…` → mobile, `+1999…` → invalid, anything else → landline.
 */
function mockLineType(phone: string): LineType {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("1700")) return "mobile";
  if (digits.startsWith("1999")) return "invalid";
  return "landline";
}

async function liveLineType(phone: string): Promise<LineType> {
  const sid = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  if (!sid || !secret) return "unknown";

  try {
    const auth = Buffer.from(`${sid}:${secret}`).toString("base64");
    const res = await fetch(
      `${LOOKUP_URL}/${encodeURIComponent(phone)}` +
        "?Fields=line_type_intelligence",
      { headers: { Authorization: `Basic ${auth}` } },
    );
    if (res.status === 404) return "invalid";
    if (!res.ok) return "unknown";

    const body = (await res.json()) as {
      valid?: boolean;
      line_type_intelligence?: { type?: string | null } | null;
    };
    if (body.valid === false) return "invalid";

    const type = body.line_type_intelligence?.type ?? "";
    if (type === "mobile") return "mobile";
    if (type === "fixedVoip" || type === "nonFixedVoip") return "voip";
    if (!type) return "unknown";
    return "landline";
  } catch {
    return "unknown";
  }
}
