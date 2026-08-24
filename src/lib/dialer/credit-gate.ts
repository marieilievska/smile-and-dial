import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { applyConnectedAgentIntegration } from "@/lib/elevenlabs/agents";
import type { ToolsEnabled } from "@/lib/agents/prompt";
import { callsLeft, creditConfig } from "@/lib/elevenlabs/credit-config";
import {
  type CreditState,
  evaluateCreditState,
} from "@/lib/elevenlabs/credit-state";
import { getElevenLabsCreditBalance } from "@/lib/elevenlabs/subscription";

type Supabase = SupabaseClient<Database>;

export type CreditGateResult = {
  dialingBlocked: boolean;
  state: CreditState | "unknown";
  paused: number;
  resumed: number;
};

/** Read-failure log throttle so a sustained EL outage can't flood system_events. */
const READ_ERROR_LOG_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Credit guard for the dialer tick. Reads the shared ElevenLabs balance and:
 *  - warns admins as credits get low (still dialing),
 *  - pauses every active campaign + notifies each owner when they run out,
 *  - auto-resumes the campaigns it paused (refreshing agent webhooks) on
 *    recovery.
 * Fails open on a failed balance read (never pauses); never auto-resumes
 * without a confirmed reading (a read failure leaves paused campaigns paused).
 *
 * Call this only in live mode (ELEVENLABS_LIVE === "live"); mock calls consume
 * no credits.
 *
 * The whole body runs under a top-level try/catch: any unexpected error
 * (e.g. a transient DB blip) fails open — dialing is never blocked by a
 * guard malfunction — rather than throwing and killing the dialer tick.
 * Campaigns already paused on a prior tick simply stay paused in the DB, so
 * failing open here doesn't un-pause anything.
 */
export async function enforceElevenLabsCreditGate(
  supabase: Supabase,
): Promise<CreditGateResult> {
  try {
    const cfg = creditConfig();

    const { data: prev } = await supabase
      .from("elevenlabs_credit_status")
      .select("state, read_error_logged_at")
      .eq("id", 1)
      .maybeSingle();
    const prevState = (prev?.state ?? null) as CreditState | null;

    const balance = await getElevenLabsCreditBalance();

    // Fail-open on read failure: keep dialing unless we were already low
    // (then stay blocked — don't resume on an unconfirmed reading).
    if (!balance) {
      await logReadFailure(supabase, prev?.read_error_logged_at ?? null);
      return {
        dialingBlocked: prevState === "low",
        state: prevState ?? "unknown",
        paused: 0,
        resumed: 0,
      };
    }

    const decision = evaluateCreditState(balance.remaining, prevState, cfg);
    const nowIso = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("elevenlabs_credit_status")
      .upsert({
        id: 1,
        remaining: balance.remaining,
        credit_limit: balance.limit,
        state: decision.state,
        checked_at: nowIso,
        updated_at: nowIso,
        // A confirmed read clears the read-failure throttle so a later
        // outage isn't silently swallowed by a stale timestamp.
        read_error_logged_at: null,
      });

    const left = callsLeft(balance.remaining, cfg.avgCreditsPerCall);
    let paused = 0;
    let resumed = 0;

    // The pause/resume ACTIONS below always run (idempotent + safety
    // critical). The one-shot admin notify + audit-log calls only fire when
    // the state upsert actually persisted — otherwise the next tick
    // re-derives the same transition from the (unchanged) prior state and
    // would re-notify every tick, flooding admins.
    if (decision.transition === "entered_warn") {
      if (!upsertError) {
        await notifyAdmins(
          supabase,
          "elevenlabs_credits_warning",
          `ElevenLabs credits are getting low (~${left} calls left). Top up soon to avoid the dialer pausing.`,
        );
        await logEvent(supabase, "elevenlabs_credits_warn", {
          remaining: balance.remaining,
          calls_left: left,
        });
      }
    } else if (
      decision.transition === "entered_low" ||
      decision.transition === "still_low"
    ) {
      paused = await pauseActiveCampaigns(supabase, nowIso, left);
      if (decision.transition === "entered_low" && !upsertError) {
        await notifyAdmins(
          supabase,
          "dialer_paused_low_credits",
          `The dialer paused: ElevenLabs credits are too low (~${left} calls left). It will resume automatically once credits are restored.`,
        );
        await logEvent(supabase, "elevenlabs_credits_low", {
          remaining: balance.remaining,
          calls_left: left,
          campaigns_paused: paused,
        });
      }
    } else if (decision.transition === "resumed") {
      resumed = await resumeLowCreditCampaigns(supabase);
      if (!upsertError) {
        await notifyAdmins(
          supabase,
          "dialer_resumed_credits_restored",
          `ElevenLabs credits restored (~${left} calls' worth). The dialer resumed automatically.`,
        );
        await logEvent(supabase, "elevenlabs_credits_restored", {
          remaining: balance.remaining,
          calls_left: left,
          campaigns_resumed: resumed,
        });
      }
    }

    return {
      dialingBlocked: !decision.shouldDial,
      state: decision.state,
      paused,
      resumed,
    };
  } catch (err) {
    console.error("[credit-gate] unexpected error; failing open", err);
    return { dialingBlocked: false, state: "unknown", paused: 0, resumed: 0 };
  }
}

/** Pause every currently-active campaign; notify each owner. Returns count. */
async function pauseActiveCampaigns(
  supabase: Supabase,
  nowIso: string,
  left: number,
): Promise<number> {
  const { data: flipped, error } = await supabase
    .from("campaigns")
    .update({
      status: "paused",
      paused_at: nowIso,
      paused_reason: "low_credits",
    })
    .eq("status", "active")
    .select("id, owner_id, name");
  if (error) {
    // A silently-failed pause keeps burning the credit pool.
    console.error("[credit-gate] pause failed", error);
  }
  const rows = flipped ?? [];
  if (rows.length > 0) {
    await supabase.from("notifications").insert(
      rows.map((c) => ({
        user_id: c.owner_id,
        kind: "campaign_paused_low_credits",
        message: `Your campaign "${c.name}" was paused — the account is low on ElevenLabs credits (~${left} calls left). It will resume automatically once credits are restored.`,
        ref_table: "campaigns",
        ref_id: c.id,
      })),
    );
  }
  return rows.length;
}

/** Resume campaigns WE paused for low credits; refresh webhooks; notify owners. */
async function resumeLowCreditCampaigns(supabase: Supabase): Promise<number> {
  const { data: toResume } = await supabase
    .from("campaigns")
    .select("id, owner_id, name, agent_id")
    .eq("status", "paused")
    .eq("paused_reason", "low_credits");
  const rows = toResume ?? [];
  // Campaigns commonly share an agent — refresh each agent's webhook once,
  // not once per campaign.
  const webhookRefreshed = new Set<string>();
  for (const c of rows) {
    // Re-guard on the row's own state: only flip campaigns still paused for
    // low credits (one may have been paused/resumed some other way between
    // the SELECT above and this UPDATE).
    await supabase
      .from("campaigns")
      .update({ status: "active", paused_at: null, paused_reason: null })
      .eq("id", c.id)
      .eq("status", "paused")
      .eq("paused_reason", "low_credits");
    if (c.agent_id && !webhookRefreshed.has(c.agent_id)) {
      webhookRefreshed.add(c.agent_id);
      await reapplyAgentWebhook(supabase, c.agent_id);
    }
    await supabase.from("notifications").insert({
      user_id: c.owner_id,
      kind: "campaign_resumed_credits_restored",
      message: `Your campaign "${c.name}" resumed — ElevenLabs credits are restored.`,
      ref_table: "campaigns",
      ref_id: c.id,
    });
  }
  return rows.length;
}

/** Refresh an agent's ElevenLabs webhooks (mirrors resumeCampaign). Best-effort. */
async function reapplyAgentWebhook(
  supabase: Supabase,
  campaignAgentId: string | null | undefined,
): Promise<void> {
  if (!campaignAgentId) return;
  const { data: agent } = await supabase
    .from("agents")
    .select("elevenlabs_agent_id, tools_enabled")
    .eq("id", campaignAgentId)
    .maybeSingle();
  if (!agent?.elevenlabs_agent_id) return;
  try {
    await applyConnectedAgentIntegration(
      agent.elevenlabs_agent_id,
      (agent.tools_enabled ?? undefined) as unknown as ToolsEnabled | undefined,
    );
  } catch {
    // best-effort — a webhook sync hiccup must not break the tick
  }
}

async function notifyAdmins(
  supabase: Supabase,
  kind: string,
  message: string,
): Promise<void> {
  const { data: admins } = await supabase
    .from("profiles")
    .select("id")
    .eq("role", "admin")
    .eq("active", true);
  if (!admins?.length) return;
  await supabase
    .from("notifications")
    .insert(admins.map((a) => ({ user_id: a.id, kind, message })));
}

async function logEvent(
  supabase: Supabase,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await supabase.from("system_events").insert({
    kind,
    actor_user_id: null,
    ref_table: "elevenlabs_credit_status",
    ref_id: null,
    payload: payload as Json,
  });
}

async function logReadFailure(
  supabase: Supabase,
  lastLoggedAt: string | null,
): Promise<void> {
  const now = Date.now();
  if (
    lastLoggedAt &&
    now - new Date(lastLoggedAt).getTime() < READ_ERROR_LOG_THROTTLE_MS
  ) {
    return; // throttled
  }
  const nowIso = new Date(now).toISOString();
  await supabase
    .from("elevenlabs_credit_status")
    .upsert({ id: 1, read_error_logged_at: nowIso, updated_at: nowIso });
  await logEvent(supabase, "elevenlabs_credit_check_failed", {});
}
