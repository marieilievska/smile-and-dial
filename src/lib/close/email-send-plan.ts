/** Decides what the in-call send_email tool should DO, kept pure so the honesty
 *  rules are unit-tested without touching Close or the database.
 *  - non-live (dev/test): record a mock row so the flow + activity feed work.
 *  - live + no Close connection: note the intent only — NEVER a fake "sent".
 *  - live + delivered: record the real send.
 *  - live + delivery failed: note only, keep the failure reason. */
export type EmailSendPlan =
  | { action: "record_mock" }
  | { action: "record_real" }
  | { action: "note_only"; reason: string };

export function planEmailSend(input: {
  live: boolean;
  hasCloseKey: boolean;
  delivered: { ok: boolean; error?: string } | null;
}): EmailSendPlan {
  if (!input.live) return { action: "record_mock" };
  if (!input.hasCloseKey) {
    return { action: "note_only", reason: "owner_close_not_connected" };
  }
  if (input.delivered?.ok) return { action: "record_real" };
  return {
    action: "note_only",
    reason: input.delivered?.error ?? "close_send_failed",
  };
}
