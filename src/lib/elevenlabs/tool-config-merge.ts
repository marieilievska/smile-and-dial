/**
 * Who owns which part of an ElevenLabs webhook tool, and how a re-sync applies
 * our part without overwriting the other.
 *
 * CODE owns the plumbing: the tool's `type`, its `name`, what it is for
 * (`description`) and its `api_schema` (URL, method, and the request body
 * schema, which carries the shared secret and every parameter the webhook
 * reads). The ElevenLabs DASHBOARD owns everything about HOW the tool runs:
 * execution_mode (background or wait), pre-tool speech, interruptions, tool
 * sounds, the timeout, error handling, and any top-level setting ElevenLabs adds later.
 *
 * Why (Marija, 2026-09-11): she moved four tools to background execution and
 * made book_appointment always say its "locking that in" line, both in the
 * dashboard. Every re-sync used to PATCH our whole config over the live one,
 * which carried neither setting, so the next campaign save would have silently
 * undone both. The dashboard wins; this module is how.
 *
 * Pure (no server-only, no network) so it unit-tests cleanly.
 */

/** The only top-level tool_config fields a re-sync may overwrite. */
export const CODE_OWNED_TOOL_FIELDS = [
  "type",
  "name",
  "description",
  "api_schema",
] as const;

export type ToolConfig = Record<string, unknown>;

/** ElevenLabs still echoes an older boolean beside two of these settings.
 *  `disable_interruptions` cannot express "disable_during_tool_and_turn" and
 *  `force_pre_tool_speech` cannot tell "auto" from "off", so re-sending them
 *  beside the real setting risks ElevenLabs resolving the pair to the weaker
 *  value. The code before this module never sent them, and the live tools show
 *  ElevenLabs recomputing them from the enums, so the merge drops each one
 *  whenever its successor is present. */
const DEPRECATED_MIRRORS: Record<string, string> = {
  force_pre_tool_speech: "pre_tool_speech",
  disable_interruptions: "interruption_mode",
};

/**
 * The config to PATCH onto an existing tool: the LIVE config with only the
 * code-owned fields replaced by ours. Sending the whole merged object is
 * correct whether ElevenLabs treats `tool_config` as a replacement or a merge.
 * The whole `api_schema` is ours, so any sibling ElevenLabs keeps inside it
 * (response_filter, auth_connection) is replaced, exactly as the code before
 * this module did.
 */
export function mergeToolConfig(
  live: ToolConfig,
  ours: ToolConfig,
): ToolConfig {
  const merged: ToolConfig = { ...live };
  for (const field of CODE_OWNED_TOOL_FIELDS) {
    if (field in ours) merged[field] = ours[field];
  }
  for (const [legacy, successor] of Object.entries(DEPRECATED_MIRRORS)) {
    if (successor in merged) delete merged[legacy];
  }
  return merged;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sortedStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : [])
    .filter((v): v is string => typeof v === "string")
    .sort();
}

function sameStringSet(a: unknown, b: unknown): boolean {
  const x = sortedStrings(a);
  const y = sortedStrings(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * True when `live` already holds every value `ours` sets. ElevenLabs echoes
 * each parameter back with extra defaults (is_system_provided, allowed_values,
 * empty strings for fields we never set), so live having MORE keys is fine.
 * null and a missing key count as the same.
 */
function covers(live: unknown, ours: unknown): boolean {
  if (ours === null || ours === undefined) {
    return live === null || live === undefined;
  }
  if (Array.isArray(ours)) {
    if (!Array.isArray(live) || live.length !== ours.length) return false;
    const key = (v: unknown) => JSON.stringify(v);
    const a = ours.map(key).sort();
    const b = live.map(key).sort();
    return a.every((v, i) => v === b[i]);
  }
  if (typeof ours === "object") {
    const l = asObject(live);
    return Object.entries(ours as Record<string, unknown>).every(([k, v]) =>
      covers(l[k], v),
    );
  }
  return live === ours;
}

/**
 * Would a re-sync change anything WE own on this tool? `false` means the live
 * tool already matches our plumbing and must be left alone: no PATCH at all,
 * so a routine campaign save changes nothing in ElevenLabs.
 *
 * Every field mergeToolConfig would overwrite is compared, so the two can
 * never disagree about what "ours" means. A false "same" would leave stale
 * plumbing live (ElevenLabs calling our webhook the wrong way, with the sync
 * reporting success); a false "differs" only costs one extra PATCH that
 * changes nothing.
 *
 * ElevenLabs echoes back more than we send (extra parameter defaults,
 * api_schema siblings), so "live covers ours" is the test, with null ≈ missing
 * and `required` compared as a set. Coverage cannot see a REMOVAL, so the set
 * of parameter names must match exactly: a parameter dropped from code is
 * dropped live too. The same blind spot remains inside the maps we send EMPTY
 * (`request_headers`, `path_params_schema`): anything added there in the
 * dashboard is covered vacuously and survives until some other change triggers
 * a PATCH. Inert while we send none — give those the parameter-name treatment
 * the day code sends one.
 */
export function ownedFieldsDiffer(live: ToolConfig, ours: ToolConfig): boolean {
  if (
    CODE_OWNED_TOOL_FIELDS.some((field) => !covers(live[field], ours[field]))
  ) {
    return true;
  }
  const paramNames = (config: ToolConfig): string[] =>
    Object.keys(
      asObject(
        asObject(asObject(config.api_schema).request_body_schema).properties,
      ),
    );
  return !sameStringSet(paramNames(live), paramNames(ours));
}
