/**
 * Normalize a company-name audience filter to a literal "contains" term:
 * trim it and drop characters that act as ILIKE wildcards (`%`, `_`) or that
 * would break the pattern (`,`, `(`, `)`, `\`, `*`). Mirrors the Leads page
 * search sanitization so the stored filter matches as plain text both in the
 * dial_queue view (which concatenates it into an ILIKE pattern) and in the
 * live count query.
 *
 * Returns "" for input that is empty after sanitizing — callers treat that as
 * "no filter" (NULL on the campaign).
 */
export function sanitizeAudienceSearch(raw: string): string {
  return raw.replace(/[%_,()\\*]/g, "").trim();
}
