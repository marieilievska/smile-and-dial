import type { LineType } from "./import-fields";

const LOOKUP_URL = "https://lookups.twilio.com/v2/PhoneNumbers";

/** True for US/Canada numbers in E.164 form (`+1` followed by 10 digits). */
export function isUsCaNumber(phone: string): boolean {
  return /^\+1\d{10}$/.test(phone.replace(/[^\d+]/g, ""));
}

/**
 * Classify a phone number's line type via Twilio Lookup.
 *
 * Real Twilio lookups cost money, so they only run when
 * `TWILIO_LOOKUP_MODE=live` is set. Otherwise a deterministic mock is used —
 * this keeps tests free and prevents accidental spend during development.
 */
export async function lookupLineType(phone: string): Promise<LineType> {
  if (process.env.TWILIO_LOOKUP_MODE !== "live") {
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
