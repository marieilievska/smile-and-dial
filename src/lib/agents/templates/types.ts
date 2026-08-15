import {
  toFieldId,
  type ExtraDataCollectionField,
} from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";

/** A key detail is one concrete fact the agent needs (event name, date, offer…).
 *  `type` drives the input control (text / date-picker / time) and how the value
 *  is rendered into the prompt. `value` for a date is an ISO `YYYY-MM-DD`. */
export const KEY_DETAIL_TYPES = ["text", "date", "time"] as const;
export type KeyDetailType = (typeof KEY_DETAIL_TYPES)[number];

export type KeyDetail = {
  id: string;
  label: string;
  type: KeyDetailType;
  value: string;
  required: boolean;
};

/** The editable half of an agent — everything a teammate can change. */
export type AgentScript = {
  purpose: string;
  goal: string;
  keyDetails: KeyDetail[];
  scriptProse: string;
  dataCollection: ExtraDataCollectionField[];
};

/** A starting point: locked proven behavior + a pre-filled script. */
export type AgentTemplate = {
  key: string;
  name: string;
  description: string;
  instructions: string;
  defaultVoiceId: string;
  tools: ToolsEnabled;
  script: AgentScript;
};

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse + sanitize the `key_details` jsonb stored on an agent row. Tolerant of
 *  anything malformed (returns []), derives a snake_case id from the label,
 *  drops label-less entries, coerces bad types to "text", and de-dupes by id. */
export function normalizeKeyDetails(raw: unknown): KeyDetail[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: KeyDetail[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = asString(rec.label).trim();
    const id = toFieldId(asString(rec.id) || label);
    if (!label || !id || seen.has(id)) continue;
    const type = (KEY_DETAIL_TYPES as readonly string[]).includes(
      asString(rec.type),
    )
      ? (asString(rec.type) as KeyDetailType)
      : "text";
    seen.add(id);
    out.push({
      id,
      label,
      type,
      value: asString(rec.value),
      required: rec.required === true,
    });
  }
  return out;
}
