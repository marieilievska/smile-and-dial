import "server-only";

import { createClient } from "@supabase/supabase-js";

import { bestHourForDay, localDowHour } from "@/lib/dialer/best-time";
import { loadCachedHeatmap } from "@/lib/dialer/best-time-cache";
import {
  localHourDaysAheadIso,
  rollIsoOffWeekend,
} from "@/lib/dialer/local-schedule";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;
type CallOutcome = Database["public"]["Tables"]["calls"]["Row"]["outcome"];
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

/**
 * Outcomes that increment the unified 2d/2d/15d retry cycle and leave the
 * lead in `ready_to_call`. See BUILD_PLAN §8.
 */
const RETRY_OUTCOMES = new Set<CallOutcome>([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "hung_up_immediately",
  "gatekeeper",
  "ai_error",
]);

/**
 * Non-connect outcomes that, on a lead with a PENDING callback, escalate that
 * callback (the +30min → next-day → 'missed' ladder) instead of abandoning it to
 * the generic cold-retry cycle. Previously only `voicemail` did this, so a
 * callback that hit no-answer / busy / failed / immediate-hangup got flipped to
 * `ready_to_call` while its callback stayed pending — orphaning it out of the
 * dial queue (the "lots of overdue callbacks" bug). gatekeeper/ai_error are
 * excluded: a gatekeeper reached someone (it consumes the callback), ai_error is
 * an error path.
 */
const CALLBACK_NONCONNECT_OUTCOMES = new Set<CallOutcome>([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "hung_up_immediately",
]);

/**
 * The cycle's delay (in days) at each retry_position. The position cycles
 * 0 → 1 → 2 → 0 forever.
 */
const RETRY_DELAY_DAYS: readonly number[] = [2, 2, 15];

/** Outcomes that put the lead into `resting` for some number of days. */
const RESTING_OUTCOMES: Record<string, number> = {
  not_interested: 30,
  ai_receptionist: 15,
};

/** Outcomes that close the lead (terminal). */
const TERMINAL_OUTCOMES: Record<
  string,
  { status: Database["public"]["Tables"]["leads"]["Row"]["status"] }
> = {
  goal_met: { status: "goal_met" },
  transferred_to_human: { status: "goal_met" },
};

/**
 * Parse a campaign's 'HH:MM:SS' calling-hours string to an integer hour,
 * falling back to `fallback` when the value is null/blank/unparseable. Used only
 * by smart scheduling to bound the best-hour search to the calling window.
 */
function parseCallingHour(
  hhmmss: string | null | undefined,
  fallback: number,
): number {
  if (!hhmmss) return fallback;
  const h = Number(hhmmss.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Retry engine requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type RetryApplyResult =
  | { ok: true; status: "applied" }
  | { ok: true; status: "already_applied" }
  | { ok: true; status: "no_outcome" }
  | { ok: true; status: "outcome_handled_elsewhere" }
  | { ok: false; reason: string };

/**
 * Apply BUILD_PLAN §8's retry rules for one call's outcome. Idempotent: a
 * second call for the same `callId` will short-circuit at the
 * `retry_applied_at` check. Both the Twilio status webhook and the
 * ElevenLabs post-call webhook can call this safely — whoever wins the
 * compare-and-swap races first.
 *
 * Outcomes split into these buckets:
 *
 *   * **Retry (unified cycle)**: voicemail / no_answer / busy / failed /
 *     hung_up_immediately / gatekeeper / ai_error
 *       → bump retry_counter, advance retry_position 0→1→2→0, push
 *         next_call_at by 2d / 2d / 15d, status stays `ready_to_call`.
 *   * **call_back_later**: next-day retry up to twice on its OWN counter
 *     (call_back_later_count, independent of the voicemail/no-answer cycle),
 *     then 15-day rest.
 *   * **Resting**: not_interested (30d) / ai_receptionist (15d)
 *       → reset counters, status='resting', set resting_until and
 *         next_call_at to (now + N days).
 *   * **Terminal**: goal_met / transferred_to_human
 *       → reset counters, status='goal_met', clear next_call_at.
 *   * **Completed but unmapped (null outcome)**: a terminal call whose
 *     disposition never mapped → default onto the unified retry cycle so the
 *     lead keeps progressing (the call's outcome stays NULL). An IN-FLIGHT
 *     call with a null outcome instead rolls the claim back (`no_outcome`) to
 *     wait for the real webhook.
 *   * **Handled elsewhere**: dnc / invalid_number / language_barrier /
 *     callback are owned by `applyOutcomeSideEffects` in the post-call
 *     webhook. We return `outcome_handled_elsewhere` and don't touch
 *     the lead.
 */
export async function applyRetryForCall(
  callId: string,
): Promise<RetryApplyResult> {
  const supabase = makeServiceClient();

  // Compare-and-swap claim on the call row. If we don't get any rows back,
  // someone else already applied retry for this call.
  const { data: claimed, error: claimError } = await supabase
    .from("calls")
    .update({ retry_applied_at: new Date().toISOString() })
    .eq("id", callId)
    .is("retry_applied_at", null)
    .select("id, lead_id, campaign_id, outcome, status");
  if (claimError) return { ok: false, reason: "could_not_claim_call" };
  if (!claimed || claimed.length === 0) {
    return { ok: true, status: "already_applied" };
  }
  const call = claimed[0];
  // A null outcome means one of two very different things, and conflating them
  // stalls leads forever (bug #9):
  //   * The call is still IN-FLIGHT (queued/dialing/ringing/in_progress) — a
  //     later webhook will set the real outcome. Roll back the claim and wait.
  //   * The call is TERMINAL (completed/failed) but the disposition was never
  //     mapped (unmapped value + every fallback missed). For a completed call
  //     no later update ever comes (idempotency-deduped), so rolling back would
  //     strand the lead. Schedule a sensible DEFAULT retry instead — same as
  //     the unified no-answer/voicemail cycle — and leave the call's stored
  //     outcome honestly NULL (only the LEAD's schedule changes).
  const TERMINAL_STATUSES = new Set(["completed", "failed", "no_answer"]);
  const callIsTerminal = TERMINAL_STATUSES.has(call.status);
  if (!call.outcome && !callIsTerminal) {
    // Still in flight — roll back the claim so the real outcome can process
    // when it arrives.
    await supabase
      .from("calls")
      .update({ retry_applied_at: null })
      .eq("id", callId);
    return { ok: true, status: "no_outcome" };
  }

  // Side-effect outcomes (DNC / callback) are owned by the post-call
  // webhook's `applyOutcomeSideEffects`. Don't touch the lead here.
  if (
    call.outcome === "dnc" ||
    call.outcome === "invalid_number" ||
    call.outcome === "language_barrier" ||
    call.outcome === "callback"
  ) {
    return { ok: true, status: "outcome_handled_elsewhere" };
  }

  // Pull the lead (for callback-voicemail status + timezone) and the campaign
  // (for smart scheduling + calling-hours window) in parallel. The campaign
  // fetch is best-effort: a missing campaign or null calling hours must never
  // throw — smart scheduling just falls back to the default 9am behavior.
  const [{ data: lead }, { data: campaign }] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "retry_counter, retry_position, call_back_later_count, status, timezone",
      )
      .eq("id", call.lead_id)
      .single(),
    supabase
      .from("campaigns")
      .select("smart_scheduling, calling_hours_start, calling_hours_end")
      .eq("id", call.campaign_id ?? "")
      .maybeSingle(),
  ]);

  const update: LeadUpdate = { updated_at: new Date().toISOString() };

  // Callback NON-CONNECT special case (BUILD_PLAN §8): any non-connect outcome
  // (voicemail / no_answer / busy / failed / hung_up_immediately) on a lead with
  // a PENDING callback escalates that callback (+30min → next day → 'missed')
  // instead of the generic 2-day retry cycle. Previously only `voicemail`
  // triggered this, so a callback that hit no-answer/busy/failed/hangup got
  // flipped to ready_to_call while its callback stayed pending — orphaned out of
  // the dial queue (the overdue-callbacks bug).
  //
  // Keyed on the callback's EXISTENCE, not lead.status. The status field can
  // transiently read non-"callback" (a racing webhook, a just-run cycle), and
  // gating escalation on it let real callback non-connects fall silently into
  // the cold-call cycle. escalateCallbackVoicemail returns false when there's no
  // pending callback, so an ordinary cold-call non-connect still falls through
  // to the standard cycle below.
  if (call.outcome && CALLBACK_NONCONNECT_OUTCOMES.has(call.outcome)) {
    const escalated = await escalateCallbackVoicemail(
      supabase,
      call.lead_id,
      update,
      lead?.timezone ?? null,
    );
    if (escalated) {
      const { error: leadError } = await supabase
        .from("leads")
        .update(update)
        .eq("id", call.lead_id);
      if (leadError) return { ok: false, reason: "could_not_update_lead" };
      return { ok: true, status: "applied" };
    }
    // No pending callback — fall through to the standard retry cycle.
  }

  // Schedule the next attempt at the START of the lead's calling day (9am
  // local) N days out — not the odd clock time of this call — so Next-call
  // reads cleanly ("Mon 9:00am") instead of a random "20 hours ago" timestamp.
  const tz = lead?.timezone ?? null;

  // Smart scheduling: when the campaign opted in AND we have a cached heatmap,
  // keep the SAME backoff cadence (which DAY each branch picks) but aim at that
  // day's best hour (from the connect heatmap, within calling hours) instead of
  // the default 9am. The heatmap is precomputed daily by a cron — we only READ
  // the cache here. Everything is guarded so a missing campaign, null calling
  // hours, or an empty/unparseable heatmap can never throw: we fall straight
  // back to the existing `localHourDaysAheadIso(tz, n)` (9am) behavior.
  const heatmap = campaign?.smart_scheduling
    ? await loadCachedHeatmap(supabase)
    : null;
  const smartActive = Boolean(campaign?.smart_scheduling && heatmap);

  // Resolve the best HOUR for the local day `daysAhead` out, then build the
  // same DST-correct ISO `localHourDaysAheadIso` would, just at that hour.
  const smartDayIso = (daysAhead: number): string => {
    // The lead-local day-of-week `daysAhead` days from now (same Intl tz logic
    // used everywhere in the dialer).
    const targetMs = Date.now() + daysAhead * 24 * 60 * 60 * 1000;
    const { dayOfWeek: targetDow } = localDowHour(
      new Date(targetMs),
      tz || "America/New_York",
    );
    const startH = parseCallingHour(campaign?.calling_hours_start, 9);
    const endH = parseCallingHour(campaign?.calling_hours_end, 17);
    const hour = bestHourForDay(heatmap!, targetDow, startH, endH) ?? 9;
    return localHourDaysAheadIso(tz, daysAhead, hour);
  };

  // The single scheduling helper every future-retry branch uses. When smart
  // scheduling is active it picks the day's best hour; otherwise it's the
  // byte-for-byte original 9am behavior.
  const scheduleDayIso = (daysAhead: number): string =>
    smartActive ? smartDayIso(daysAhead) : localHourDaysAheadIso(tz, daysAhead);

  // The unified 2d/2d/15d retry cycle: bump retry_counter, advance
  // retry_position 0→1→2→0, push next_call_at by the position's delay, and keep
  // the lead `ready_to_call`. Shared by the retry outcomes and the
  // terminal-but-unmapped default below (FIX C / #9).
  const applyUnifiedRetryCycle = (): void => {
    const position = ((lead?.retry_position ?? 0) % 3) as 0 | 1 | 2;
    const delayDays = RETRY_DELAY_DAYS[position];
    update.retry_counter = (lead?.retry_counter ?? 0) + 1;
    update.retry_position = (position + 1) % 3;
    update.next_call_at = scheduleDayIso(delayDays);
    update.status = "ready_to_call";
    update.resting_until = null;
  };

  if (!call.outcome) {
    // FIX C (#9): a TERMINAL call (we only reach here when callIsTerminal) with
    // no mapped outcome. No later webhook will ever set one (idempotency-
    // deduped), so default it onto the unified retry cycle so the lead keeps
    // progressing instead of stalling forever. The call's stored outcome stays
    // honestly NULL — only the lead's schedule advances.
    applyUnifiedRetryCycle();
  } else if (RETRY_OUTCOMES.has(call.outcome)) {
    applyUnifiedRetryCycle();
  } else if (RESTING_OUTCOMES[call.outcome] !== undefined) {
    const days = RESTING_OUTCOMES[call.outcome];
    const restingUntil = scheduleDayIso(days);
    update.status = "resting";
    update.resting_until = restingUntil;
    update.next_call_at = restingUntil;
    update.retry_counter = 0;
    update.retry_position = 0;
    update.call_back_later_count = 0;
  } else if (call.outcome === "call_back_later") {
    // Busy brush-off: try again the NEXT DAY, up to a couple of times, then
    // rest so we stop pestering. Calling hours are enforced at dial time by
    // pre_call_check, so a next-day timestamp can't dial outside hours.
    //
    // FIX D (#10): count call_back_later attempts on their OWN counter
    // (call_back_later_count), NOT the unified retry_counter. Otherwise a lead
    // with prior voicemails who then says "call me back later" inherits that
    // voicemail count and jumps straight to the 15-day rest — the opposite of
    // the intent. A fresh call_back_later always gets its own short next-day
    // cycle regardless of voicemail history.
    const attempts = (lead?.call_back_later_count ?? 0) + 1;
    if (attempts > 2) {
      const restingUntil = scheduleDayIso(15);
      update.status = "resting";
      update.resting_until = restingUntil;
      update.next_call_at = restingUntil;
      update.call_back_later_count = 0;
    } else {
      update.call_back_later_count = attempts;
      update.next_call_at = scheduleDayIso(1);
      update.status = "ready_to_call";
      update.resting_until = null;
    }
  } else if (TERMINAL_OUTCOMES[call.outcome] !== undefined) {
    update.status = TERMINAL_OUTCOMES[call.outcome].status;
    update.next_call_at = null;
    update.resting_until = null;
    update.retry_counter = 0;
    update.retry_position = 0;
    update.call_back_later_count = 0;
  } else {
    // An enum outcome the engine still doesn't bucket. Roll back the claim so a
    // later code path can pick this up if needed.
    await supabase
      .from("calls")
      .update({ retry_applied_at: null })
      .eq("id", callId);
    return { ok: false, reason: `unhandled_outcome:${call.outcome}` };
  }

  const { error: leadError } = await supabase
    .from("leads")
    .update(update)
    .eq("id", call.lead_id);
  if (leadError) return { ok: false, reason: "could_not_update_lead" };

  return { ok: true, status: "applied" };
}

/**
 * Force the retry engine to re-derive a lead's schedule from ONE call's
 * disposition, even if retry was already applied for that call. Clears the
 * idempotency stamp (`retry_applied_at`) and re-runs `applyRetryForCall`.
 *
 * Used when a scheduled callback is REMOVED and the lead should fall back to
 * whatever its latest call's disposition dictates (e.g. a gatekeeper call →
 * the unified 2-day retry) instead of being left with no Next call. Mirrors
 * the clear-then-reapply pattern `overrideCallOutcome` already uses.
 *
 * Returns true when the engine actually rescheduled the lead (`applied`);
 * false when it no-opped — the outcome is owned elsewhere (callback / dnc /
 * invalid_number / language_barrier) or the call is still in flight — so the
 * caller can apply its own fallback.
 */
export async function reapplyRetryForCall(callId: string): Promise<boolean> {
  const supabase = makeServiceClient();
  await supabase
    .from("calls")
    .update({ retry_applied_at: null })
    .eq("id", callId);
  const result = await applyRetryForCall(callId);
  return result.ok === true && result.status === "applied";
}

/**
 * Mark a call terminally FAILED and run the retry engine for it (Improvement 1).
 *
 * Several terminal-failure write paths used to flip a call to failed/failed but
 * never reschedule the lead, so the lead kept whatever next_call_at it had —
 * often a 2-minute claim lease or a 30-min placeholder — and got redialed far
 * too fast, never progressing to the 2-day cool-off (bugs #6 / #8). This helper
 * is the single place that does BOTH: set status='failed' + outcome='failed',
 * then call `applyRetryForCall` so the lead lands on the proper 2-day backoff.
 *
 * Idempotent via the retry engine's CAS on `retry_applied_at`. The caller
 * provides the supabase client so this can share the caller's service client.
 */
export async function finalizeFailedCall(
  supabase: SupabaseAdmin,
  callId: string,
): Promise<void> {
  await supabase
    .from("calls")
    .update({ status: "failed", outcome: "failed" })
    .eq("id", callId);
  await applyRetryForCall(callId);
}

/**
 * Escalate a callback voicemail per BUILD_PLAN §8:
 *   1st VM → push next_call_at by 30 min
 *   2nd VM → schedule next day same time-of-day
 *   3rd VM → mark callback `missed`, move lead to resting for 15 days
 *
 * Reads + bumps `callbacks.voicemail_attempts` on the most recent pending
 * callback for the lead. Mutates the passed `update` patch in place. Returns
 * true when an active callback was found (and escalation was applied);
 * false when no pending callback exists (caller falls back to the standard
 * retry cycle).
 */
async function escalateCallbackVoicemail(
  supabase: SupabaseAdmin,
  leadId: string,
  update: LeadUpdate,
  timeZone: string | null,
): Promise<boolean> {
  const { data: callback } = await supabase
    .from("callbacks")
    .select("id, scheduled_at, voicemail_attempts")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!callback) return false;

  const attempts = (callback.voicemail_attempts ?? 0) + 1;

  if (attempts >= 3) {
    // 3rd voicemail → callback missed, lead to resting for 15 days.
    await supabase
      .from("callbacks")
      .update({ status: "missed", voicemail_attempts: attempts })
      .eq("id", callback.id);
    const restingUntil = rollIsoOffWeekend(
      new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
      timeZone,
    );
    update.status = "resting";
    update.resting_until = restingUntil;
    update.next_call_at = restingUntil;
    update.retry_counter = 0;
    update.retry_position = 0;
    return true;
  }

  // 1st voicemail: +30 min, as-is — a callback the customer booked for a
  // Saturday is honoured on that Saturday, so a same-day nudge must not roll.
  //
  // 2nd voicemail: next day, same time — but this one is OUR reschedule, not
  // the customer's chosen slot, so it skips the weekend (Sat/Sun -> Monday) in
  // the lead's local time rather than landing on a closed business.
  const next =
    attempts === 1
      ? new Date(Date.now() + 30 * 60 * 1000).toISOString()
      : rollIsoOffWeekend(
          new Date(
            new Date(callback.scheduled_at).getTime() + 24 * 60 * 60 * 1000,
          ),
          timeZone,
        );

  await supabase
    .from("callbacks")
    .update({
      voicemail_attempts: attempts,
      scheduled_at: next,
    })
    .eq("id", callback.id);

  // Lead stays in 'callback' status; just bump next_call_at to match.
  update.status = "callback";
  update.next_call_at = next;
  update.resting_until = null;
  return true;
}
