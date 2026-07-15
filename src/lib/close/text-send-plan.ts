/** Pure decision for the in-call send_text tool — mirrors planEmailSend, plus
 *  the SMS-only "is a send-from number configured" check. No I/O, so the honesty
 *  + opt-out rules are unit-tested without touching Close or the DB.
 *  - non-live (dev/test): record a mock row so flows/activity work.
 *  - live + no Close key: note intent only — never a fake "sent".
 *  - live + connected but no send-from number: note only.
 *  - live + delivered: record the real send.
 *  - live + delivery failed: note only, keep the reason. */
export type TextSendPlan =
  | { action: "record_mock" }
  | { action: "record_real" }
  | { action: "note_only"; reason: string };

export function planTextSend(input: {
  live: boolean;
  hasCloseKey: boolean;
  hasFromNumber: boolean;
  delivered: { ok: boolean; error?: string } | null;
}): TextSendPlan {
  if (!input.live) return { action: "record_mock" };
  if (!input.hasCloseKey) {
    return { action: "note_only", reason: "owner_close_not_connected" };
  }
  if (!input.hasFromNumber) {
    return { action: "note_only", reason: "no_sms_from_number" };
  }
  if (input.delivered?.ok) return { action: "record_real" };
  return {
    action: "note_only",
    reason: input.delivered?.error ?? "close_send_failed",
  };
}
