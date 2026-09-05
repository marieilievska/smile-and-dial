import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyConnectedAgentIntegration,
  syncAgentToElevenLabs,
} from "@/lib/elevenlabs/agents";
import type { Database } from "@/lib/supabase/database.types";

import {
  normalizeDataCollection,
  normalizeEvaluation,
} from "./data-collection";
import type { ToolsEnabled } from "./prompt";

/** The columns a full re-push of one agent needs. Keep the select strings in
 *  agents/actions.ts and knowledge-bases/resync-agents.ts in step with this. */
export type AgentSyncRow = {
  id: string;
  name: string;
  voice_id: string | null;
  ai_model: string | null;
  system_prompt: string | null;
  prompt_goal: string | null;
  elevenlabs_agent_id: string | null;
  extra_data_collection: unknown;
  extra_evaluation: unknown;
  tools_enabled: unknown;
  externally_managed: boolean | null;
  knowledge_base_ids: string[] | null;
};

export const AGENT_SYNC_ROW_COLUMNS =
  "id, name, voice_id, ai_model, system_prompt, prompt_goal, elevenlabs_agent_id, extra_data_collection, extra_evaluation, tools_enabled, externally_managed, knowledge_base_ids";

/** Push ONE agent's current config to ElevenLabs. Connected (externally-managed)
 *  agents get only our integration overlay — webhooks + call_id var + tool_ids
 *  + our knowledge documents, never their prompt/voice. App-managed agents get
 *  the FULL sync, including their custom data-collection + evaluation fields
 *  and knowledge documents. Shared by resyncAllAgents, the per-agent Sync
 *  button, and the knowledge-base actions (which re-push every agent using a
 *  knowledge base whose sources changed) so all behave identically.
 *
 *  Lives outside the "use server" actions file so non-action server code can
 *  call it without it becoming a server action itself. */
export async function syncAgentRowToElevenLabs(
  supabase: SupabaseClient<Database>,
  a: AgentSyncRow,
): Promise<{ error: string | null }> {
  const knowledgeBaseIds = a.knowledge_base_ids ?? [];
  if (a.externally_managed) {
    if (!a.elevenlabs_agent_id) return { error: null };
    return applyConnectedAgentIntegration(
      a.elevenlabs_agent_id,
      (a.tools_enabled ?? undefined) as unknown as ToolsEnabled | undefined,
      normalizeDataCollection(a.extra_data_collection),
      knowledgeBaseIds,
    );
  }
  const sync = await syncAgentToElevenLabs(
    {
      name: a.name,
      systemPrompt: a.system_prompt ?? "",
      voiceId: a.voice_id?.trim() || null,
      aiModel: a.ai_model?.trim() || null,
      goal: a.prompt_goal?.trim() || null,
      extraDataCollection: normalizeDataCollection(a.extra_data_collection),
      extraEvaluation: normalizeEvaluation(a.extra_evaluation),
      toolsEnabled: (a.tools_enabled ?? undefined) as unknown as
        | ToolsEnabled
        | undefined,
      knowledgeBaseIds,
    },
    a.elevenlabs_agent_id,
  );
  if (sync.error) return { error: sync.error };
  if (
    sync.elevenlabsAgentId &&
    sync.elevenlabsAgentId !== a.elevenlabs_agent_id
  ) {
    await supabase
      .from("agents")
      .update({ elevenlabs_agent_id: sync.elevenlabsAgentId })
      .eq("id", a.id);
  }
  return { error: null };
}
