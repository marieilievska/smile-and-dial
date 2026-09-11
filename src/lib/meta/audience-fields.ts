import "server-only";

import { CANADA_AREA_CODES } from "@/lib/dialer/nanp-states";

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

export type LeadForAudience = {
  business_email: string | null;
  business_phone: string | null;
  city: string | null;
  state: string | null;
};

/** US or CA, or null when the phone has a country code other than +1. CA when
 *  the state is a Canadian province OR the phone's area code is Canadian;
 *  otherwise US.
 *
 *  A "+" then anything but 1 is a foreign country code, the rule toE164UsCa
 *  uses (#518): "+354 611 1234" is Iceland, not Quebec's 354. US and CA would
 *  both be guesses, so it gets null, which leaves Meta's COUNTRY cell empty.
 *  A US state doesn't overrule that (imports have filled one in from those
 *  same foreign digits); a province does, since nothing derives one from a
 *  phone.
 *
 *  Canadian area codes come from the dialer's shared map. The private copy
 *  this file used to keep fell 16 codes behind. */
export function deriveCountry(lead: LeadForAudience): "US" | "CA" | null {
  const st = (lead.state ?? "").trim().toLowerCase();
  if (CA_PROVINCES.has(st)) return "CA";
  const withPlus = (lead.business_phone ?? "").replace(/[^\d+]/g, "");
  if (withPlus.startsWith("+") && !withPlus.startsWith("+1")) return null;
  const digits = (lead.business_phone ?? "").replace(/\D/g, "");
  const ac =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1, 4)
      : digits.length === 10
        ? digits.slice(0, 3)
        : "";
  if (ac && CANADA_AREA_CODES.has(ac)) return "CA";
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
