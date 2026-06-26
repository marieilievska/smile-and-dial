/**
 * What the Reporting hub is scoped to. Carried in the URL as `?scope=`:
 *   all              → every campaign's calls combined (default)
 *   campaign:<uuid>  → one campaign
 */
export type ReportScope =
  | { kind: "all" }
  | { kind: "campaign"; campaignId: string };

/** Parse the raw `?scope=` value. Anything that isn't `campaign:<id>` → all.
 *  Does NOT check the id exists — callers validate against the loaded campaign
 *  list and fall back to all when an id is stale. */
export function parseScopeParam(raw: string | undefined): ReportScope {
  const v = (raw ?? "").trim();
  if (v.startsWith("campaign:")) {
    const id = v.slice("campaign:".length).trim();
    if (id) return { kind: "campaign", campaignId: id };
  }
  return { kind: "all" };
}

/** The `?scope=` string for a scope. */
export function serializeScope(scope: ReportScope): string {
  if (scope.kind === "campaign") return `campaign:${scope.campaignId}`;
  return "all";
}
