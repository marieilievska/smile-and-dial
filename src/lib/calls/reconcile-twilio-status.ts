import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { applyOutcomeSideEffects } from "@/lib/elevenlabs/post-call-webhook";
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
 * IT ALSO READS THE ERROR CODE. Twilio's `status` says a call failed;
 * `error_code` says why, and that is a different question with a much sharper
 * consequence — see DEAD_NUMBERS below. The code is persisted on every pass,
 * relabel or not, so the short list of codes we act on can grow on recorded
 * evidence instead of on guesswork.
 *
 * ⚠️ IT MOVES THE DAILY CAP, ON PURPOSE. `pre_call_check` counts a campaign's
 * calls for the day with `status <> 'failed'`, so a call parked at `failed`
 * spends nothing against `calls_per_day_cap`. Re-labelling it `completed` makes
 * it count — which is the correct answer (a no-answer is a phone that rang, and
 * the lead heard it ring) but it is a real behaviour change: a BACKFILL over a
 * wide window can push an active campaign past its cap in one step and stop it
 * dialing for the rest of the ET day. That is not a bug in this module. If it
 * happens and the dialing was wanted, raise the cap. (A dead number keeps
 * `status = 'failed'` and so still spends nothing — correct: it never rang.)
 *
 * ⚠️ IT TOUCHES THE LEAD ON EXACTLY ONE PATH. Reasoning below, at
 * RETRY_LADDER.
 */

/**
 * DEAD_NUMBERS — why the list below is two codes long and hard to add to.
 *
 * A `failed` call is one of two completely different events wearing one label:
 *
 *   * THE DESTINATION IS DEAD. The number is invalid, or unreachable by
 *     nature. Dialing it again is pure waste and, worse, it keeps a corpse in
 *     the rotation ahead of leads that could answer.
 *   * SOMETHING ON OUR SIDE BROKE. A bridging fault, a permissions gap, a
 *     quota. The number may be perfectly live.
 *
 * The consequences are wildly asymmetric. Suppressing a lead is effectively
 * permanent: it goes to `dnc`, a `dnc_entries` row blocks it at dial time, and
 * nothing automatic ever brings it back — a person has to notice and undo it.
 * Missing a genuinely dead number costs a few wasted dials. So this errs, hard,
 * toward not suppressing. Twilio's own guidance is to avoid building logic on
 * error codes at all; the two below are on the list because they are
 * unambiguously statements about the DESTINATION, not about us.
 */

/** Twilio error codes that mean the DESTINATION NUMBER is invalid or
 *  unreachable-by-nature, so the lead should be suppressed.
 *
 *  Deliberately short. Twilio's own guidance is to avoid building logic on
 *  error codes, and the asymmetry here is brutal: a wrong suppression
 *  permanently deletes a real lead, a missed one costs a few wasted dials.
 *  Codes are added only once observed in production — twilio_error_code is
 *  persisted on every pass precisely so this list can grow on evidence.
 *
 *  NOT ON THIS LIST, and each exclusion is load-bearing:
 *
 *    * 21215 — "Account not authorized to call this number." This is a
 *      GEOLOCATION PERMISSION on OUR Twilio account: we are not allowed to
 *      dial that region. It says nothing whatever about the number, which may
 *      be somebody sitting by a live phone waiting for the call. Suppressing
 *      on it would permanently delete real leads because of a checkbox in our
 *      own console.
 *    * 21219 — "Number not verified." A trial-account limitation, ours again.
 *      Same reasoning, same answer.
 *    * NO ERROR CODE AT ALL — the 47 calls sitting at `failed` on 2026-09-08,
 *      every one of them with price $0.00000 and an ElevenLabs conversation
 *      stuck at `initiated`. That is ElevenLabs failing to bridge the call to
 *      Twilio; the phone was never dialed, so nothing was learned about it.
 *      A codeless failure NEVER suppresses. It is the single most common
 *      failure we have, and treating it as 47 dead numbers would have been the
 *      most expensive mistake this module could make. */
export const DEAD_NUMBER_CODES = new Set([
  13224, // Twilio does not support calling this number, or it is invalid
  21211, // Invalid 'To' phone number
]);

/**
 * RETRY_LADDER — when to re-derive the lead's state, and when not to.
 *
 * #505 decided, deliberately, never to touch the lead. That decision still
 * holds for every path but one, and the one exception REVERSES it. Both halves
 * are below, because the contrast is the whole reasoning.
 *
 * ── no-answer / busy / plain failed: LEAVE THE LEAD ALONE ────────────────────
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
 * ── invalid_number: THE LEAD MUST BE TAKEN OUT OF ROTATION ───────────────────
 *
 * Reason 1 above does not survive the move to `invalid_number`, and that is
 * precisely why this path is different rather than an inconsistency. The three
 * outcomes above share a retry bucket; `invalid_number` is not in that bucket
 * at all. It is a DNC-FAMILY, TERMINAL outcome, and the retry engine says so
 * itself: `applyRetryForCall` returns `outcome_handled_elsewhere` for
 * dnc / invalid_number / language_barrier / callback and touches nothing. So if
 * we relabelled the call and stopped there, NOBODY would move the lead. It
 * would keep the `ready_to_call` status and the +2-day `next_call_at` the
 * ORIGINAL `failed` outcome scheduled, and the dialer would come back for a
 * number Twilio has told us is dead — every two days, forever.
 *
 * Reason 2 does not apply either: the fix here is not to re-run the retry
 * engine (which would no-op anyway) but to run the side effects that own this
 * outcome — the SAME `applyOutcomeSideEffects` the post-call webhook, the
 * manual-override action and the human-disposition path all call. There is one
 * implementation of "what happens when a number is bad" and this is a fourth
 * caller of it, not a second copy.
 *
 * WHAT THAT LEAVES THE LEAD AS, and why it is genuinely out of `dial_queue`:
 * the side effects set `status = 'dnc'` and `next_call_at = null`, and insert
 * the number onto its OWNER's `dnc_entries` list. `dial_queue` requires
 * `l.status in ('ready_to_call','callback')` AND anti-joins
 * `dnc_entries d where d.phone = l.business_phone and d.owner_id = l.owner_id`.
 * Either one alone removes the lead; both fire here, and `pre_call_check`
 * refuses the stage a second time at placement (`if v_lead.status = 'dnc'`).
 * Note that clearing `next_call_at` is NOT what does it — a null `next_call_at`
 * reads as DUE NOW in that view. The status and the DNC row are the gates.
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
 *
 * It is also what makes the suppression path idempotent. A dead number keeps
 * `status = 'failed'` — Twilio's own map says failed maps to failed — so
 * unlike a relabelled no-answer the row does NOT leave the working set. It is
 * this guard that stops a second pass re-suppressing it: `invalid_number` is
 * not overwritable, so the row is skipped before Twilio is even asked.
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

/** Census key for a Twilio failure that carried no error code — the common
 *  case, and the one that must never suppress. */
export const NO_ERROR_CODE = "none";

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
   *  WOULD have written here. A row written ONLY to record a newly-seen
   *  `twilio_error_code` is not a relabel and is not counted; `errorCodes`
   *  below is where that shows up. */
  updated: number;
  /** Rows whose lead was sent to DNC as a dead number — a subset of `updated`.
   *  Reported (not written) on a dry run, like `updated`. This is the number
   *  to look at first: it is the only irreversible thing this module does. */
  suppressed: number;
  /** Census of what Twilio said, keyed by Twilio's own CallStatus, over every
   *  checked row — including the ones that needed no change. It sums to
   *  `checked` minus `errors`. `updated` is the sum of the buckets that mapped
   *  to something different from what we had, so `busy` and `no-answer` show up
   *  here AND in `updated`, while `failed` shows up here only. */
  byStatus: Record<string, number>;
  /** Census of Twilio's `error_code` over the same rows, keyed by the code as
   *  a string with NO_ERROR_CODE for the ones that carried none. This is the
   *  evidence DEAD_NUMBER_CODES is meant to grow on: run a dry run, read this,
   *  and a code that shows up repeatedly can be investigated on its merits
   *  instead of guessed at. Sums to the same total as `byStatus`. */
  errorCodes: Record<string, number>;
  /** Lookups or writes that failed. A call whose SID Twilio does not know
   *  (404 — e.g. a synthetic SID minted in mock mode) counts here too. */
  errors: number;
};

type CallRow = {
  id: string;
  status: string;
  outcome: string | null;
  twilio_call_sid: string | null;
  twilio_error_code: number | null;
  lead_id: string;
  campaign_id: string | null;
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

type Lookup =
  | { ok: true; status: string; errorCode: number | null }
  | { ok: false; error: string };

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
    const body = (await res.json()) as {
      status?: unknown;
      error_code?: unknown;
    };
    const status = typeof body.status === "string" ? body.status : "";
    if (!status) return { ok: false, error: "twilio_no_status" };
    return { ok: true, status, errorCode: parseErrorCode(body.error_code) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "twilio_fetch_failed",
    };
  }
}

/**
 * Twilio sends `error_code` as a JSON number, but it is null on most calls and
 * has been observed as a numeric STRING on some resources. Anything that is not
 * a finite integer becomes null — "we do not know why" — because the one thing
 * this value must never do is coerce into a number that happens to sit in
 * DEAD_NUMBER_CODES.
 */
function parseErrorCode(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isInteger(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

/** Whether Twilio's word is one we know AND one the call has finished on. */
function isTerminalTwilioStatus(status: string): status is TwilioCallStatus {
  return (TERMINAL as string[]).includes(status);
}

/**
 * Re-label calls we recorded as `failed` from Twilio's own record of them.
 *
 * Idempotent. A relabelled no-answer or busy no longer matches
 * `status = 'failed'`, so a second run does not see it at all; a suppressed
 * dead number keeps `status = 'failed'` but leaves via OVERWRITABLE_OUTCOMES
 * instead, before Twilio is asked and long before anything is written. The
 * UPDATE itself is guarded on `status = 'failed'` so a concurrent webhook that
 * moved the row first wins instead of being clobbered. Running this every 15
 * minutes forever converges and then does nothing but re-read the
 * genuinely-failed rows still inside the window.
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
    suppressed: 0,
    byStatus: {},
    errorCodes: {},
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
    .select(
      "id, status, outcome, twilio_call_sid, twilio_error_code, lead_id, campaign_id",
    )
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
      const codeKey =
        lookup.errorCode === null ? NO_ERROR_CODE : String(lookup.errorCode);
      summary.errorCodes[codeKey] = (summary.errorCodes[codeKey] ?? 0) + 1;

      // A status still in motion (`ringing`, `in-progress`) means the reconcile
      // is early, not that our row is wrong. Leave it; the next run will see a
      // terminal status.
      if (!isTerminalTwilioStatus(lookup.status)) return;

      const nextStatus = TWILIO_TO_DB_STATUS[lookup.status];

      // The one place Twilio's STATUS is not the whole story. A failure whose
      // error code names the DESTINATION as dead is not the same event as a
      // failure that names our own plumbing — see DEAD_NUMBERS above for why
      // the list is two entries long and why a codeless failure (today's 47)
      // is deliberately not one of them.
      const deadNumber =
        lookup.status === "failed" &&
        lookup.errorCode !== null &&
        DEAD_NUMBER_CODES.has(lookup.errorCode);

      const nextOutcome = deadNumber
        ? "invalid_number"
        : (STATUS_TO_OUTCOME[lookup.status] ?? null);

      const statusSame = nextStatus === row.status;
      const outcomeSame = nextOutcome === null || nextOutcome === row.outcome;
      const codeSame = lookup.errorCode === (row.twilio_error_code ?? null);

      // Twilio agrees with us AND has told us nothing new about why — the
      // common case, and the whole of a codeless Twilio `failed`. No write at
      // all, which is what keeps a 15-minute cron from rewriting the same 47
      // unchanged rows ninety-six times a day.
      if (statusSame && outcomeSame && codeSame) return;

      // A write that only records the error code is not a relabel, so it does
      // not count as `updated`; `errorCodes` is where it shows up.
      const relabelled = !statusSame || !outcomeSame;

      if (dryRun) {
        if (relabelled) summary.updated += 1;
        if (deadNumber) summary.suppressed += 1;
        return;
      }

      const patch: Database["public"]["Tables"]["calls"]["Update"] = {};
      if (!statusSame) patch.status = nextStatus;
      if (nextOutcome !== null && !outcomeSame) {
        patch.outcome = nextOutcome;
        // Twilio is now the authority for this row's disposition, and saying so
        // is what stops the next audit re-deriving it from ElevenLabs.
        patch.outcome_source = "twilio";
      }
      // Persisted whenever it has changed, relabel or not: this column is the
      // evidence DEAD_NUMBER_CODES grows on, and evidence that is only recorded
      // when we already knew the answer is not evidence.
      if (!codeSame) patch.twilio_error_code = lookup.errorCode;

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
      if (relabelled) summary.updated += 1;

      // Deliberately NOT calling reapplyRetryForCall on the no-answer / busy /
      // plain-failed paths. See RETRY_LADDER at the top of this file: those
      // three share one retry bucket, so there is nothing to re-derive, and
      // re-running the engine on a lead that has already moved on
      // double-advances its cycle.
      if (!deadNumber) return;

      // …and deliberately DOING it here, for the one outcome that reverses the
      // reasoning. `invalid_number` is DNC-family and terminal: the retry
      // engine explicitly declines to own it, so without this the lead keeps
      // the +2-day schedule its `failed` outcome bought and we dial a dead
      // number forever. This is the same entry point the post-call webhook,
      // the manual outcome override and the human-disposition path use — one
      // implementation of "the number is bad", four callers.
      try {
        await applyOutcomeSideEffects(supabase, {
          callId: row.id,
          leadId: row.lead_id,
          // Only the goal_met branch reads the campaign, and this outcome can
          // never be goal_met, so a call with no campaign is safe here.
          campaignId: row.campaign_id ?? "",
          outcome: nextOutcome,
          callbackDatetime: null,
        });
        summary.suppressed += 1;
      } catch {
        // Count it and carry on, the way every other failure in this loop is
        // handled. mapChunks runs these on a shared worker pool and does NOT
        // isolate a rejection: one throw here would abort the whole batch and
        // throw away the summary with it, so a single odd lead must not be
        // able to stop the other 499.
        //
        // Honest about what this leaves behind: the call now reads
        // `invalid_number` while the lead was not moved, and the outcome guard
        // means no later pass will retry the suppression. That is no worse
        // than before this feature (nothing suppressed the lead then either),
        // but it is a state a person has to fix, so it is counted as an error
        // rather than passed over in silence.
        summary.errors += 1;
      }
    },
    TWILIO_CONCURRENCY,
  );

  return summary;
}
