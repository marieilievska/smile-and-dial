import "server-only";
import type { createClient } from "@/lib/supabase/server";
import type { PlaybookStep } from "./playbook";

type ServerClient = Awaited<ReturnType<typeof createClient>>;

export type AgentPlaybookView = {
  agentId: string;
  agentName: string;
  steps: PlaybookStep[];
  /** When the checklist was last derived; null means never (it derives on this
   *  agent's next reviewed call). */
  syncedAt: string | null;
  /** Size of the prompt the reviewer last read, so an empty checklist can be
   *  told apart from an unreachable agent. */
  promptChars: number;
};

/**
 * Every agent's derived review checklist, for the Reporting panel.
 *
 * This is the thing the reviewer actually grades calls against, so it needs to
 * be visible and correctable — an extraction nobody can see is an extraction
 * nobody can trust.
 */
export async function fetchAgentPlaybooks(
  supabase: ServerClient,
): Promise<AgentPlaybookView[]> {
  const { data } = await supabase
    .from("agents")
    .select("id, name, review_playbook, review_playbook_at, review_prompt")
    .order("name", { ascending: true });

  return (data ?? []).map((a) => {
    const raw = a.review_playbook;
    return {
      agentId: a.id,
      agentName: a.name,
      steps: Array.isArray(raw) ? (raw as unknown as PlaybookStep[]) : [],
      syncedAt: a.review_playbook_at,
      promptChars: a.review_prompt?.length ?? 0,
    };
  });
}
