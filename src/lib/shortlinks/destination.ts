/** Pure URL handling for the in-call link shortener. No I/O, so the rules that
 *  actually bite — encoding a business name containing `&`, not clobbering the
 *  author's own UTMs, omitting values we don't have — are unit-tested.
 *
 *  The template author pastes a plain link into the campaign's SMS/email
 *  template; we attach the lead's details to it at send time. */

/** The per-lead parameters we attach to the pasted link. Keys are exactly the
 *  parameter names the presell page reads. */
export type LeadLinkParams = {
  business_name?: string | null;
  phone?: string | null;
  email?: string | null;
  google_place_id?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
};

/** Trailing characters that are almost always sentence punctuation rather than
 *  part of the URL ("...the link: https://x.com/." → the dot isn't the URL). */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** Percent-encode a parameter value, including the `!'()*` that
 *  encodeURIComponent leaves raw. Matches the presell API's documented examples
 *  (an apostrophe as %27) and stays safe if a link is ever placed in markup. */
function encodeValue(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The first http(s) URL in a rendered message, or null when there isn't one.
 * Only the first is shortened — a template is expected to carry one link, and
 * silently rewriting several would be surprising.
 */
export function findFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/);
  if (!match) return null;
  const trimmed = match[0].replace(TRAILING_PUNCTUATION, "");
  return trimmed || null;
}

/**
 * Attach the lead's parameters to `url`, returning the full destination.
 *
 * Two rules, both deliberate:
 *  - a parameter already present in the pasted URL is left alone, so an author
 *    who wrote their own `utm_campaign` keeps it;
 *  - empty/missing values are omitted entirely rather than sent as `key=`.
 *    The presell page treats every parameter as optional and shows a
 *    placeholder for absent ones, but an empty value can render as a
 *    filled-but-blank field.
 *
 * The original URL is preserved verbatim and additions are appended, so the
 * author's own encoding is never rewritten. Values are encoded with
 * encodeURIComponent (spaces become %20, matching the presell API's documented
 * examples) rather than URLSearchParams (which would emit `+`).
 *
 * Returns the input unchanged when it isn't a parsable absolute URL.
 */
export function withLeadParams(url: string, params: LeadLinkParams): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const additions: string[] = [];
  for (const [key, raw] of Object.entries(params)) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    if (parsed.searchParams.has(key)) continue;
    additions.push(`${key}=${encodeValue(value)}`);
  }
  if (additions.length === 0) return url;

  // Append before any #fragment, which must stay last to survive.
  const hashAt = url.indexOf("#");
  const base = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}${additions.join("&")}${fragment}`;
}

/** A human-readable label for the shortener's admin dashboard, so a click is
 *  traceable to a campaign and business without opening our database. */
export function shortLinkLabel(args: {
  campaignName?: string | null;
  company?: string | null;
  channel: "sms" | "email";
}): string {
  return [
    "smiledial",
    args.campaignName?.trim() || "no campaign",
    args.company?.trim() || "unknown business",
    args.channel,
  ].join(" | ");
}
