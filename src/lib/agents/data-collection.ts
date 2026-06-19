/**
 * Per-agent custom Data Collection fields + Success Evaluation criteria.
 *
 * These are ADDITIVE to the system base set the sync layer always sends.
 * The base data-collection fields (disposition, business_email, owner_name,
 * manager_name, employee_name, callback_datetime) and the
 * base "goal met" evaluation criterion are load-bearing — the post-call
 * webhook reads them to map outcomes, autofill lead fields, and schedule
 * callbacks. User-defined fields/criteria are merged on top and can never
 * remove or shadow a base field (we drop any whose id collides with a base
 * id, so the base always wins).
 */

export const DATA_COLLECTION_TYPES = ["string", "number", "boolean"] as const;
export type DataCollectionType = (typeof DATA_COLLECTION_TYPES)[number];

/** A user-defined data-collection field. `enumValues` only applies to
 *  string fields and constrains the agent to a fixed set of answers. */
export type ExtraDataCollectionField = {
  id: string;
  type: DataCollectionType;
  description: string;
  enumValues: string[];
};

/** A user-defined success-evaluation criterion. */
export type ExtraEvaluationCriterion = {
  id: string;
  name: string;
  prompt: string;
};

/** The base data-collection field ids the sync layer always sends and the
 *  post-call webhook depends on. User ids that collide with these are
 *  dropped so a custom field can never shadow a load-bearing one. */
export const BASE_DATA_COLLECTION_IDS = new Set([
  "disposition",
  "business_email",
  "owner_name",
  "manager_name",
  "employee_name",
  "callback_datetime",
]);

/** The base evaluation criterion id ("goal met") that always ships. */
export const BASE_EVALUATION_IDS = new Set(["goal"]);

/** Slugify a free-text label into a safe snake_case field id. */
export function toFieldId(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse + sanitize the jsonb stored on the agent row into a typed list.
 *  Tolerant of anything malformed (returns []), drops base-id collisions
 *  and entries missing an id, and de-dupes by id. */
export function normalizeDataCollection(
  raw: unknown,
): ExtraDataCollectionField[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ExtraDataCollectionField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = toFieldId(asString(rec.id));
    if (!id || BASE_DATA_COLLECTION_IDS.has(id) || seen.has(id)) continue;
    const type = (DATA_COLLECTION_TYPES as readonly string[]).includes(
      asString(rec.type),
    )
      ? (asString(rec.type) as DataCollectionType)
      : "string";
    const enumValues =
      type === "string" && Array.isArray(rec.enumValues)
        ? rec.enumValues
            .map((e) => asString(e).trim())
            .filter((e) => e.length > 0)
        : [];
    seen.add(id);
    out.push({ id, type, description: asString(rec.description), enumValues });
  }
  return out;
}

/** Parse + sanitize stored evaluation criteria. Same tolerance rules. */
export function normalizeEvaluation(raw: unknown): ExtraEvaluationCriterion[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ExtraEvaluationCriterion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = toFieldId(asString(rec.id) || asString(rec.name));
    if (!id || BASE_EVALUATION_IDS.has(id) || seen.has(id)) continue;
    const name = asString(rec.name).trim() || id;
    const prompt = asString(rec.prompt).trim();
    if (!prompt) continue;
    seen.add(id);
    out.push({ id, name, prompt });
  }
  return out;
}

/** Appended to every user-defined field's description sent to ElevenLabs so the
 *  analysis LLM extracts the answer from the CUSTOMER's own words only — never
 *  from the agent's questions, examples, or script. Without this the extractor
 *  was crediting the lead with things the agent said (e.g. tools the agent named
 *  as examples, or "interest" inferred from the agent's pitch). */
export const CUSTOMER_ONLY_CLAUSE =
  " Base this ONLY on what the person we called actually said. Never extract it " +
  "from the AI agent's own words, questions, examples, or suggestions — if the " +
  "customer never said it, leave it blank.";

/** Shape a normalized field into the ElevenLabs Data Collection entry. */
export function toElevenLabsDataCollection(
  f: ExtraDataCollectionField,
): Record<string, unknown> {
  return {
    id: f.id,
    type: f.type,
    description: f.description + CUSTOMER_ONLY_CLAUSE,
    ...(f.type === "string" && f.enumValues.length > 0
      ? { enum: f.enumValues }
      : {}),
  };
}

/** Shape normalized custom fields into ElevenLabs' OBJECT data-collection form
 *  (keyed by id), matching the base fields' shape. The connected-agent overlay
 *  merges these alongside the base set so a connected agent's custom fields
 *  reach ElevenLabs without touching its prompt/voice. */
export function toElevenLabsDataCollectionObject(
  fields: ExtraDataCollectionField[],
): Record<string, { type: string; description: string; enum?: string[] }> {
  const out: Record<
    string,
    { type: string; description: string; enum?: string[] }
  > = {};
  for (const f of fields) {
    out[f.id] = {
      type: f.type,
      description: f.description + CUSTOMER_ONLY_CLAUSE,
    };
    if (f.type === "string" && f.enumValues.length > 0) {
      out[f.id].enum = f.enumValues;
    }
  }
  return out;
}

/** Shape a normalized criterion into the ElevenLabs evaluation entry. */
export function toElevenLabsEvaluation(
  c: ExtraEvaluationCriterion,
): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    type: "prompt",
    conversation_goal_prompt: c.prompt,
  };
}
