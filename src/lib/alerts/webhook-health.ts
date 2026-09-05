/**
 * Pure decision for the ElevenLabs post-call webhook's health.
 *
 * SQL can't call ElevenLabs, so the dialer tick fetches
 * `GET /v1/workspace/webhooks` (live mode, every 10 minutes) and hands the
 * list here. Shape confirmed live 2026-09-05:
 *
 *   { webhooks: [{ webhook_id, name, webhook_url, is_disabled,
 *                  is_auto_disabled, most_recent_failure_error_code,
 *                  most_recent_failure_timestamp (unix seconds), ... }] }
 *
 * The post-call webhook is the ONLY way call results (outcome, transcript,
 * recording, cost) reach the app, so a disabled webhook is critical: the
 * dialer keeps placing calls and every one of them lands as an eternal
 * "in progress" with no outcome. A recent delivery failure is a warning —
 * ElevenLabs auto-disables the webhook after repeated failures, so it is the
 * early signal for the critical case.
 */

export type WorkspaceWebhook = {
  webhook_id?: string | null;
  name?: string | null;
  is_disabled?: boolean | null;
  is_auto_disabled?: boolean | null;
  most_recent_failure_error_code?: number | null;
  /** Unix seconds (ElevenLabs); milliseconds are tolerated. */
  most_recent_failure_timestamp?: number | null;
};

export type WebhookHealthStatus =
  | "ok"
  | "failing"
  | "disabled"
  | "auto_disabled"
  | "missing"
  | "unconfigured";

export type WebhookHealth = {
  status: WebhookHealthStatus;
  /** Something is wrong and admins should be told. */
  alert: boolean;
  /** Post-call events cannot be reaching the app at all. */
  critical: boolean;
  failureCode: number | null;
  failureAgeMinutes: number | null;
  message: string | null;
};

/** A failure newer than this counts as "currently failing". */
export const WEBHOOK_FAILURE_WINDOW_MS = 60 * 60 * 1000;

function failureAtMs(ts: number | null | undefined): number | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  // ElevenLabs sends seconds; anything past year 2286 in seconds is really ms.
  return ts > 1e12 ? ts : ts * 1000;
}

export function evaluateWebhookHealth(
  webhooks: WorkspaceWebhook[],
  ourWebhookId: string | null | undefined,
  now: Date = new Date(),
): WebhookHealth {
  const none: WebhookHealth = {
    status: "ok",
    alert: false,
    critical: false,
    failureCode: null,
    failureAgeMinutes: null,
    message: null,
  };

  const id = ourWebhookId?.trim() ?? "";
  if (!id) return { ...none, status: "unconfigured" };

  const ours = webhooks.find((w) => w.webhook_id === id);
  if (!ours) {
    return {
      ...none,
      status: "missing",
      alert: true,
      critical: true,
      message:
        "The post-call webhook id saved in app settings no longer exists in the ElevenLabs workspace, so call results (outcome, transcript, recording) cannot reach the app. Re-run the webhook setup in Settings — this is critical.",
    };
  }

  const code =
    typeof ours.most_recent_failure_error_code === "number"
      ? ours.most_recent_failure_error_code
      : null;
  const codeNote = code === null ? "" : ` (last error HTTP ${code})`;

  if (ours.is_auto_disabled === true) {
    return {
      ...none,
      status: "auto_disabled",
      alert: true,
      critical: true,
      failureCode: code,
      message: `ElevenLabs auto-disabled the post-call webhook after repeated delivery failures${codeNote}. No call results (outcome, transcript, recording) are reaching the app until it is re-enabled in the ElevenLabs dashboard under Webhooks — this is critical.`,
    };
  }
  if (ours.is_disabled === true) {
    return {
      ...none,
      status: "disabled",
      alert: true,
      critical: true,
      failureCode: code,
      message:
        "The ElevenLabs post-call webhook is disabled. No call results (outcome, transcript, recording) are reaching the app until it is re-enabled in the ElevenLabs dashboard under Webhooks — this is critical.",
    };
  }

  const failedAt = failureAtMs(ours.most_recent_failure_timestamp);
  if (failedAt !== null) {
    const ageMs = now.getTime() - failedAt;
    if (ageMs >= 0 && ageMs < WEBHOOK_FAILURE_WINDOW_MS) {
      const minutes = Math.floor(ageMs / 60_000);
      return {
        status: "failing",
        alert: true,
        critical: false,
        failureCode: code,
        failureAgeMinutes: minutes,
        message: `ElevenLabs reported a failed post-call webhook delivery ${minutes} minute${minutes === 1 ? "" : "s"} ago${codeNote}. Some call results may be missing, and if deliveries keep failing ElevenLabs will auto-disable the webhook.`,
      };
    }
  }

  return { ...none, failureCode: code };
}
