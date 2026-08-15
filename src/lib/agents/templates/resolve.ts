// src/lib/agents/templates/resolve.ts
import type { SupabaseClient } from "@supabase/supabase-js";

import { templateFromRow, type AgentTemplateRow } from "./from-row";
import { getTemplate } from "./index";
import type { AgentTemplate } from "./types";

const TEMPLATE_COLUMNS =
  "id, name, description, instructions, default_voice_id, tools, script";

/** Resolve a gallery "key" to a template. Code-seeded keys (webinar, blank)
 *  resolve from the in-memory registry without a DB hit; anything else is looked
 *  up in agent_templates by id. Returns null if neither matches. */
export async function resolveTemplate(
  key: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
): Promise<AgentTemplate | null> {
  const seed = getTemplate(key);
  if (seed) return seed;

  const { data } = await supabase
    .from("agent_templates")
    .select(TEMPLATE_COLUMNS)
    .eq("id", key)
    .maybeSingle();
  return data ? templateFromRow(data as AgentTemplateRow) : null;
}
