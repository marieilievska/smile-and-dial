import "server-only";

import { hashCity, hashCountry, hashEmail, hashPhone, hashState } from "./hash";

/** The Meta customer-list schema we upload, in column order. CT = city,
 *  ST = state/province, COUNTRY = 2-letter country. */
export const META_SCHEMA = ["EMAIL", "PHONE", "CT", "ST", "COUNTRY"] as const;

/** Canadian provinces/territories (2-letter). Used to derive country = CA. */
const CA_PROVINCES = new Set([
  "ab",
  "bc",
  "mb",
  "nb",
  "nl",
  "ns",
  "nt",
  "nu",
  "on",
  "pe",
  "qc",
  "sk",
  "yt",
]);

/** Canadian area codes (subset is fine — anything not matched defaults to US,
 *  which is correct for this US-heavy list). */
const CA_AREA_CODES = new Set([
  "204",
  "226",
  "236",
  "249",
  "250",
  "289",
  "306",
  "343",
  "365",
  "403",
  "416",
  "418",
  "431",
  "437",
  "438",
  "450",
  "506",
  "514",
  "519",
  "548",
  "579",
  "581",
  "587",
  "604",
  "613",
  "639",
  "647",
  "672",
  "705",
  "709",
  "778",
  "780",
  "782",
  "807",
  "819",
  "825",
  "867",
  "873",
  "902",
  "905",
]);

export type LeadForAudience = {
  business_email: string | null;
  business_phone: string | null;
  city: string | null;
  state: string | null;
};

/** US or CA. CA when the state is a Canadian province OR the phone's area code
 *  is Canadian; otherwise US. */
export function deriveCountry(lead: LeadForAudience): "US" | "CA" {
  const st = (lead.state ?? "").trim().toLowerCase();
  if (CA_PROVINCES.has(st)) return "CA";
  const digits = (lead.business_phone ?? "").replace(/\D/g, "");
  const ac =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1, 4)
      : digits.length === 10
        ? digits.slice(0, 3)
        : "";
  if (ac && CA_AREA_CODES.has(ac)) return "CA";
  return "US";
}

/** A lead as one hashed row aligned to META_SCHEMA. */
export function leadToHashedRow(lead: LeadForAudience): string[] {
  return [
    hashEmail(lead.business_email),
    hashPhone(lead.business_phone),
    hashCity(lead.city),
    hashState(lead.state),
    hashCountry(deriveCountry(lead)),
  ];
}
