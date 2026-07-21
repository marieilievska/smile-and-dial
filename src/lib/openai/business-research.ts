import "server-only";

/**
 * Live business research behind the `demo_front_desk` tool.
 *
 * The agent calls that tool mid-call to role-play the prospect's own front
 * desk, so it needs a short, accurate, SPEAKABLE brief about a business we
 * usually know almost nothing about — in production the vast majority of leads
 * carry only a company name and a city.
 *
 * We therefore go to the web (OpenAI Responses API + its `web_search` tool)
 * rather than to our own columns. Everything here degrades to a generic brief
 * instead of failing: the caller is on the phone, so "no answer" must still be
 * an answer the agent can speak.
 *
 * The pure functions are exported separately from `researchBusiness` (the only
 * one that touches the network) so they can be unit-tested offline.
 */

/** Hosts that are directories/social pages rather than a business's own site.
 *  Matched on the registrable-ish domain, so "maps.google.com" and "google.com"
 *  both hit while "googlenails.com" does not. */
const DIRECTORY_HOSTS = [
  "google.",
  "yelp.",
  "facebook.",
  "instagram.",
  "tripadvisor.",
  "yellowpages.",
  "mapquest.",
  "linkedin.",
  "bing.",
];

/** The bare domain to pin a web search to ("https://www.Foo.com/x" → "foo.com").
 *  Null when we have nothing usable, in which case the search runs open. */
export function researchDomain(
  website: string | null | undefined,
): string | null {
  const raw = website?.trim();
  if (!raw) return null;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withProtocol).hostname.toLowerCase();
    const bare = host.startsWith("www.") ? host.slice(4) : host;
    // A hostname with no dot is a local/invalid name, not a business site.
    return bare.includes(".") ? bare : null;
  } catch {
    return null;
  }
}

/** The business's OWN site origin from a research source URL, or null when the
 *  source was a directory listing. We store this on `leads.website`, and that
 *  column is what pins the NEXT research run — so letting a Yelp URL in would
 *  quietly degrade every future search for that lead. */
export function ownSiteOrigin(sourceUrl: string | null): string | null {
  const domain = researchDomain(sourceUrl);
  if (!domain) return null;
  const isDirectory = DIRECTORY_HOSTS.some(
    (h) => domain.startsWith(h) || domain.includes(`.${h}`),
  );
  return isDirectory ? null : `https://${domain}`;
}

export type ResearchInputs = {
  company: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  /** Anything the caller volunteered on the call. Treated as authoritative —
   *  it comes from the owner's own mouth, seconds ago. */
  heardOnCall: string | null;
};

/** What the agent role-plays from. Every field is short enough to say out loud. */
export type FrontDeskBrief = {
  /** False when research could not confirm it found the RIGHT business. The
   *  agent keeps the demo general in that case. */
  found: boolean;
  business_name_spoken: string;
  what_they_do: string;
  services: string[];
  common_caller_reasons: string[];
  receptionist_greeting: string;
  /** Things the agent must NOT state because research could not verify them. */
  do_not_claim: string[];
  source_url: string | null;
};

/** True of practically every local service business, so it is safe to assume
 *  when research found nothing. */
const GENERIC_CALLER_REASONS = [
  "booking or changing an appointment",
  "hours and location",
  "what something costs",
];

/** With no verified facts, everything specific is off-limits. Prices and hours
 *  lead the list: they are what an owner catches instantly. */
const UNVERIFIED_CLAIMS = [
  "prices",
  "opening hours",
  "specific services",
  "staff names",
];

/** The brief we return when research fails, times out, or can't identify the
 *  business. Deliberately still usable — the caller is mid-conversation, so an
 *  empty answer is worse than a general one. */
export function fallbackBrief(inputs: ResearchInputs): FrontDeskBrief {
  const company = inputs.company?.trim() ?? "";
  return {
    found: false,
    business_name_spoken: company || "the business",
    what_they_do: inputs.heardOnCall?.trim() ?? "",
    services: [],
    common_caller_reasons: [...GENERIC_CALLER_REASONS],
    receptionist_greeting: company
      ? `Thanks for calling ${company}, how can I help you?`
      : "Thanks for calling, how can I help you?",
    do_not_claim: [...UNVERIFIED_CLAIMS],
    source_url: null,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Clean a model-supplied list: strings only, trimmed, no blanks, capped. */
function strArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

/**
 * Turn whatever the model returned into a complete brief.
 *
 * Two rules: a `found: false` (or unparseable) answer falls back WHOLESALE
 * rather than field-by-field — a half-identified business is worse than an
 * honestly generic one — and any individual field that comes back blank is
 * filled from the fallback so the agent never has to speak an empty string.
 */
export function buildFrontDeskBrief(
  inputs: ResearchInputs,
  parsed: unknown,
): FrontDeskBrief {
  const base = fallbackBrief(inputs);
  if (!parsed || typeof parsed !== "object") return base;
  const p = parsed as Record<string, unknown>;
  if (p.found !== true) return base;

  const reasons = strArray(p.common_caller_reasons, 3);
  return {
    found: true,
    business_name_spoken:
      str(p.business_name_spoken) || base.business_name_spoken,
    what_they_do: str(p.what_they_do) || base.what_they_do,
    services: strArray(p.services, 5),
    common_caller_reasons:
      reasons.length > 0 ? reasons : base.common_caller_reasons,
    receptionist_greeting:
      str(p.receptionist_greeting) || base.receptionist_greeting,
    // Whatever research itself flagged as unverified. NOT merged with the
    // fallback list: once we've confirmed the business, blanket-blocking
    // prices and hours would gut the demo, and the agent's own prompt frames
    // the whole thing as a sample anyway.
    do_not_claim: strArray(p.do_not_claim, 6),
    source_url: str(p.source_url) || null,
  };
}

/**
 * Pull the model's text out of a raw Responses API body.
 *
 * `output_text` is a convenience field the official SDKs synthesise; over plain
 * fetch it may be absent, so we fall back to walking `output`. That array is
 * NOT just the message — with `web_search` enabled it also carries
 * `web_search_call` items, which is why we look for the message item by type
 * rather than taking `output[0]`.
 */
export function extractOutputText(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;

  const direct = str(b.output_text);
  if (direct) return direct;

  if (!Array.isArray(b.output)) return "";
  for (const item of b.output) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (it.type !== "message" || !Array.isArray(it.content)) continue;
    for (const part of it.content) {
      if (!part || typeof part !== "object") continue;
      const pt = part as Record<string, unknown>;
      const isText = pt.type === "output_text" || pt.type === "text";
      if (isText && typeof pt.text === "string") return pt.text;
    }
  }
  return "";
}
