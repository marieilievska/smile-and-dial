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

/** What the agent is told when the text did NOT go out. Honest and specific —
 *  "no texting number is set up in Close" rather than "I've noted to text
 *  that", which the lead hears as a yes. Returned with success:false. */
export function textNotSentMessage(reason: string): string {
  switch (reason) {
    case "no_template_on_campaign":
      return "I can't send texts from this campaign yet — no text is set up for it. I've made a note for the team to follow up.";
    case "owner_close_not_connected":
      return "I couldn't send the text: texting isn't connected for this campaign yet. I've made a note for the team to follow up.";
    case "no_sms_from_number":
      return "I couldn't send the text: no texting number is set up in Close. I've made a note for the team to follow up.";
    default:
      return "I couldn't send the text just now. I've made a note for the team to follow up.";
  }
}
