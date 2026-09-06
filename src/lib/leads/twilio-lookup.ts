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
export function isLookupLive(): boolean {
  return (
    process.env.TWILIO_LIVE === "live" ||
    process.env.TWILIO_LOOKUP_MODE === "live"
  );
}

/**
 * Outcome of one lookup. `billed` is true ONLY when Twilio answered 2xx — the
 * only case it charges for a Line Type Intelligence package. A mock result,
 * a missing-credentials short-circuit, a 404 (number does not exist), a 429
 * or any other error, and a network failure all cost nothing and must not
 * reach the spend ledger.
 */
export type LookupResult = { type: LineType; billed: boolean };

/** A line type Twilio actually decided. "unknown" is the absence of one. */
export type DefinitiveLineType = Exclude<LineType, "unknown">;

const DEFINITIVE: ReadonlySet<string> = new Set([
  "landline",
  "mobile",
  "voip",
  "invalid",
]);

export function isDefinitiveLineType(v: unknown): v is DefinitiveLineType {
  return typeof v === "string" && DEFINITIVE.has(v);
}

/**
 * Classify a phone number's line type via Twilio Lookup.
 *
 * Real Twilio lookups cost money, so they only run in live mode. Otherwise a
 * deterministic mock is used — this keeps tests free and prevents accidental
 * spend during development.
 */
export async function lookupLineType(phone: string): Promise<LookupResult> {
  if (!isLookupLive()) {
    return { type: mockLineType(phone), billed: false };
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

/**
 * Turn a Twilio Lookup v2 HTTP status + JSON body into a LookupResult. Pure,
 * so the billed/unbilled boundary is unit-tested without a network:
 *   404          → invalid, not billed (Twilio: no such number; no package sold)
 *   other non-2xx → unknown, not billed (429 rate limit, 5xx, auth errors…)
 *   2xx          → billed; valid:false → invalid, else by line_type_intelligence
 */
export function classifyLookupResponse(
  status: number,
  body: unknown,
): LookupResult {
  if (status === 404) return { type: "invalid", billed: false };
  if (status < 200 || status >= 300) return { type: "unknown", billed: false };

  const parsed = (body && typeof body === "object" ? body : {}) as {
    valid?: boolean;
    line_type_intelligence?: { type?: string | null } | null;
  };
  if (parsed.valid === false) return { type: "invalid", billed: true };

  const type = parsed.line_type_intelligence?.type ?? "";
  if (type === "mobile") return { type: "mobile", billed: true };
  if (type === "fixedVoip" || type === "nonFixedVoip") {
    return { type: "voip", billed: true };
  }
  if (!type) return { type: "unknown", billed: true };
  return { type: "landline", billed: true };
}

async function liveLineType(phone: string): Promise<LookupResult> {
  const sid = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  // No credentials → no request was made → nothing to bill.
  if (!sid || !secret) return { type: "unknown", billed: false };

  try {
    const auth = Buffer.from(`${sid}:${secret}`).toString("base64");
    const res = await fetch(
      `${LOOKUP_URL}/${encodeURIComponent(phone)}` +
        "?Fields=line_type_intelligence",
      { headers: { Authorization: `Basic ${auth}` } },
    );
    let body: unknown = null;
    if (res.ok) {
      try {
        body = await res.json();
      } catch {
        body = null;
      }
    }
    return classifyLookupResponse(res.status, body);
  } catch {
    return { type: "unknown", billed: false };
  }
}

// ---------------------------------------------------------------------------
// Lookup planning — pure helpers shared by the import analysis and its tests.
// ---------------------------------------------------------------------------

/**
 * The unique E.164 phones that still need a Twilio call: nulls (no parseable
 * phone) are dropped, a number repeated in the file is kept once, and any
 * number already in `known` is skipped. Order = first appearance, so a
 * concurrency pool processes them in file order.
 */
export function phonesNeedingLookup(
  e164s: readonly (string | null)[],
  known: ReadonlyMap<string, LineType>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const phone of e164s) {
    if (!phone || seen.has(phone) || known.has(phone)) continue;
    seen.add(phone);
    out.push(phone);
  }
  return out;
}

/**
 * Per-row line types, aligned to `e164s` by index, from a phone → type map.
 * A row with no phone, or a phone nothing resolved, is "unknown".
 */
export function lineTypesForRows(
  e164s: readonly (string | null)[],
  known: ReadonlyMap<string, LineType>,
): LineType[] {
  return e164s.map((phone) =>
    phone ? (known.get(phone) ?? "unknown") : "unknown",
  );
}

/**
 * Accept a client-supplied phone → line type record (the wizard's memory of
 * earlier analyses) as a Map, keeping only E.164 US/CA keys with a definitive
 * type. "unknown" is dropped on purpose: it would suppress a lookup that
 * could still resolve the number, and anything else is not a line type.
 */
export function sanitizeKnownLineTypes(
  input: Record<string, unknown> | null | undefined,
): Map<string, LineType> {
  const out = new Map<string, LineType>();
  if (!input || typeof input !== "object") return out;
  for (const [phone, type] of Object.entries(input)) {
    if (!isUsCaNumber(phone) || !isDefinitiveLineType(type)) continue;
    out.set(phone, type);
  }
  return out;
}
