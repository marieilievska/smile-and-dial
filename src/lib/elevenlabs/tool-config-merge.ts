/**
 * Who owns which part of an ElevenLabs webhook tool, and how a re-sync applies
 * our part without overwriting the other.
 *
 * CODE owns the plumbing: the tool's `type`, its `name`, what it is for
 * (`description`) and its `api_schema` (URL, method, and the request body
 * schema, which carries the shared secret and every parameter the webhook
 * reads). The ElevenLabs DASHBOARD owns everything about HOW the tool runs:
 * execution_mode (background or wait), pre-tool speech, interruptions, tool
 * sounds, the timeout, error handling, and any setting ElevenLabs adds later.
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

/**
 * The config to PATCH onto an existing tool: the LIVE config with only the
 * code-owned fields replaced by ours. Sending the whole merged object is
 * correct whether ElevenLabs treats `tool_config` as a replacement or a merge.
 */
export function mergeToolConfig(
  live: ToolConfig,
  ours: ToolConfig,
): ToolConfig {
  const merged: ToolConfig = { ...live };
  for (const field of CODE_OWNED_TOOL_FIELDS) {
    if (field in ours) merged[field] = ours[field];
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
 * Compared: type, name, description, URL, method, the required list (as a
 * set), and each parameter's type / enum / description / dynamic_variable /
 * constant_value. The SET of parameters must match exactly, so a parameter
 * removed from code is removed live too.
 */
export function ownedFieldsDiffer(live: ToolConfig, ours: ToolConfig): boolean {
  for (const field of ["type", "name", "description"] as const) {
    if (live[field] !== ours[field]) return true;
  }
  const liveApi = asObject(live.api_schema);
  const ourApi = asObject(ours.api_schema);
  if (liveApi.url !== ourApi.url || liveApi.method !== ourApi.method) {
    return true;
  }
  const liveBody = asObject(liveApi.request_body_schema);
  const ourBody = asObject(ourApi.request_body_schema);
  if (!sameStringSet(liveBody.required, ourBody.required)) return true;
  const liveProps = asObject(liveBody.properties);
  const ourProps = asObject(ourBody.properties);
  if (!sameStringSet(Object.keys(liveProps), Object.keys(ourProps))) {
    return true;
  }
  return Object.entries(ourProps).some(
    ([name, def]) => !covers(liveProps[name], def),
  );
}
