import "server-only";

import { openAiKey } from "@/lib/openai/live";

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
  /** The booking/CRM platform we already know this business runs on (the
   *  `booking_crm_software` custom field). Not researched — we imported it — so
   *  it is the one fact in the brief that cannot be wrong. */
  bookingSoftware: string | null;
  /** Anything the caller volunteered on the call. Treated as authoritative —
   *  it comes from the owner's own mouth, seconds ago. */
  heardOnCall: string | null;
};

/**
 * What the agent role-plays from: the five things a front desk genuinely needs
 * to answer the phone, each short enough to say out loud.
 *
 * Deliberately NOT here: a service list, likely caller reasons, a canned
 * greeting. They read well on paper but the agent improvises them fine from
 * `what_they_do`, and every extra field costs seconds the caller spends waiting.
 */
export type FrontDeskBrief = {
  /** Did we identify the RIGHT business? This is ONLY about identification —
   *  an unfilled `hours` must never drag it false. Learned the hard way: when
   *  `found` also meant "I got everything", one unverifiable field blanked an
   *  otherwise perfect brief. */
  found: boolean;
  business_name_spoken: string;
  what_they_do: string;
  where_we_are: string;
  hours: string;
  how_to_book: string;
  /** Things the agent must NOT state because research could not verify them.
   *  Not spoken — it's the rail that stops the demo inventing prices on a
   *  recorded call. */
  do_not_claim: string[];
  /** Not spoken. Feeds `leads.website` so the next lookup is domain-pinned. */
  source_url: string | null;
};

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
 *  empty answer is worse than a general one. Note `where_we_are` and
 *  `how_to_book` still come out populated: the lead's city and booking platform
 *  are ours already, so they survive a total research failure. */
export function fallbackBrief(inputs: ResearchInputs): FrontDeskBrief {
  const company = inputs.company?.trim() ?? "";
  const where = [inputs.city, inputs.state]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(", ");
  const booking = inputs.bookingSoftware?.trim() ?? "";
  return {
    found: false,
    business_name_spoken: company || "the business",
    what_they_do: inputs.heardOnCall?.trim() ?? "",
    where_we_are: where,
    hours: "",
    how_to_book: booking ? `You can book through ${booking}.` : "",
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

  return {
    found: true,
    business_name_spoken:
      str(p.business_name_spoken) || base.business_name_spoken,
    what_they_do: str(p.what_they_do) || base.what_they_do,
    // A blank from research falls back to what we already knew (city, booking
    // platform) rather than to an empty string the agent would have to skip.
    where_we_are: str(p.where_we_are) || base.where_we_are,
    hours: str(p.hours),
    how_to_book: str(p.how_to_book) || base.how_to_book,
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

const MODEL = "gpt-5.4-mini";

/** Strict JSON schema for the brief. `strict: true` requires every property to
 *  be listed in `required` and `additionalProperties: false`. */
const BRIEF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "found",
    "business_name_spoken",
    "what_they_do",
    "where_we_are",
    "hours",
    "how_to_book",
    "do_not_claim",
    "source_url",
  ],
  properties: {
    found: {
      type: "boolean",
      description:
        "Did you identify the RIGHT business? This is ONLY about identification — how many other fields you managed to fill is irrelevant to it. Guessing at the business is worse than false.",
    },
    business_name_spoken: {
      type: "string",
      description: "How a receptionist would say the name out loud.",
    },
    what_they_do: {
      type: "string",
      // Left to itself the model writes a three-sentence paragraph, which is
      // unusable on a phone call. Give it a hard ceiling, not an adjective.
      description:
        "ONE sentence, at most 20 words, as a person would say it aloud.",
    },
    where_we_are: {
      type: "string",
      description:
        "Where they are, as their receptionist would say it — street, landmark or neighbourhood, plus parking if you know it. At most 20 words. Blank if unknown.",
    },
    hours: {
      type: "string",
      description:
        "Opening hours spoken naturally, e.g. 'we're open Monday to Thursday, eight to five'. Blank if you could not verify them.",
    },
    how_to_book: {
      type: "string",
      description:
        "One spoken line for getting a caller booked in. At most 20 words.",
    },
    do_not_claim: {
      type: "array",
      items: { type: "string" },
      description:
        "SHORT NOUN PHRASES ONLY for what a receptionist must not state because you could not verify it, e.g. 'exact prices', 'walk-ins', 'parking'. Never full sentences.",
    },
    source_url: {
      type: ["string", "null"],
      description: "The page you relied on most.",
    },
  },
} as const;

/** Build the Responses API request. Pure — exported so the domain-pinning logic
 *  is testable without hitting the network. */
export function buildResearchRequest(
  inputs: ResearchInputs,
): Record<string, unknown> {
  const domain = researchDomain(inputs.website);
  const where = [inputs.city, inputs.state]
    .map((s) => s?.trim())
    .filter((s): s is string => Boolean(s))
    .join(", ");
  const heard = inputs.heardOnCall?.trim();

  const instructions = [
    "Research this local business so a receptionist could convincingly answer its phone.",
    `Business: ${inputs.company?.trim() || "(name unknown)"}${where ? ` in ${where}` : ""}.`,
    domain
      ? `Their website is ${domain} — treat it as the primary source.`
      : "Find their website or business listing first.",
    inputs.bookingSoftware?.trim()
      ? `They book through ${inputs.bookingSoftware.trim()} — we already know this, so use it for how_to_book.`
      : "",
    heard
      ? `The owner said this on a live call just now — treat it as authoritative and prefer it over anything on the web: ${heard}`
      : "",
    "If you cannot confirm you found the RIGHT business, set found to false rather than guessing.",
    // Without this the model treats ANY unverifiable field as a failure to
    // identify the business and blanks the whole brief — measured: a business
    // it had described perfectly came back empty purely because its hours
    // weren't published.
    "But found is ONLY about identifying the business. Leaving an individual field blank because you could not verify it is NORMAL and EXPECTED, and must NOT make found false.",
    "Fill every field you can, leave blank the ones you cannot, and list the blanks in do_not_claim.",
    "Keep every field short enough to say out loud on a phone call.",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    model: MODEL,
    input: instructions,
    tools: [
      {
        type: "web_search",
        // "low" keeps the round-trip short; the caller is waiting on the phone.
        search_context_size: "low",
        // Pinning to their own domain buys ACCURACY, not speed — measured, a
        // pinned search actually runs a few seconds slower than an open one.
        // Worth it: it guarantees we describe the right business rather than a
        // same-named one in another state.
        ...(domain ? { filters: { allowed_domains: [domain] } } : {}),
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "front_desk_brief",
        strict: true,
        schema: BRIEF_SCHEMA,
      },
    },
  };
}

const RESPONSES_API = "https://api.openai.com/v1/responses";

/** Hard ceiling on the research round-trip.
 *
 *  Measured against the live API on 2026-07-21: a web-search round trip lands
 *  between ~6s and ~13s (a domain-pinned search is at the slow end — see
 *  buildResearchRequest). An earlier 12s ceiling was clipping perfectly good
 *  results, turning a successful lookup into a "couldn't find them" demo. The
 *  ElevenLabs tool is registered with a 25s timeout, so 18s leaves headroom for
 *  the agent to start speaking while staying inside it. */
const RESEARCH_TIMEOUT_MS = 18_000;

/**
 * Research a business and return a brief the agent can role-play from.
 *
 * Live whenever OPENAI_API_KEY is set (same "live when the credential is
 * present" rule the rest of our OpenAI features use — see lib/openai/live).
 * NEVER throws and never rejects: every failure path returns `fallbackBrief`,
 * because the alternative is dead air on a live sales call.
 */
export async function researchBusiness(
  inputs: ResearchInputs,
): Promise<FrontDeskBrief> {
  const apiKey = openAiKey();
  if (!apiKey) return fallbackBrief(inputs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(RESPONSES_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(buildResearchRequest(inputs)),
      signal: controller.signal,
    });
    if (!res.ok) return fallbackBrief(inputs);

    const text = extractOutputText((await res.json()) as unknown);
    if (!text) return fallbackBrief(inputs);

    try {
      return buildFrontDeskBrief(inputs, JSON.parse(text));
    } catch {
      return fallbackBrief(inputs);
    }
  } catch {
    // Aborted (timeout) or network failure.
    return fallbackBrief(inputs);
  } finally {
    clearTimeout(timer);
  }
}
