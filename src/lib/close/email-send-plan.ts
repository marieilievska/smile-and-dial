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

/** Can the send_email tool send ANYTHING on this call — decided before any
 *  rendering or delivery, and pure so it's unit-tested.
 *  - no template on the campaign: nothing to send, in any mode;
 *  - live + owner never connected Close: nowhere to send it from;
 *  - otherwise ready (non-live without Close records a mock row). */
export type EmailToolReadiness =
  | { ready: true }
  | {
      ready: false;
      reason: "no_template_on_campaign" | "owner_close_not_connected";
    };

export function emailToolReadiness(input: {
  live: boolean;
  hasTemplate: boolean;
  hasCloseKey: boolean;
}): EmailToolReadiness {
  if (!input.hasTemplate) {
    return { ready: false, reason: "no_template_on_campaign" };
  }
  if (input.live && !input.hasCloseKey) {
    return { ready: false, reason: "owner_close_not_connected" };
  }
  return { ready: true };
}

/** What the agent is told when the email did NOT go out. Spoken-friendly and
 *  honest: it says the email isn't coming and why, never "I've noted to send
 *  that" (which the lead hears as a yes). Fed back to the model as the tool
 *  result with success:false. */
export function emailNotSentMessage(reason: string): string {
  switch (reason) {
    case "no_template_on_campaign":
      return "I can't send emails from this campaign yet — no email is set up for it. I've made a note for the team to follow up by email.";
    case "owner_close_not_connected":
      return "I can't send emails from this campaign yet — the sending account isn't connected. I've made a note for the team to follow up by email.";
    case "no_connected_sending_email":
      return "I couldn't send the email: the connected account has no email it can send from. I've made a note for the team to follow up by email.";
    default:
      return "I couldn't send the email just now. I've made a note for the team to follow up by email.";
  }
}
