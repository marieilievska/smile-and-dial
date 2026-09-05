import "server-only";

import {
  AGENT_SYNC_ROW_COLUMNS,
  syncAgentRowToElevenLabs,
} from "@/lib/agents/sync-row";
import { createAdminClient } from "@/lib/supabase/admin";

export type AgentsUsingKnowledgeBase = {
  count: number;
  names: string[];
};

/**
 * Which agents reference a knowledge base. Service-role on purpose: an
 * admin's agent may reference a member's knowledge base, and the member's
 * RLS view would miss it — the count must be truthful before a delete is
 * blocked or a re-sync fanned out.
 */
export async function agentsUsingKnowledgeBase(
  kbId: string,
): Promise<AgentsUsingKnowledgeBase> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agents")
    .select("name")
    .contains("knowledge_base_ids", [kbId])
    .order("created_at", { ascending: true });
  const names = (data ?? []).map((a) => a.name);
  return { count: names.length, names };
}

/**
 * Re-push every agent that references this knowledge base, so a source that
 * was just added, removed or (re)synced shows up in — or drops out of — each
 * agent's ElevenLabs `knowledge_base` list. Best-effort: one agent failing
 * doesn't stop the others; the caller decides whether to surface the count.
 * Sequential to stay inside ElevenLabs rate limits, like resyncAllAgents.
 */
export async function resyncAgentsUsingKnowledgeBase(
  kbId: string,
): Promise<{ synced: number; failed: number }> {
  const admin = createAdminClient();
  const { data: agents } = await admin
    .from("agents")
    .select(AGENT_SYNC_ROW_COLUMNS)
    .contains("knowledge_base_ids", [kbId])
    .order("created_at", { ascending: true });

  let synced = 0;
  let failed = 0;
  for (const a of agents ?? []) {
    const r = await syncAgentRowToElevenLabs(admin, a);
    if (r.error) {
      failed += 1;
      console.error(
        `[knowledge-bases] re-sync of agent ${a.id} after KB ${kbId} changed failed: ${r.error}`,
      );
    } else synced += 1;
  }
  return { synced, failed };
}
