import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { resolveAndPlaceAgentCall } from "@/lib/dialer/agent-dial";
import { closeStaleActiveCalls } from "@/lib/dialer/stale-calls";

import { type PreCallReason } from "./queue";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

export type TickSummary = {
  candidates: number;
  dialed: number;
  blocked: number;
  errors: number;
  blockedReasons: Record<string, number>;
  liveMode: { twilio: boolean; elevenlabs: boolean };
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
 * Atomically claim a lead for dialing by pushing its `next_call_at` into the
 * future, but ONLY if it's still due right now. Two racing ticks both read
 * the queue and pass pre_call_check, but only one UPDATE can match the
 * "still due" predicate — Postgres serializes the row write, the first
 * commits a future next_call_at, and the second's predicate no longer
 * matches so it returns zero rows. Returns true iff this caller won the claim.
 *
 * The 2-minute hold is a short lease: long enough that the dial completes and
 * sets its own real next_call_at, short enough that a crash mid-dial doesn't
 * strand the lead for long.
 */
async function claimLeadForDial(
  supabase: SupabaseAdmin,
  leadId: string,
): Promise<boolean> {
  const lease = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("leads")
    .update({ next_call_at: lease })
    .eq("id", leadId)
    .or(`next_call_at.is.null,next_call_at.lte.${nowIso}`)
    .select("id");
  if (error) return false;
  return (data?.length ?? 0) > 0;
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

/**
 * One dial-loop tick. Read the queue, pre-check each candidate, and place a
 * call for everything that passes. Round L3 — `TWILIO_LIVE=live` now
 * flips each candidate to the real Twilio Calls API; otherwise the
 * synthetic mock-call insert runs so tests and dev environments stay
 * free. `ELEVENLABS_LIVE` is read here only to surface in the summary;
 * the agent-vs-placeholder TwiML choice happens inside the
 * voice-outbound route handler (L4).
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

  // Light filter pass: leads currently eligible to dial. When `leadIds` is
  // passed (Playwright tests use this to keep cross-test leads out of the
  // tick), narrow the queue to just those rows.
  let query = supabase
    .from("dial_queue")
    .select(
      "lead_id, owner_id, business_phone, campaign_id, agent_id, twilio_number_id",
    )
    // Scheduled callbacks (dial_priority = 0) jump ahead of cold leads
    // (dial_priority = 1) so an agreed appointment is never buried behind a
    // large import. Within each priority band, soonest-due dials first.
    .order("dial_priority", { ascending: true })
    .order("next_call_at", { ascending: true, nullsFirst: true })
    .limit(options.limit ?? 50);
  if (options.leadIds && options.leadIds.length > 0) {
    query = query.in("lead_id", options.leadIds);
  }
  const { data: queue } = await query;

  const candidates = queue ?? [];

  const summary: TickSummary = {
    candidates: candidates.length,
    dialed: 0,
    blocked: 0,
    errors: 0,
    blockedReasons: {},
    liveMode: { twilio: twilioLive, elevenlabs: elevenLive },
  };

  for (const c of candidates) {
    // The queue can produce rows where the typed columns are nominally
    // nullable. In practice these are non-null by construction; skip
    // anything that slips through.
    if (!c.lead_id || !c.campaign_id) {
      summary.errors++;
      continue;
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
      // Bump next_call_at so we don't keep re-checking this lead every tick.
      await supabase
        .from("leads")
        .update({
          next_call_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        })
        .eq("id", c.lead_id);
      continue;
    }

    // Atomically CLAIM the lead before dialing. Bumping next_call_at with a
    // guard on its current value means two overlapping ticks (or a tick +
    // Call-Now) racing on the same lead can't both proceed — only the first
    // UPDATE matches the `due` predicate; the loser gets 0 rows and skips.
    // This closes the double-dial-the-same-person window that existed when
    // next_call_at was only bumped AFTER the call was placed.
    const claimed = await claimLeadForDial(supabase, c.lead_id);
    if (!claimed) {
      summary.blocked++;
      summary.blockedReasons["already_claimed"] =
        (summary.blockedReasons["already_claimed"] ?? 0) + 1;
      continue;
    }

    if (elevenLive) {
      // TS doesn't carry the lead_id / campaign_id null narrow from
      // the guard above into this scope, so re-bind into a typed
      // object the helper can take directly.
      const callId = await placeLiveDialerCall(supabase, {
        lead_id: c.lead_id,
        campaign_id: c.campaign_id,
        agent_id: c.agent_id,
        twilio_number_id: c.twilio_number_id,
        business_phone: c.business_phone,
      });
      if (callId) summary.dialed++;
      else summary.errors++;
    } else {
      const callId = await placeMockCall(supabase, {
        lead_id: c.lead_id,
        campaign_id: c.campaign_id,
        agent_id: c.agent_id,
        twilio_number_id: c.twilio_number_id,
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
  },
): Promise<string | null> {
  if (!c.business_phone) return null;
  if (!c.twilio_number_id) return null;

  const { data: pending, error: pendingError } = await supabase
    .from("calls")
    .insert({
      lead_id: c.lead_id,
      campaign_id: c.campaign_id,
      agent_id: c.agent_id,
      twilio_number_id: c.twilio_number_id,
      direction: "outbound",
      status: "queued",
      outcome: null,
      outcome_source: "elevenlabs",
    })
    .select("id")
    .single();
  if (pendingError || !pending) return null;

  const startedAt = new Date();
  const result = await resolveAndPlaceAgentCall(supabase, {
    callId: pending.id,
    agentId: c.agent_id,
    twilioNumberId: c.twilio_number_id,
    toNumber: c.business_phone,
  });
  if (!result.ok) {
    await supabase
      .from("calls")
      .update({ status: "failed", outcome: "failed" })
      .eq("id", pending.id);
    return null;
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

  await supabase
    .from("leads")
    .update({
      last_call_at: startedAt.toISOString(),
      call_attempts: (await currentAttempts(supabase, c.lead_id)) + 1,
      next_call_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .eq("id", c.lead_id);

  return pending.id;
}
