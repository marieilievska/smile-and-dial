import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveDueCallbacksForLead } from "@/lib/callbacks/sync-next-call";
import { resolveAndPlaceAgentCall } from "@/lib/dialer/agent-dial";
import { countryForAreaCode } from "@/lib/dialer/nanp-states";
import {
  areaCodeOf,
  selectPoolNumber,
  usableRedialNumber,
} from "@/lib/dialer/number-pool";
import { finalizeFailedCall } from "@/lib/dialer/retry-engine";
import { isCampaignLevelBlock } from "@/lib/dialer/block-scope";
import { closeStaleActiveCalls } from "@/lib/dialer/stale-calls";
import { enforceElevenLabsCreditGate } from "@/lib/dialer/credit-gate";
import { sweepStuckCallbacks } from "@/lib/callbacks/sweep";

import { type PreCallReason } from "./queue";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

export type TickSummary = {
  candidates: number;
  dialed: number;
  blocked: number;
  errors: number;
  blockedReasons: Record<string, number>;
  /** Candidates skipped without a pre_call_check round trip because their
   *  campaign had already refused for a campaign-level reason this tick. */
  skippedCampaignBlocked: number;
  /** How many active campaigns this tick read candidates for, and how many
   *  each contributed. Makes the fair share visible in the cron response:
   *  a campaign sitting at 0 while another is at 25 is the shape of the
   *  starvation bug this replaced. */
  campaignsRead: number;
  candidatesByCampaign: Record<string, number>;
  /** Set when there were more active campaigns than MAX_CAMPAIGN_FANOUT, so
   *  some got no candidates at all this tick. Never silently truncate. */
  campaignsSkippedForFanoutCap?: number;
  /** Stuck-callback cleanup this tick: zombie callbacks cancelled (lead went
   *  terminal/deleted) + mis-statused dialable leads re-parked as callbacks.
   *  Best-effort — a sweep failure never breaks the tick. */
  callbacksSwept?: { cancelled: number; resynced: number };
  liveMode: { twilio: boolean; elevenlabs: boolean };
};

/** Result of one live placement: a dialed call id, a graceful skip because the
 *  lead already has an in-flight AI outbound call, a pool-exhausted skip (no
 *  usable number right now), a redial whose call-1 number is no longer usable
 *  (retired/rested/flagged), or a genuine error (all null/false). */
type LivePlaceResult = {
  callId: string | null;
  inFlight?: boolean;
  poolExhausted?: boolean;
  /** A redial (call 2) declined because usableRedialNumber() rejected call 1's
   *  number. Named separately from a generic error so an operator who turns
   *  double-calling on and sees no second calls has a specific signal to look
   *  at — see the same-number comment at the call site for why this skips
   *  rather than falling back to a different pool number. */
  redialNumberUnusable?: boolean;
};

type MockOutcome = {
  outcome:
    | "voicemail"
    | "no_answer"
    | "goal_met"
    | "not_interested"
    | "callback";
  durationSeconds: number;
  talkTimeSeconds: number;
  goalMet: boolean;
};

// Mock outcome distribution that roughly matches a realistic call mix.
// Weights are relative; they get normalized to 1 by `pickMockOutcome`.
const MOCK_OUTCOMES: { weight: number; outcome: MockOutcome }[] = [
  {
    weight: 50,
    outcome: {
      outcome: "voicemail",
      durationSeconds: 18,
      talkTimeSeconds: 0,
      goalMet: false,
    },
  },
  {
    weight: 20,
    outcome: {
      outcome: "no_answer",
      durationSeconds: 30,
      talkTimeSeconds: 0,
      goalMet: false,
    },
  },
  {
    weight: 15,
    outcome: {
      outcome: "not_interested",
      durationSeconds: 45,
      talkTimeSeconds: 25,
      goalMet: false,
    },
  },
  {
    weight: 10,
    outcome: {
      outcome: "goal_met",
      durationSeconds: 120,
      talkTimeSeconds: 90,
      goalMet: true,
    },
  },
  {
    weight: 5,
    outcome: {
      outcome: "callback",
      durationSeconds: 60,
      talkTimeSeconds: 35,
      goalMet: false,
    },
  },
];

function pickMockOutcome(): MockOutcome {
  const total = MOCK_OUTCOMES.reduce((sum, o) => sum + o.weight, 0);
  let r = Math.random() * total;
  for (const o of MOCK_OUTCOMES) {
    r -= o.weight;
    if (r <= 0) return o.outcome;
  }
  return MOCK_OUTCOMES[0].outcome;
}

/** Build a service-role client tied to the project URL + service role key. */
function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Dialer tick requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Place a single mock call. Inserts a `calls` row with a believable outcome
 * and bumps the lead so it isn't re-picked immediately. Returns the inserted
 * call's id, or null if the insert failed.
 */
async function placeMockCall(
  supabase: SupabaseAdmin,
  c: {
    lead_id: string;
    campaign_id: string;
    agent_id: string | null;
    twilio_number_id: string | null;
  },
): Promise<string | null> {
  const mock = pickMockOutcome();
  const startedAt = new Date();
  const answeredAt =
    mock.talkTimeSeconds > 0 ? new Date(startedAt.getTime() + 3_000) : null;
  const endedAt = new Date(startedAt.getTime() + mock.durationSeconds * 1_000);

  const { data: call, error } = await supabase
    .from("calls")
    .insert({
      lead_id: c.lead_id,
      campaign_id: c.campaign_id,
      agent_id: c.agent_id,
      twilio_number_id: c.twilio_number_id,
      direction: "outbound",
      status: "completed",
      outcome: mock.outcome,
      outcome_source: "twilio",
      goal_met: mock.goalMet,
      started_at: startedAt.toISOString(),
      answered_at: answeredAt?.toISOString() ?? null,
      ended_at: endedAt.toISOString(),
      duration_seconds: mock.durationSeconds,
      talk_time_seconds: mock.talkTimeSeconds,
      // Mocked cost — pennies, mirrors what real Twilio + ElevenLabs would log.
      cost_breakdown: {
        twilio: 0.02,
        elevenlabs: 0.05,
        openai: 0,
        lookup: 0,
        total: 0.07,
      },
    })
    .select("id")
    .single();

  if (error || !call) return null;

  // We just dialed the lead. A due callback is only fulfilled when the call
  // actually connected — pass the mock outcome so a mocked voicemail / no-answer
  // leaves the callback PENDING for the escalation ladder (#23), while a goal_met
  // / callback / not_interested completes it.
  await resolveDueCallbacksForLead(supabase, c.lead_id, {
    outcome: mock.outcome,
  });

  // Push next_call_at out so this lead isn't re-picked immediately. The real
  // retry engine (Step 24) replaces this with proper per-outcome scheduling.
  await supabase
    .from("leads")
    .update({
      last_call_at: startedAt.toISOString(),
      call_attempts: (await currentAttempts(supabase, c.lead_id)) + 1,
      next_call_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq("id", c.lead_id);

  return call.id;
}

/**
 * Atomically claim a lead for dialing AND stamp its owning campaign, via the
 * `claim_lead_for_dial` SQL function. It leases `next_call_at` 2 minutes into
 * the future only if the lead is still due, and only if the lead is un-owned or
 * already owned by THIS campaign — stamping ownership on a first win. Postgres
 * serializes the row write, so two campaigns (or two ticks) racing on the same
 * un-owned lead resolve to exactly one owner; the loser gets `false` and skips.
 * This single statement is the whole cross-campaign double-call guarantee.
 */
async function claimLeadForDial(
  supabase: SupabaseAdmin,
  leadId: string,
  campaignId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_lead_for_dial", {
    in_lead_id: leadId,
    in_campaign_id: campaignId,
  });
  if (error) return false;
  return data === true;
}

async function currentAttempts(
  supabase: SupabaseAdmin,
  leadId: string,
): Promise<number> {
  const { data } = await supabase
    .from("leads")
    .select("call_attempts")
    .eq("id", leadId)
    .single();
  return data?.call_attempts ?? 0;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A campaign's `dial_interval_seconds` (min seconds between cold dials), cached
 *  per tick so we look each campaign up at most once. 0 = no pacing. */
async function campaignDialInterval(
  supabase: SupabaseAdmin,
  campaignId: string,
  cache: Map<string, number>,
): Promise<number> {
  const hit = cache.get(campaignId);
  if (hit !== undefined) return hit;
  const { data } = await supabase
    .from("campaigns")
    .select("dial_interval_seconds")
    .eq("id", campaignId)
    .maybeSingle();
  const v = data?.dial_interval_seconds ?? 0;
  cache.set(campaignId, v);
  return v;
}

/** Columns the tick needs out of `dial_queue`. `dial_priority` is not dialled
 *  on directly — it is read so the fair-share merge can restore the
 *  callbacks-first band that per-campaign reads would otherwise lose. */
const QUEUE_COLUMNS =
  "lead_id, owner_id, business_phone, campaign_id, agent_id, is_redial_due, redial_number_id, dial_priority";

/** Upper bound on how many campaigns one tick fans out to. Each campaign costs
 *  one `dial_queue` read; they run in parallel, but the bound keeps a runaway
 *  campaign count from turning one tick into hundreds of concurrent queries.
 *  Campaigns beyond this are reported in `campaignsSkippedForFanoutCap` rather
 *  than dropped silently. Well above any realistic count (2 today). */
const MAX_CAMPAIGN_FANOUT = 25;

export type QueueRow = {
  lead_id: string | null;
  owner_id: string | null;
  business_phone: string | null;
  campaign_id: string | null;
  agent_id: string | null;
  is_redial_due: boolean | null;
  redial_number_id: string | null;
  dial_priority: number | null;
};

/**
 * Merge one already-ordered candidate slice per campaign into a single tick
 * window of at most `limit` rows, giving every campaign an equal turn.
 *
 * Exported for tests: this is the whole fair-share guarantee, and it is pure —
 * no DB, no clock — so it can be tested directly rather than inferred from a
 * live dialer run. See `readFairQueue` for why per-campaign slices exist.
 */
export function mergeFairShare(
  perCampaign: QueueRow[][],
  limit: number,
): QueueRow[] {
  // Round-robin: one candidate from each campaign, then the next from each,
  // until we have `limit` or every campaign is exhausted.
  //
  // `taken` deduplicates BY LEAD across campaigns. Campaigns attached to the
  // same list see the same un-owned leads, so the same lead_id can sit in two
  // slices at once. Both copies in one window is not a correctness problem —
  // `claim_lead_for_dial` lets exactly one campaign win and the loser records
  // `already_claimed` — but it burns a candidate slot on a claim that cannot
  // succeed. Skipping it here lets the losing campaign spend that slot on its
  // next lead instead. Each campaign's cursor advances past leads another
  // campaign already took this tick, so a shared list still costs nobody
  // their fair share.
  const merged: QueueRow[] = [];
  const taken = new Set<string>();
  const cursors = perCampaign.map(() => 0);
  while (merged.length < limit) {
    let tookAny = false;
    for (let c = 0; c < perCampaign.length; c++) {
      const rows = perCampaign[c];
      while (cursors[c] < rows.length) {
        const id = rows[cursors[c]].lead_id;
        if (id !== null && !taken.has(id)) break;
        cursors[c]++;
      }
      if (cursors[c] >= rows.length) continue;
      const row = rows[cursors[c]++];
      taken.add(row.lead_id as string);
      merged.push(row);
      tookAny = true;
      if (merged.length >= limit) break;
    }
    if (!tookAny) break;
  }

  // Restore the two global bands the per-campaign reads can't see across each
  // other: a scheduled callback (dial_priority 0) is a promise to a person and
  // must still outrank every cold lead in every campaign, and a due
  // double-call redial must still fire inside its 10-minute window. Array.sort
  // is stable, so the round-robin fair share survives untouched WITHIN each
  // band — this only lifts callbacks and due redials to the front.
  merged.sort((a, b) => {
    const pa = a.dial_priority ?? 1;
    const pb = b.dial_priority ?? 1;
    if (pa !== pb) return pa - pb;
    const ra = a.is_redial_due === true ? 0 : 1;
    const rb = b.is_redial_due === true ? 0 : 1;
    return ra - rb;
  });

  return merged;
}

/**
 * Read this tick's candidates with a FAIR SHARE per campaign.
 *
 * WHY THIS IS NOT ONE GLOBAL READ (the bug this replaced): the tick used to
 * take the global top N rows of `dial_queue`. When two campaigns are attached
 * to the same list, every lead appears TWICE — once per campaign — and both
 * copies tie on every sort key (`dial_priority`, `is_redial_due`, `dest_rank`,
 * `local_match_rank`, and `queue_order`, which is null for every never-called
 * lead). A full tie means Postgres returns them in whatever order the plan
 * produces — which is arbitrary, and DRIFTS as the data underneath changes.
 * Measured in prod on 2026-08-03: for ~40 minutes the window was 50 of 50 rows
 * to ONE of two campaigns, stable across every sample; half an hour later the
 * identical query split 39/11. So the failure is not a permanent bias you
 * could sit out — it is the total absence of any fairness guarantee, and a
 * campaign can be starved completely for as long as the tie happens to hold.
 * During that 40-minute window the starved campaign had 61,735 eligible leads,
 * 20 usable numbers, and `pre_call_check` returning "clear to dial", and had
 * never been auto-dialled at all. Lead OWNERSHIP (`claim_lead_for_dial`) was
 * working correctly the whole time; a campaign that never appears in the
 * window never gets as far as claiming anything.
 *
 * It also broke the campaign-level short-circuit in the worst way: when the one
 * campaign filling the window hit its hourly cap, `isCampaignLevelBlock` quite
 * correctly skipped the remaining 49 candidates — which were all the same capped
 * campaign — so the tick dialled NOTHING while another campaign sat ready.
 *
 * So: read up to `limit` rows PER active campaign, then round-robin merge. Each
 * campaign contributes its own best candidates, and a campaign with only a few
 * eligible leads gives its unused share back to the others instead of wasting
 * it. Filtering by campaign_id is also cheaper than the global read, not more
 * expensive — the planner prunes on it (measured: 1990ms global vs 894ms for
 * two campaigns in parallel).
 */
async function readFairQueue(
  supabase: SupabaseAdmin,
  options: { limit: number; leadIds?: string[] },
): Promise<{
  rows: QueueRow[];
  campaignsRead: number;
  campaignsSkippedForFanoutCap: number;
}> {
  // Only ACTIVE campaigns can produce queue rows (dial_queue joins on
  // `c.status = 'active'`), so this is the complete candidate set and nothing
  // narrower. Ordered by created_at purely for a deterministic fan-out set.
  const { data: activeCampaigns } = await supabase
    .from("campaigns")
    .select("id")
    .eq("status", "active")
    .order("created_at", { ascending: true });

  const allIds = (activeCampaigns ?? []).map((c) => c.id);
  const ids = allIds.slice(0, MAX_CAMPAIGN_FANOUT);
  if (ids.length === 0) {
    return { rows: [], campaignsRead: 0, campaignsSkippedForFanoutCap: 0 };
  }

  const perCampaign = await Promise.all(
    ids.map(async (campaignId) => {
      let query = supabase
        .from("dial_queue")
        .select(QUEUE_COLUMNS)
        .eq("campaign_id", campaignId)
        // Same ordering as before, and it must stay spelled out here: PostgREST
        // applies the client's .order() calls IN PLACE OF the view's own ORDER
        // BY, so omitting any of these silently discards that ranking rather
        // than falling back to it.
        .order("dial_priority", { ascending: true })
        .order("is_redial_due", { ascending: false })
        .order("dest_rank", { ascending: true })
        .order("local_match_rank", { ascending: true })
        .order("queue_order", { ascending: true, nullsFirst: true })
        // Each campaign may offer up to the FULL tick limit, not limit/N. The
        // round-robin merge below is what enforces the fair share; reading the
        // full limit is what lets a quiet campaign's unused slots flow to a
        // busy one instead of being wasted.
        .limit(options.limit);
      if (options.leadIds && options.leadIds.length > 0) {
        query = query.in("lead_id", options.leadIds);
      }
      const { data } = await query;
      return (data ?? []) as QueueRow[];
    }),
  );

  return {
    rows: mergeFairShare(perCampaign, options.limit),
    campaignsRead: ids.length,
    campaignsSkippedForFanoutCap: allIds.length - ids.length,
  };
}

/**
 * One dial-loop tick. Read the queue, pre-check each candidate, and place a
 * call for everything that passes. `TWILIO_LIVE=live` flips each candidate to
 * the real Twilio Calls API; otherwise the synthetic mock-call insert runs so
 * tests and dev environments stay free. `ELEVENLABS_LIVE` is read here only to
 * surface in the summary; the ElevenLabs-native agent bridging is handled by
 * `place-call.ts` / `agent-dial.ts` — the outbound TwiML route has been removed.
 */
export async function runDialerTick(
  options: { limit?: number; leadIds?: string[] } = {},
): Promise<TickSummary> {
  const twilioLive = process.env.TWILIO_LIVE === "live";
  const elevenLive = process.env.ELEVENLABS_LIVE === "live";

  const supabase = makeServiceClient();

  // Reap calls stuck in-flight past the max window so a dropped post-call
  // webhook can't permanently consume the owner's concurrency cap.
  await closeStaleActiveCalls(supabase);

  // Unstick callbacks: cancel zombies (lead went terminal/deleted with a
  // pending callback) and re-park mis-statused dialable leads as callbacks.
  // Best-effort — cleanup must never stop dialing.
  let callbacksSwept: { cancelled: number; resynced: number } | undefined;
  try {
    callbacksSwept = await sweepStuckCallbacks(supabase);
  } catch {
    /* swallow — a sweep failure must not break the tick */
  }

  // Credit guard: before reading the queue, check the shared ElevenLabs credit
  // pool. When it's too low the guard pauses active campaigns (which blocks this
  // tick's dials AND manual "Call Now" via pre_call_check) and we stop here;
  // when credits recover the guard resumes those campaigns so readFairQueue
  // picks them up again below. Live mode only — mock calls consume no credits.
  // The guard fails open internally (never throws), so it can't kill a tick.
  if (elevenLive) {
    const credit = await enforceElevenLabsCreditGate(supabase);
    if (credit.dialingBlocked) {
      return {
        candidates: 0,
        dialed: 0,
        blocked: 0,
        errors: 0,
        blockedReasons: { low_credits: 1 },
        skippedCampaignBlocked: 0,
        campaignsRead: 0,
        candidatesByCampaign: {},
        callbacksSwept,
        liveMode: { twilio: twilioLive, elevenlabs: elevenLive },
      };
    }
  }

  // Light filter pass: leads currently eligible to dial, read with a fair share
  // per active campaign (see readFairQueue for why this is not one global read).
  // Scheduled callbacks (dial_priority = 0) still jump ahead of cold leads
  // (dial_priority = 1) so an agreed appointment is never buried behind a large
  // import, and a due double-call redial still outranks the rest of its tier —
  // readFairQueue restores both bands after the merge. When `leadIds` is passed
  // (Playwright tests use this to keep cross-test leads out of the tick), each
  // per-campaign read is narrowed to just those rows.
  const fair = await readFairQueue(supabase, {
    limit: options.limit ?? 50,
    leadIds: options.leadIds,
  });

  // The view's is_redial_due is a nullable boolean; normalize to a definite
  // one here so downstream checks (and the is_redial param passed to
  // placeLiveDialerCall) don't have to treat null as a third state.
  const candidates = fair.rows.map((row) => ({
    ...row,
    is_redial_due: row.is_redial_due === true,
  }));

  const candidatesByCampaign: Record<string, number> = {};
  for (const c of candidates) {
    if (c.campaign_id) {
      candidatesByCampaign[c.campaign_id] =
        (candidatesByCampaign[c.campaign_id] ?? 0) + 1;
    }
  }

  const summary: TickSummary = {
    candidates: candidates.length,
    dialed: 0,
    blocked: 0,
    errors: 0,
    blockedReasons: {},
    skippedCampaignBlocked: 0,
    campaignsRead: fair.campaignsRead,
    candidatesByCampaign,
    callbacksSwept,
    liveMode: { twilio: twilioLive, elevenlabs: elevenLive },
  };
  if (fair.campaignsSkippedForFanoutCap > 0) {
    summary.campaignsSkippedForFanoutCap = fair.campaignsSkippedForFanoutCap;
  }

  // Per-tick pacing state: each campaign's dial interval (cached) and the last
  // time we placed a call for it, so we space this campaign's dials out inside
  // a single tick instead of firing its whole concurrency allotment at once.
  const dialIntervalCache = new Map<string, number>();
  const lastDialAtByCampaign = new Map<string, number>();
  // Cap total wall-clock sleep per tick so a large interval can't run the
  // function past the serverless timeout. Beyond this budget we stop staggering
  // in-tick; the pre_call_check pacing backstop + subsequent ticks still enforce
  // the spacing across ticks, so correctness never depends on the sleep.
  const MAX_TICK_SLEEP_MS = 45_000;
  let sleptMs = 0;
  // Campaigns that already refused for a CAMPAIGN-level reason this tick (capped
  // out, out of budget, no numbers). Every remaining candidate of that campaign
  // would hit the identical wall, so they're skipped without another round trip.
  const campaignBlocked = new Map<string, PreCallReason>();

  for (const c of candidates) {
    // The queue can produce rows where the typed columns are nominally
    // nullable. In practice these are non-null by construction; skip
    // anything that slips through.
    if (!c.lead_id || !c.campaign_id) {
      summary.errors++;
      continue;
    }

    // This campaign already hit a campaign-level wall this tick — don't ask
    // again, and above all don't touch the lead.
    const alreadyBlocked = campaignBlocked.get(c.campaign_id);
    if (alreadyBlocked) {
      summary.skippedCampaignBlocked++;
      continue;
    }

    // Pace cold dials: if this campaign placed a call earlier in THIS tick, wait
    // out the remainder of its dial interval before dialing the next one. This
    // fills the concurrency slots gradually (one every N seconds) rather than in
    // one burst. `pre_call_check` below is the cross-tick backstop. (The sleep is
    // sequential, so a paced campaign also spaces out later candidates in the
    // same tick — fine for the current single-active-campaign setup.)
    const dialInterval = await campaignDialInterval(
      supabase,
      c.campaign_id,
      dialIntervalCache,
    );
    if (dialInterval > 0) {
      const last = lastDialAtByCampaign.get(c.campaign_id);
      if (last !== undefined) {
        const waitMs = last + dialInterval * 1000 - Date.now();
        // Only sleep when the FULL wait fits the remaining budget. If it
        // doesn't, skip the sleep — pre_call_check will return 'pacing_wait' and
        // the lead stays due for the next tick (the backstop carries the spacing
        // across ticks). This keeps total in-tick sleep <= MAX_TICK_SLEEP_MS.
        if (waitMs > 0 && sleptMs + waitMs <= MAX_TICK_SLEEP_MS) {
          await sleep(waitMs);
          sleptMs += waitMs;
        }
      }
    }

    const { data: reason, error } = await supabase.rpc("pre_call_check", {
      in_lead_id: c.lead_id,
      in_campaign_id: c.campaign_id,
    });
    if (error) {
      summary.errors++;
      continue;
    }
    if (reason) {
      summary.blocked++;
      summary.blockedReasons[reason as PreCallReason] =
        (summary.blockedReasons[reason as PreCallReason] ?? 0) + 1;
      // `pacing_wait` means "try again shortly" — leave next_call_at alone so the
      // lead stays due for the next tick. Any OTHER block bumps next_call_at so
      // we don't re-check this lead every tick.
      //
      // A due redial (is_redial_due) is ALSO exempt, for the opposite reason:
      // this write only ever meant to push a lead OUT — it was written back
      // when every queue row's next_call_at was <= now() by construction. A
      // redial-due lead's next_call_at already sits 2-15 days out (call 1's
      // real schedule); it surfaced here only because its separate redial_at
      // marker is due. Bumping next_call_at to +5 min would PULL that schedule
      // IN instead, silently destroying the backoff — and pre_call_check blocks
      // for reasons the queue view doesn't model (hourly/daily/concurrency/
      // spend caps, call_in_flight) that fire routinely in prod. Leave both
      // next_call_at and the marker untouched: the marker simply expires
      // on its own inside its 10-minute window if unconsumed, and until then
      // the redial may still succeed on a later tick once the cap clears —
      // exactly the "window expires, nothing to unwind" behaviour the
      // double-call design promises. Do not reinstate this for redials.
      //
      // A CAMPAIGN-level refusal (capped out, out of budget, no numbers) is a
      // third exemption, and the most consequential one. The lead did nothing
      // wrong — bumping it writes a schedule it never earned, and because the
      // whole 50-row read refuses together, it did that ~50 times a minute for
      // as long as the campaign stayed capped. Measured on 2026-07-29 before
      // this fix: 9,183 never-called leads carried a next_call_at written
      // entirely by these blocks, 93.8% of all stamps landed in bulk bursts,
      // and next_call_at had become useless as a "never scheduled" signal (the
      // dial_queue first-call gate had to switch to retry_counter because of
      // it). Record the campaign and stop walking its candidates instead.
      if (isCampaignLevelBlock(reason)) {
        campaignBlocked.set(c.campaign_id, reason as PreCallReason);
        continue;
      }
      if (reason !== "pacing_wait" && !c.is_redial_due) {
        await supabase
          .from("leads")
          .update({
            next_call_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          })
          .eq("id", c.lead_id);
      }
      continue;
    }

    // Atomically CLAIM the lead before dialing — and stamp its owning campaign.
    // claim_lead_for_dial leases next_call_at with a guard on its current value
    // AND only succeeds if the lead is un-owned or already owned by THIS
    // campaign, so two overlapping ticks racing on the same lead — including
    // ticks for two different campaigns that share the list — can't both
    // proceed: exactly one wins and becomes owner; the loser gets false and
    // skips. (Call-Now has its own in-flight guard and is made ownership-aware
    // separately; see the manual-dial path.)
    const claimed = await claimLeadForDial(supabase, c.lead_id, c.campaign_id);
    if (!claimed) {
      summary.blocked++;
      summary.blockedReasons["already_claimed"] =
        (summary.blockedReasons["already_claimed"] ?? 0) + 1;
      continue;
    }

    // We're committing to place a call for this campaign now — stamp it so the
    // next candidate for the same campaign waits out the dial interval above.
    lastDialAtByCampaign.set(c.campaign_id, Date.now());

    // claim_lead_for_dial (above) already consumed the redial marker
    // atomically as part of the claim UPDATE — nothing left to do here.

    if (elevenLive) {
      // TS doesn't carry the lead_id / campaign_id null narrow from
      // the guard above into this scope, so re-bind into a typed
      // object the helper can take directly.
      const res = await placeLiveDialerCall(supabase, {
        lead_id: c.lead_id,
        campaign_id: c.campaign_id,
        agent_id: c.agent_id,
        twilio_number_id: null,
        business_phone: c.business_phone,
        is_redial: c.is_redial_due,
        redial_number_id: c.redial_number_id,
        is_callback: c.dial_priority === 0,
      });
      if (res.callId) {
        summary.dialed++;
      } else if (res.inFlight) {
        // The DB active-dial index rejected the insert: another dialer already
        // has this lead in flight. Count it as blocked, not an error.
        summary.blocked++;
        summary.blockedReasons["already_in_flight"] =
          (summary.blockedReasons["already_in_flight"] ?? 0) + 1;
      } else if (res.poolExhausted) {
        // Every pool number for this campaign is capped/rested right now.
        // Count it as blocked, not an error — the lead retries off its claim
        // lease and volume self-throttles to what the pool can support.
        summary.blocked++;
        summary.blockedReasons["pool_exhausted"] =
          (summary.blockedReasons["pool_exhausted"] ?? 0) + 1;
      } else if (res.redialNumberUnusable) {
        // Call 1's number is no longer usable, so the redial was deliberately
        // skipped rather than falling back to a different pool number (see
        // placeLiveDialerCall's same-number comment). This is double-calling's
        // single most likely silent-failure mode, so it gets its own name
        // instead of folding into `errors` — where it would read as "the
        // dialer is erroring" and give an operator nothing to look at.
        summary.blocked++;
        summary.blockedReasons["redial_number_unusable"] =
          (summary.blockedReasons["redial_number_unusable"] ?? 0) + 1;
      } else {
        summary.errors++;
      }
    } else {
      const callId = await placeMockCall(supabase, {
        lead_id: c.lead_id,
        campaign_id: c.campaign_id,
        agent_id: c.agent_id,
        twilio_number_id: null,
      });
      if (callId) summary.dialed++;
      else summary.errors++;
    }
  }

  return summary;
}

/** Round L3 — live counterpart to `placeMockCall`. Resolves the
 *  campaign's Twilio number (the queue row only has its id), inserts
 *  a `calls` row with status='queued', calls Twilio, and stamps the
 *  returned CallSid. Status callbacks drive everything from here. */
async function placeLiveDialerCall(
  supabase: SupabaseAdmin,
  c: {
    lead_id: string;
    campaign_id: string;
    agent_id: string | null;
    twilio_number_id: string | null;
    business_phone: string | null;
    is_redial?: boolean;
    redial_number_id?: string | null;
    /** A scheduled callback (dial_priority 0): bypass the per-number warm-up/
     *  daily cap when picking a from-number so a booked promise still dials
     *  even when cold-call volume has capped the pool. */
    is_callback?: boolean;
  },
): Promise<LivePlaceResult> {
  if (!c.business_phone) return { callId: null };

  // A double-call redial reuses call 1's number so the lead sees the SAME caller
  // ring twice — that recognition is the entire point of the second call.
  //
  // If that number is no longer dialable (retired, rested, flagged) we place NO
  // call rather than falling back to the pool: two calls a minute apart from two
  // different caller IDs is the spam pattern the same-number rule exists to
  // avoid, and is worse for the lead than a single clean call. The lead is
  // already scheduled two days out, so skipping costs nothing.
  const reserved =
    c.is_redial && c.redial_number_id
      ? await usableRedialNumber(
          supabase,
          c.campaign_id,
          c.redial_number_id,
          c.business_phone,
        )
      : null;
  if (c.is_redial && !reserved)
    return { callId: null, redialNumberUnusable: true };

  // Pick a healthy, under-cap, area-matched number from the campaign's pool.
  // Null → the whole pool is capped/rested right now: skip WITHOUT inserting a
  // call; the claim lease (2 min) makes the lead retry, and volume self-throttles
  // to what the pool can safely support.
  const picked =
    reserved ??
    (await selectPoolNumber(
      supabase,
      c.campaign_id,
      c.business_phone,
      c.lead_id, // stable spread key
      c.is_callback === true, // callbacks bypass the per-number cap
    ));
  // Deliberately NOT logged to system_events. A capped pool is routine
  // throttling, not an event worth auditing: this runs once per blocked lead
  // per tick, so a pool that's smaller than the campaign's appetite buries the
  // lead Activity feed under its own noise (20.5k rows in 5 days on a 3-number
  // pool). The tick summary already reports it as blockedReasons.pool_exhausted
  // for the run, which is the right granularity to notice an undersized pool.
  if (!picked) return { callId: null, poolExhausted: true };

  const { data: pending, error: pendingError } = await supabase
    .from("calls")
    .insert({
      lead_id: c.lead_id,
      campaign_id: c.campaign_id,
      agent_id: c.agent_id,
      twilio_number_id: picked.numberId,
      // How local this caller ID was to the lead, recorded at placement rather
      // than re-derived later (a lead's phone can change, and a number can move
      // campaigns). This is what makes local presence measurable.
      local_match: picked.matchTier,
      dest_country: countryForAreaCode(areaCodeOf(c.business_phone)),
      direction: "outbound",
      status: "queued",
      outcome: null,
      outcome_source: "elevenlabs",
      is_redial: c.is_redial === true,
    })
    .select("id")
    .single();
  if (pendingError || !pending) {
    // A unique-violation means another AI outbound dial for this lead won the
    // race at the DB level (calls_one_active_ai_outbound_dial_per_lead). Not an
    // error: the lead already has a live call and its next_call_at stays leased
    // (claim_lead_for_dial set it 2 min out), so it is not re-dialed immediately.
    // Ownership is already consistent (a successful claim is the gate), so no
    // rollback is needed here.
    if ((pendingError as { code?: string } | null)?.code === "23505") {
      return { callId: null, inFlight: true };
    }
    return { callId: null };
  }

  const startedAt = new Date();
  const result = await resolveAndPlaceAgentCall(supabase, {
    callId: pending.id,
    agentId: c.agent_id,
    twilioNumberId: picked.numberId,
    toNumber: c.business_phone,
  });
  if (!result.ok) {
    // FIX B (#6): record the placement rejection in the system_events audit
    // log instead of the dialer silently looping. Best-effort.
    await supabase.from("system_events").insert({
      kind: "call_placement_failed",
      actor_user_id: null,
      ref_table: "calls",
      ref_id: pending.id,
      payload: {
        call_id: pending.id,
        lead_id: c.lead_id,
        campaign_id: c.campaign_id,
        error: result.error,
      },
    });

    // The success path bumps the lead's call_attempts; this failure path used
    // to skip it. Align them — a rejected placement is still an attempt.
    await supabase
      .from("leads")
      .update({
        last_call_at: startedAt.toISOString(),
        call_attempts: (await currentAttempts(supabase, c.lead_id)) + 1,
      })
      .eq("id", c.lead_id);

    // FIX A (#6 / #8): mark the call failed AND run the retry engine so the
    // lead is scheduled 2 days out (the 'failed' backoff) instead of being
    // re-picked in 2 minutes off its claim lease. finalizeFailedCall runs LAST
    // so the retry engine's next_call_at write isn't clobbered by the
    // call_attempts update above.
    await finalizeFailedCall(supabase, pending.id);
    return { callId: null };
  }

  await supabase
    .from("calls")
    .update({
      twilio_call_sid: result.twilioCallSid,
      elevenlabs_conversation_id: result.conversationId,
      started_at: startedAt.toISOString(),
      status: "dialing",
    })
    .eq("id", pending.id);

  // Build the patch conditionally: last_call_at + call_attempts always bump —
  // a redial IS a placed call and should count as one — but the +30 min
  // next_call_at placeholder is skipped for a redial. For a normal call this
  // placeholder is harmless: the retry engine overwrites it moments later
  // when the call ends. For a redial NOTHING overwrites it afterward —
  // advanceCycle() in retry-engine.ts returns early on call.is_redial, by
  // design, because a double-call pair must advance the 2/2/15-day cycle only
  // ONCE, on call 1. Call 1 already wrote the correct next_call_at (2 or 15
  // days out) and the redial claim (runDialerTick + claim_lead_for_dial)
  // preserved it verbatim. Writing +30 min here would silently overwrite that
  // schedule, and since nothing else ever corrects it, a 15-day cool-off
  // collapses into a ~30-minute loop the next time this redial hits
  // voicemail.
  const leadUpdate: Database["public"]["Tables"]["leads"]["Update"] = {
    last_call_at: startedAt.toISOString(),
    call_attempts: (await currentAttempts(supabase, c.lead_id)) + 1,
  };
  if (!c.is_redial) {
    leadUpdate.next_call_at = new Date(
      Date.now() + 30 * 60 * 1000,
    ).toISOString();
  }
  await supabase.from("leads").update(leadUpdate).eq("id", c.lead_id);

  return { callId: pending.id };
}
