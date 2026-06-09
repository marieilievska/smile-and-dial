import "server-only";

import { createHash } from "node:crypto";

/** SHA-256 hex of an already-normalized value. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash a value, or return "" for empty input (Meta skips empty cells). */
function hashOrEmpty(normalized: string): string {
  return normalized ? sha256(normalized) : "";
}

/** email: trim + lowercase. */
export function hashEmail(raw: string | null | undefined): string {
  return hashOrEmpty((raw ?? "").trim().toLowerCase());
}

/** phone: digits only, keep country code (E.164 "+1.." -> "1.."). */
export function hashPhone(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  return hashOrEmpty(digits);
}

/** city: lowercase, strip everything but a-z. */
export function hashCity(raw: string | null | undefined): string {
  return hashOrEmpty((raw ?? "").toLowerCase().replace(/[^a-z]/g, ""));
}

/** US state / CA province: lowercase 2-letter code. Passes through any
 *  already-2-letter value; otherwise empties (we store 2-letter codes). */
export function hashState(raw: string | null | undefined): string {
  const v = (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  return hashOrEmpty(v.length === 2 ? v : "");
}

/** country: 2-letter ISO lowercase ("us" / "ca"). */
export function hashCountry(raw: string | null | undefined): string {
  return hashOrEmpty(
    (raw ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, ""),
  );
}
