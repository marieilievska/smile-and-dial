/**
 * What the Reporting hub is scoped to. Carried in the URL as `?scope=`:
 *   all              → every agent's calls combined (default)
 *   agent:<uuid>     → one agent (rolls up its campaigns)
 *   campaign:<uuid>  → one campaign
 */
export type ReportScope =
  | { kind: "all" }
  | { kind: "agent"; agentId: string }
  | { kind: "campaign"; campaignId: string };

/** Parse the raw `?scope=` value. Unknown/blank/malformed → all. Note: this
 *  does NOT check the id exists — callers validate against the loaded
 *  agent/campaign lists and fall back to all when an id is stale. */
export function parseScopeParam(raw: string | undefined): ReportScope {
  const v = (raw ?? "").trim();
  if (v.startsWith("agent:")) {
    const id = v.slice("agent:".length).trim();
    if (id) return { kind: "agent", agentId: id };
  }
  if (v.startsWith("campaign:")) {
    const id = v.slice("campaign:".length).trim();
    if (id) return { kind: "campaign", campaignId: id };
  }
  return { kind: "all" };
}

/** The `?scope=` string for a scope. */
export function serializeScope(scope: ReportScope): string {
  if (scope.kind === "agent") return `agent:${scope.agentId}`;
  if (scope.kind === "campaign") return `campaign:${scope.campaignId}`;
  return "all";
}
