import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

const TZ = "America/New_York";

/** The call's ET calendar date (YYYY-MM-DD) — the "session date" a hot lead is
 *  filed under, matching how the Dashboard groups days. */
function etDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(
    new Date(iso),
  );
}

function pick(ed: Record<string, unknown>, key: string): string | null {
  const v = ed[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export type SeedCall = {
  id: string;
  lead_id: string | null;
  started_at: string | null;
  duration_seconds: number | null;
};

/** Seed the Hot Leads sell list from a single call's extraction — once.
 *
 *  Only acts when the call's interest answer is "yes". The insert is an
 *  ON CONFLICT (call_id) DO NOTHING (via upsert + ignoreDuplicates), so a
 *  webhook retry or a re-run of the backfill never overwrites the team's edits
 *  (status / owner / next step / date contacted). Shared by the post-call
 *  webhook (live) and the one-time backfill script. */
export async function seedHotLeadFromCall(
  supabase: SupabaseClient<Database>,
  call: SeedCall,
  extraction: Record<string, unknown>,
): Promise<void> {
  const interest = String(extraction.ai_call_answering_interest ?? "")
    .trim()
    .toLowerCase();
  if (interest !== "yes") return;

  const contactName =
    pick(extraction, "owner_name") ??
    pick(extraction, "manager_name") ??
    pick(extraction, "employee_name");

  const row: Database["public"]["Tables"]["hot_leads"]["Insert"] = {
    call_id: call.id,
    lead_id: call.lead_id,
    session_date: call.started_at ? etDate(call.started_at) : null,
    contact_name: contactName,
    why_hot: pick(extraction, "ai_call_answering_reason"),
    call_length_seconds: call.duration_seconds,
    interest: "yes",
    current_ai_tool: pick(extraction, "current_ai_tools"),
  };

  await supabase
    .from("hot_leads")
    .upsert(row, { onConflict: "call_id", ignoreDuplicates: true });
}
