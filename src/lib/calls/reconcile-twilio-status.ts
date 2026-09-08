import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { mapChunks } from "@/lib/leads/chunk";
import type { Database } from "@/lib/supabase/database.types";
import {
  STATUS_TO_OUTCOME,
  TERMINAL,
  TWILIO_TO_DB_STATUS,
  type TwilioCallStatus,
} from "@/lib/twilio/status-webhook";

type Admin = SupabaseClient<Database>;

/**
 * Ask Twilio what actually happened to the calls we recorded as failures.
 *
 * WHY THIS EXISTS. Outbound calls are placed by ElevenLabs through its native
 * Twilio integration, and every number's StatusCallback points at ElevenLabs,
 * not at us:
 *
 *     status_webhook_url -> https://api.elevenlabs.io/twilio/status-callback
 *
 * (see `expectedNumberWebhooks` in @/lib/twilio/numbers — pointing it back at
 * this app is what broke inbound in #222, so it is not moving). The upshot is
 * that `processTwilioStatus` — which already knows busy means busy and
 * no-answer means no_answer — NEVER RUNS for these calls. Every outcome comes
 * from ElevenLabs' post-call webhook instead (583 of 589 calls on 2026-09-08
 * carried `outcome_source: 'elevenlabs'`), and ElevenLabs reports anything that
 * did not connect as a flat `failed`.
 *
 * Checked against Twilio's own records on 2026-09-08, of 84 calls we had
 * marked `status='failed'`:
 *
 *     Twilio failed     47
 *     Twilio no-answer  22
 *     Twilio busy       15
 *
 * So 37 of 84 were ordinary dialing outcomes wearing a failure label. The app
 * logged 87 `failed` that day and 5 `no_answer`/`busy` combined.
 *
 * This module is the backstop: for calls we marked failed, read the Twilio call
 * resource and re-label from the SAME map the status webhook would have used —
 * imported from status-webhook.ts, never restated. Two mappings for one concept
 * is precisely the defect this codebase keeps hitting.
 *
 * ⚠️ IT MOVES THE DAILY CAP, ON PURPOSE. `pre_call_check` counts a campaign's
 * calls for the day with `status <> 'failed'`, so a call parked at `failed`
 * spends nothing against `calls_per_day_cap`. Re-labelling it `completed` makes
 * it count — which is the correct answer (a no-answer is a phone that rang, and
 * the lead heard it ring) but it is a real behaviour change: a BACKFILL over a
 * wide window can push an active campaign past its cap in one step and stop it
 * dialing for the rest of the ET day. That is not a bug in this module. If it
 * happens and the dialing was wanted, raise the cap.
 *
 * ⚠️ IT DOES NOT TOUCH THE LEAD'S RETRY SCHEDULE. Reasoning below, at
 * RETRY_LADDER.
 */

/**
 * RETRY_LADDER — the deliberate decision not to re-derive the lead's schedule.
 *
 * When a call's outcome changes, the obvious worry is that the retry engine
 * scheduled the lead off the wrong outcome and should be re-run
 * (`reapplyRetryForCall`). Here it must not be, for two independent reasons.
 *
 * 1. THERE IS NOTHING TO CORRECT. In @/lib/dialer/retry-engine, `failed`,
 *    `no_answer` and `busy` all sit in the SAME two sets:
 *      - RETRY_OUTCOMES            -> all three run applyUnifiedRetryCycle():
 *                                     the identical 2d / 2d / 15d ladder, the
 *                                     identical retry_counter bump, the
 *                                     identical `ready_to_call`.
 *      - CALLBACK_NONCONNECT_OUTCOMES -> all three escalate a pending callback
 *                                     the identical +30min / next-day / missed
 *                                     way.
 *    And `shouldScheduleRedial` fires on `voicemail` ONLY, so none of the three
 *    mints a double-call marker. The schedule these leads are on is byte-for-
 *    byte the schedule they would be on had the outcome read `no_answer` from
 *    the start. Re-running the engine would compute the same answer.
 *
 * 2. RE-RUNNING IT WOULD DO HARM. `reapplyRetryForCall` clears
 *    `retry_applied_at` and runs `applyRetryForCall` again against a lead whose
 *    state has already MOVED ON. It re-reads `lead.retry_position` AFTER the
 *    first run advanced it, so the cycle advances a second time (a lead
 *    correctly parked 15 days out collapses to 2, or vice versa) and
 *    retry_counter double-bumps. On a lead with a pending callback it bumps
 *    `voicemail_attempts` again and pushes `scheduled_at` again — and a third
 *    such bump marks the callback `missed` outright. If the lead has been
 *    dialed again in the meantime, it rewrites `next_call_at` from a stale
 *    call. The retry engine's own `endedRecently` guard exists because of
 *    exactly this hazard.
 *
 * So: relabel the CALL, leave the LEAD alone. This module writes only to the
 * `calls` row. If a future outcome is ever added to this reconcile that is NOT
 * in RETRY_OUTCOMES — `canceled` is the one already reachable through the
 * shared map, and it carries no outcome inference so the lead's ladder still
 * came from the unchanged `failed` outcome — revisit reason 1 before assuming
 * this still holds.
 */

const TWILIO_API = "https://api.twilio.com/2010-04-01/Accounts";

/**
 * Outcomes a reconcile is allowed to overwrite: nothing (the row was never
 * dispositioned) or `failed` itself.
 *
 * The select already narrows to `status = 'failed'`, but this is asserted in
 * code rather than trusted from the query. A row that somehow reads
 * status='failed' with outcome='goal_met' / 'voicemail' / 'callback' carries
 * information Twilio's bare CallStatus cannot see, and overwriting it would
 * lose a booked meeting to a line-level status.
 */
const OVERWRITABLE_OUTCOMES = new Set<string | null>([null, "failed"]);

/** Twilio has no batch "give me these SIDs" endpoint, so each call is its own
 *  GET. Reads are cheap but not free, and a backfill can be hundreds of rows;
 *  five in flight is quick without leaning on the API. */
const TWILIO_CONCURRENCY = 5;

/** How far back to look when the caller doesn't say. */
export const DEFAULT_SINCE_HOURS = 48;

/** How many rows one run will examine when the caller doesn't say. */
export const DEFAULT_LIMIT = 500;

export type ReconcileOptions = {
  /** Only consider calls created within this many hours. Default 48. */
  sinceHours?: number;
  /** Cap on rows examined in one run, newest first. Default 500. */
  limit?: number;
  /** Report what would change and write nothing. Default false. */
  dryRun?: boolean;
  /** Injectable clock, for tests. */
  now?: Date;
};

export type ReconcileSummary = {
  /** Rows we asked Twilio about. Rows skipped by a guard (no twilio_call_sid,
   *  an outcome we refuse to overwrite) are not counted here, in `updated`, or
   *  in `errors` — they were never checked. */
  checked: number;
  /** Rows re-labelled. Always 0 on a dry run — the dry run reports what it
   *  WOULD have written here. */
  updated: number;
  /** Census of what Twilio said, keyed by Twilio's own CallStatus, over every
   *  checked row — including the ones that needed no change. It sums to
   *  `checked` minus `errors`. `updated` is the sum of the buckets that mapped
   *  to something different from what we had, so `busy` and `no-answer` show up
   *  here AND in `updated`, while `failed` shows up here only. */
  byStatus: Record<string, number>;
  /** Lookups or writes that failed. A call whose SID Twilio does not know
   *  (404 — e.g. a synthetic SID minted in mock mode) counts here too. */
  errors: number;
};

type CallRow = {
  id: string;
  status: string;
  outcome: string | null;
  twilio_call_sid: string | null;
};

type Auth = { account: string; header: string };

/**
 * The SUBACCOUNT credentials — the same pair handed to ElevenLabs to place the
 * call (see `place-call.ts`), so the call resource is guaranteed to live on
 * this account. Not the parent's (`shaken.ts`, Trust Hub) and not the API-key
 * pair (`numbers.ts`, `usage.ts`); either would work for a read, but these are
 * the credentials that own the record.
 */
function subaccountAuth(): Auth | null {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!account || !token) return null;
  return {
    account,
    header: "Basic " + Buffer.from(`${account}:${token}`).toString("base64"),
  };
}

type Lookup = { ok: true; status: string } | { ok: false; error: string };

/** GET one call resource. Read-only; nothing here can change a Twilio call. */
async function fetchTwilioCall(auth: Auth, callSid: string): Promise<Lookup> {
  const url =
    `${TWILIO_API}/${encodeURIComponent(auth.account)}` +
    `/Calls/${encodeURIComponent(callSid)}.json`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: auth.header },
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `twilio_http_${res.status}` };
    const body = (await res.json()) as { status?: unknown };
    const status = typeof body.status === "string" ? body.status : "";
    if (!status) return { ok: false, error: "twilio_no_status" };
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "twilio_fetch_failed",
    };
  }
}

/** Whether Twilio's word is one we know AND one the call has finished on. */
function isTerminalTwilioStatus(status: string): status is TwilioCallStatus {
  return (TERMINAL as string[]).includes(status);
}

/**
 * Re-label calls we recorded as `failed` from Twilio's own record of them.
 *
 * Idempotent. A relabelled row no longer matches `status = 'failed'`, so a
 * second run does not see it at all; and the UPDATE itself is guarded on
 * `status = 'failed'` so a concurrent webhook that moved the row first wins
 * instead of being clobbered. Running this every 15 minutes forever converges
 * and then does nothing but re-read the genuinely-failed rows still inside the
 * window.
 */
export async function reconcileCallStatuses(
  supabase: Admin,
  opts: ReconcileOptions = {},
): Promise<ReconcileSummary> {
  const sinceHours = opts.sinceHours ?? DEFAULT_SINCE_HOURS;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();

  const summary: ReconcileSummary = {
    checked: 0,
    updated: 0,
    byStatus: {},
    errors: 0,
  };

  const auth = subaccountAuth();
  if (!auth) {
    // No credentials is not "nothing to do" — say so rather than reporting a
    // clean run over zero rows.
    summary.errors += 1;
    return summary;
  }

  const cutoff = new Date(
    now.getTime() - sinceHours * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("calls")
    .select("id, status, outcome, twilio_call_sid")
    .eq("status", "failed")
    .not("twilio_call_sid", "is", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    summary.errors += 1;
    return summary;
  }

  const rows = (data ?? []) as CallRow[];

  // Chunk size 1: Twilio has no by-SID batch endpoint, so every row is its own
  // request. mapChunks is here purely for its bounded worker pool (and its
  // stable, chunk-ordered results) rather than for chunking.
  await mapChunks(
    rows,
    1,
    async ([row]) => {
      // Guards asserted in code, not inferred from the select above.
      if (!row?.twilio_call_sid) return;
      if (row.status !== "failed") return;
      if (!OVERWRITABLE_OUTCOMES.has(row.outcome)) return;

      summary.checked += 1;

      const lookup = await fetchTwilioCall(auth, row.twilio_call_sid);
      if (!lookup.ok) {
        summary.errors += 1;
        return;
      }

      summary.byStatus[lookup.status] =
        (summary.byStatus[lookup.status] ?? 0) + 1;

      // A status still in motion (`ringing`, `in-progress`) means the reconcile
      // is early, not that our row is wrong. Leave it; the next run will see a
      // terminal status.
      if (!isTerminalTwilioStatus(lookup.status)) return;

      const nextStatus = TWILIO_TO_DB_STATUS[lookup.status];
      const nextOutcome = STATUS_TO_OUTCOME[lookup.status] ?? null;

      // Twilio agrees with us — the common case, and the whole of Twilio
      // `failed`. No write at all.
      const statusSame = nextStatus === row.status;
      const outcomeSame = nextOutcome === null || nextOutcome === row.outcome;
      if (statusSame && outcomeSame) return;

      if (dryRun) {
        summary.updated += 1;
        return;
      }

      const patch: Database["public"]["Tables"]["calls"]["Update"] = {
        status: nextStatus,
      };
      if (nextOutcome !== null) {
        patch.outcome = nextOutcome;
        // Twilio is now the authority for this row's disposition, and saying so
        // is what stops the next audit re-deriving it from ElevenLabs.
        patch.outcome_source = "twilio";
      }

      const { error: updateError } = await supabase
        .from("calls")
        .update(patch)
        .eq("id", row.id)
        // Re-assert the precondition at write time: if anything moved this row
        // off `failed` since the select, that writer knew more than we do.
        .eq("status", "failed");
      if (updateError) {
        summary.errors += 1;
        return;
      }
      summary.updated += 1;

      // Deliberately NOT calling reapplyRetryForCall here. See RETRY_LADDER at
      // the top of this file: failed / no_answer / busy share one retry bucket,
      // so there is nothing to re-derive, and re-running the engine on a lead
      // that has already moved on double-advances its cycle.
    },
    TWILIO_CONCURRENCY,
  );

  return summary;
}
