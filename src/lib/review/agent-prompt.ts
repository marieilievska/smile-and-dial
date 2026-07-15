import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fetchElevenLabsAgentPrompt } from "@/lib/elevenlabs/agents";
import {
  INSTRUCTIONS_CAP,
  isCacheStale,
  truncateInstructions,
} from "./instructions";

type Admin = ReturnType<typeof createClient<Database>>;

const STALE_DAYS = 7;

/** The instructions the reviewer should judge a call against, for the agent that
 *  made it. Wizard agents use their local system_prompt. Externally-managed
 *  agents' real prompt lives in ElevenLabs, so we fetch + cache it on the agent
 *  (refreshing when stale). Returns null (→ no-playbook review) on any miss. */
export async function resolveAgentReviewPrompt(
  admin: Admin,
  agentId: string | null,
): Promise<string | null> {
  if (!agentId) return null;
  const { data: agent } = await admin
    .from("agents")
    .select(
      "system_prompt, externally_managed, elevenlabs_agent_id, review_prompt, review_prompt_at",
    )
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return null;

  if (!agent.externally_managed) {
    return truncateInstructions(
      agent.system_prompt?.trim() || null,
      INSTRUCTIONS_CAP,
    );
  }

  // Externally-managed: use the cache unless it's stale/missing.
  if (
    agent.review_prompt &&
    !isCacheStale(agent.review_prompt_at, Date.now(), STALE_DAYS)
  ) {
    return truncateInstructions(agent.review_prompt, INSTRUCTIONS_CAP);
  }
  if (!agent.elevenlabs_agent_id) return null;
  const fetched = await fetchElevenLabsAgentPrompt(agent.elevenlabs_agent_id);
  if (!fetched) {
    // Fall back to a stale cache if we have one; else no playbook.
    return truncateInstructions(agent.review_prompt ?? null, INSTRUCTIONS_CAP);
  }
  await admin
    .from("agents")
    .update({
      review_prompt: fetched,
      review_prompt_at: new Date().toISOString(),
    })
    .eq("id", agentId);
  return truncateInstructions(fetched, INSTRUCTIONS_CAP);
}
