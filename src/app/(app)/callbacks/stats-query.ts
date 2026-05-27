import type { SupabaseClient } from "@supabase/supabase-js";

/** Four at-a-glance numbers for the /callbacks stat strip:
 *   - dueToday        — pending, scheduled today (00:00 → 23:59 local)
 *   - dueThisWeek     — pending, scheduled in the next 7 days (incl. today)
 *   - overdue         — pending, scheduled_at < now (the dialer hasn't
 *                       picked them up yet, or they're missed pickups)
 *   - repeatVoicemail — pending, voicemail_attempts >= 2 (need human
 *                       intervention — the AI keeps hitting voicemail)
 *
 *  All four counts respect RLS, so members only see callbacks for
 *  leads they own; admins see everything. */
export type CallbackStats = {
  dueToday: number;
  dueThisWeek: number;
  overdue: number;
  repeatVoicemail: number;
};

export async function fetchCallbackStats(
  // We accept a generic SupabaseClient so the page can pass in either
  // the server or service client without a tighter type binding.
  supabase: SupabaseClient,
): Promise<CallbackStats> {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setHours(23, 59, 59, 999);
  const weekFromNow = new Date(startOfToday);
  weekFromNow.setDate(weekFromNow.getDate() + 7);

  const [dueToday, dueThisWeek, overdue, repeatVoicemail] = await Promise.all([
    supabase
      .from("callbacks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("scheduled_at", startOfToday.toISOString())
      .lte("scheduled_at", endOfToday.toISOString()),
    supabase
      .from("callbacks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("scheduled_at", startOfToday.toISOString())
      .lt("scheduled_at", weekFromNow.toISOString()),
    supabase
      .from("callbacks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("scheduled_at", now.toISOString()),
    supabase
      .from("callbacks")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .gte("voicemail_attempts", 2),
  ]);

  return {
    dueToday: dueToday.count ?? 0,
    dueThisWeek: dueThisWeek.count ?? 0,
    overdue: overdue.count ?? 0,
    repeatVoicemail: repeatVoicemail.count ?? 0,
  };
}
