import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { RejectedExample } from "./prompts";
import { chunk } from "./chunk";

type Admin = ReturnType<typeof createClient<Database>>;

/** How many past false alarms to show the reviewer. Enough to establish a
 *  pattern, small enough not to crowd out the transcript. */
export const MAX_REJECTED_EXAMPLES = 12;

/** At most this many per finding type, so one heavily-corrected flag can't fill
 *  the whole budget and hide the rest. */
const PER_KIND_CAP = 3;

/**
 * Findings a human marked "False alarm", for one agent — fed back into the next
 * review as counter-examples.
 *
 * This is what makes rejection mean something: before this, marking a flag wrong
 * changed one row and nothing else, so the same false positive came back on the
 * next call forever. Scoped to the agent because a mistake that's wrong for one
 * agent's playbook may be right for another's.
 */
export async function loadRejectedExamples(
  db: Admin,
  agentId: string | null,
): Promise<RejectedExample[]> {
  if (!agentId) return [];
  const { data } = await db
    .from("call_review_flags")
    .select("call_id, flag_key, step_key, evidence_quote")
    .eq("status", "rejected")
    .not("evidence_quote", "is", null)
    .order("curated_at", { ascending: false })
    .limit(200);
  const rows = data ?? [];
  if (rows.length === 0) return [];

  // Flags don't carry agent_id, so resolve it via their calls.
  const agentByCall = new Map<string, string | null>();
  for (const ids of chunk([...new Set(rows.map((r) => r.call_id))], 200)) {
    const { data: calls } = await db
      .from("calls")
      .select("id, agent_id")
      .in("id", ids);
    for (const c of calls ?? []) agentByCall.set(c.id, c.agent_id);
  }

  const perKind = new Map<string, number>();
  const out: RejectedExample[] = [];
  for (const r of rows) {
    if (agentByCall.get(r.call_id) !== agentId) continue;
    const stepKey = r.step_key ? r.step_key : null;
    const kind = stepKey ? `${r.flag_key}:${stepKey}` : r.flag_key;
    const used = perKind.get(kind) ?? 0;
    if (used >= PER_KIND_CAP) continue;
    perKind.set(kind, used + 1);
    out.push({
      flagKey: r.flag_key,
      stepKey,
      evidenceQuote: r.evidence_quote,
    });
    if (out.length >= MAX_REJECTED_EXAMPLES) break;
  }
  return out;
}
