import type { SupabaseClient } from "@supabase/supabase-js";

import {
  endOfEtDayUtcIso,
  etDateDaysAgo,
  etDayString,
  etMidnightUtcIso,
  startOfTodayEtIso,
} from "@/lib/time/eastern";

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
  /** Pending callbacks scheduled to auto-dial within the next 60
   *  minutes (now → now+1h). Drives the live "N due within the hour"
   *  pulse in the page header so Callbacks reads as a live autopilot
   *  operation, not a static schedule. */
  dueWithinHour: number;
};

export async function fetchCallbackStats(
  // We accept a generic SupabaseClient so the page can pass in either
  // the server or service client without a tighter type binding.
  supabase: SupabaseClient,
): Promise<CallbackStats> {
  const now = new Date();
  // Eastern calendar-day boundaries so "due today"/"this week" match the rest
  // of the app instead of the server's UTC midnight (which rolls over ~7-8pm
  // ET). scheduled_at is an absolute instant compared against ET-day bounds.
  const todayEt = etDayString(now);
  const startOfToday = startOfTodayEtIso(now);
  const endOfToday = endOfEtDayUtcIso(todayEt);
  const weekFromNow = etMidnightUtcIso(etDateDaysAgo(-7, now));
  const nowIso = now.toISOString();
  const hourFromNow = new Date(now.getTime() + 60 * 60_000).toISOString();

  const [dueToday, dueThisWeek, overdue, repeatVoicemail, dueWithinHour] =
    await Promise.all([
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("scheduled_at", startOfToday)
        .lte("scheduled_at", endOfToday),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("scheduled_at", startOfToday)
        .lt("scheduled_at", weekFromNow),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .lt("scheduled_at", nowIso),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("voicemail_attempts", 2),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("scheduled_at", nowIso)
        .lte("scheduled_at", hourFromNow),
    ]);

  return {
    dueToday: dueToday.count ?? 0,
    dueThisWeek: dueThisWeek.count ?? 0,
    overdue: overdue.count ?? 0,
    repeatVoicemail: repeatVoicemail.count ?? 0,
    dueWithinHour: dueWithinHour.count ?? 0,
  };
}
