import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { fetchWorkspaceWebhooks } from "@/lib/elevenlabs/workspace-webhooks";

import {
  heartbeatPruneCutoff,
  isDue,
  WEBHOOK_HEALTH_CHECK_INTERVAL_MS,
} from "./throttle";
import { evaluateWebhookHealth, type WebhookHealth } from "./webhook-health";

type Supabase = SupabaseClient<Database>;

/** ref_id for account-wide alerts that have no natural row (matches the SQL
 *  evaluator's v_global). */
export const GLOBAL_ALERT_REF = "00000000-0000-0000-0000-000000000000";

/**
 * Everything in this module is best-effort and fails SILENT by design: the
 * alerting must never break or delay a dial, and the migration that creates
 * dialer_heartbeats / alert_state / alert_fire() may land after this code
 * deploys (or before, or never in a dev DB). A missing table or function
 * simply means "no heartbeat / no alert this tick" — the SQL evaluator reads
 * "no heartbeat rows" as unknown, not as a stall.
 */

export type HeartbeatInput = {
  candidates: number;
  dialed: number;
  errors: number;
  blockedReasons: Record<string, number>;
  poolExhaustedCampaigns?: string[];
  queueReadFailed?: boolean;
  durationMs: number;
  /** The whole tick summary, stored as jsonb for after-the-fact debugging. */
  summary: unknown;
};

/** Insert this tick's heartbeat row and prune rows past the retention
 *  window on the same path. Returns whether the insert succeeded. */
export async function writeDialerHeartbeat(
  supabase: Supabase,
  input: HeartbeatInput,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const { error } = await supabase.from("dialer_heartbeats").insert({
      ran_at: now.toISOString(),
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      candidates: input.candidates,
      dialed: input.dialed,
      errors: input.errors,
      blocked_reasons: input.blockedReasons as Json,
      pool_exhausted_campaigns: input.poolExhaustedCampaigns ?? [],
      queue_read_failed: input.queueReadFailed === true,
      summary: input.summary as Json,
    });
    if (error) return false;
    // Prune on the same path: an index range delete, usually of 0-1 rows.
    await supabase
      .from("dialer_heartbeats")
      .delete()
      .lt("ran_at", heartbeatPruneCutoff(now));
    return true;
  } catch {
    return false;
  }
}

/**
 * Once-per-period claim through the SQL primitive. True exactly once per
 * (rule, ref) per period; false when already claimed OR when the claim
 * itself failed (so a broken dedupe can never turn into a notification
 * flood).
 */
export async function fireAlert(
  supabase: Supabase,
  rule: string,
  refId: string,
  period: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("alert_fire", {
      in_rule: rule,
      in_ref: refId,
      in_period: period,
    });
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}

export async function logSystemEvent(
  supabase: Supabase,
  kind: string,
  ref: { table: string; id: string | null },
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from("system_events").insert({
      kind,
      actor_user_id: null,
      ref_table: ref.table,
      ref_id: ref.id,
      payload: payload as Json,
    });
  } catch {
    /* best-effort */
  }
}

/** One notification per active admin. */
export async function notifyAllAdmins(
  supabase: Supabase,
  kind: string,
  message: string,
  ref: { table: string; id: string | null } = { table: "campaigns", id: null },
): Promise<number> {
  try {
    const { data: admins } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "admin")
      .eq("active", true);
    if (!admins?.length) return 0;
    const { error } = await supabase.from("notifications").insert(
      admins.map((a) => ({
        user_id: a.id,
        kind,
        message,
        ref_table: ref.table,
        ref_id: ref.id,
      })),
    );
    return error ? 0 : admins.length;
  } catch {
    return 0;
  }
}

/**
 * The tick could not read the campaign list or a campaign's dial_queue
 * slice. Used to be discarded as "0 candidates"; now it is a system_events
 * row (`dialer_queue_read_failed`, at most one per 30 minutes) and the
 * heartbeat's `queue_read_failed` flag, which the SQL evaluator turns into a
 * `dialer_stalled` alert.
 */
export async function recordQueueReadFailure(
  supabase: Supabase,
  detail: { messages: string[]; campaignsRead: number },
): Promise<void> {
  const claimed = await fireAlert(
    supabase,
    "event:dialer_queue_read_failed",
    GLOBAL_ALERT_REF,
    "30 minutes",
  );
  if (!claimed) return;
  await logSystemEvent(
    supabase,
    "dialer_queue_read_failed",
    { table: "campaigns", id: null },
    {
      errors: detail.messages.slice(0, 5),
      campaigns_read: detail.campaignsRead,
    },
  );
}

/** Every pool number for a campaign was capped/rested this tick. Audit row
 *  at most once per campaign per hour (the per-lead noise stays out of the
 *  Activity feed on purpose — see placeLiveDialerCall). */
export async function recordPoolExhausted(
  supabase: Supabase,
  campaignId: string,
  blockedThisTick: number,
): Promise<void> {
  const claimed = await fireAlert(
    supabase,
    "event:pool_exhausted",
    campaignId,
    "1 hour",
  );
  if (!claimed) return;
  await logSystemEvent(
    supabase,
    "pool_exhausted",
    { table: "campaigns", id: campaignId },
    { campaign_id: campaignId, leads_blocked_this_tick: blockedThisTick },
  );
}

export type WebhookHealthCheck = WebhookHealth & {
  checkedAt: string;
  webhookId: string | null;
  /** False when the ElevenLabs read itself failed (status is then "ok" by
   *  default but means nothing — the next check is 10 minutes away). */
  fetched: boolean;
  notified: number;
};

/**
 * Post-call webhook health, at most once every 10 minutes, throttled off the
 * newest heartbeat that carries a `webhookHealth` block (so the throttle
 * survives serverless invocations without another table). Returns undefined
 * when it is not yet due; otherwise the check result, which the tick stores
 * on this tick's heartbeat. On a failing/disabled webhook: one
 * `post_call_webhook_failing` system_events row per check and an admin
 * notification at most once per hour via alert_fire().
 */
export async function maybeCheckPostCallWebhook(
  supabase: Supabase,
  now: Date = new Date(),
): Promise<WebhookHealthCheck | undefined> {
  try {
    const { data: last } = await supabase
      .from("dialer_heartbeats")
      .select("ran_at")
      .not("summary->webhookHealth", "is", null)
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!isDue(last?.ran_at ?? null, WEBHOOK_HEALTH_CHECK_INTERVAL_MS, now)) {
      return undefined;
    }

    const [{ data: settings }, webhooks] = await Promise.all([
      supabase
        .from("app_settings")
        .select("elevenlabs_post_call_webhook_id")
        .eq("id", 1)
        .maybeSingle(),
      fetchWorkspaceWebhooks(),
    ]);
    const webhookId =
      settings?.elevenlabs_post_call_webhook_id?.trim() ||
      process.env.ELEVENLABS_POST_CALL_WEBHOOK_ID?.trim() ||
      null;

    if (!webhooks) {
      return {
        status: "ok",
        alert: false,
        critical: false,
        failureCode: null,
        failureAgeMinutes: null,
        message: null,
        checkedAt: now.toISOString(),
        webhookId,
        fetched: false,
        notified: 0,
      };
    }

    const health = evaluateWebhookHealth(webhooks, webhookId, now);
    const result: WebhookHealthCheck = {
      ...health,
      checkedAt: now.toISOString(),
      webhookId,
      fetched: true,
      notified: 0,
    };
    if (!health.alert || !health.message) return result;

    await logSystemEvent(
      supabase,
      "post_call_webhook_failing",
      { table: "app_settings", id: null },
      {
        status: health.status,
        critical: health.critical,
        failure_code: health.failureCode,
        failure_age_minutes: health.failureAgeMinutes,
      },
    );
    const claimed = await fireAlert(
      supabase,
      "post_call_webhook_failing",
      GLOBAL_ALERT_REF,
      "1 hour",
    );
    if (claimed) {
      result.notified = await notifyAllAdmins(
        supabase,
        "post_call_webhook_failing",
        health.message,
        { table: "app_settings", id: null },
      );
    }
    return result;
  } catch {
    return undefined;
  }
}
