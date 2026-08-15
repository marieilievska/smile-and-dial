import { normalizeDataCollection } from "@/lib/agents/data-collection";
import type { ToolsEnabled } from "@/lib/agents/prompt";

import {
  normalizeKeyDetails,
  type AgentScript,
  type AgentTemplate,
} from "./types";

/** The columns we select from agent_templates. */
export type AgentTemplateRow = {
  id: string;
  name: string;
  description: string | null;
  instructions: string;
  default_voice_id: string | null;
  tools: unknown;
  script: unknown;
};

/** Parse the `script` jsonb into a typed AgentScript, tolerant of anything
 *  malformed. */
export function scriptFromJson(raw: unknown): AgentScript {
  const rec = (raw && typeof raw === "object" ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    purpose: typeof rec.purpose === "string" ? rec.purpose : "",
    goal: typeof rec.goal === "string" ? rec.goal : "",
    keyDetails: normalizeKeyDetails(rec.keyDetails),
    scriptProse: typeof rec.scriptProse === "string" ? rec.scriptProse : "",
    dataCollection: normalizeDataCollection(rec.dataCollection),
  };
}

/** Map an agent_templates DB row into the same AgentTemplate shape the gallery
 *  and builder use for code-seeded templates. The row id becomes the key. */
export function templateFromRow(row: AgentTemplateRow): AgentTemplate {
  return {
    key: row.id,
    name: row.name,
    description: row.description ?? "",
    instructions: row.instructions,
    defaultVoiceId: row.default_voice_id ?? "",
    tools: (row.tools ?? {}) as ToolsEnabled,
    script: scriptFromJson(row.script),
  };
}
