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
