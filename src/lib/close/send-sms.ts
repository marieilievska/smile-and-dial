import "server-only";

import {
  closeActivityErrored,
  createCloseLead,
  findCloseLeadByPhone,
  sendCloseSms,
} from "./api";

export type DeliverSmsInput = {
  closeKey: string;
  fromNumber: string; // a Close SMS-enabled "internal" number (E.164)
  toMobile: string; // recipient mobile (E.164)
  text: string;
  company: string | null;
  contactName: string | null;
};

export type DeliverSmsResult =
  | { ok: true; closeMessageId: string }
  | { ok: false; error: string };

/** Send one SMS through Close: find-or-create the contact by mobile, then post
 *  an outbox SMS from the configured Close number. Mirror of deliverEmailViaClose
 *  — never throws (catches Close fetch failures) so the caller's honest fallback
 *  fires instead of a 500 mid-call. */
export async function deliverSmsViaClose(
  input: DeliverSmsInput,
): Promise<DeliverSmsResult> {
  try {
    let ref = await findCloseLeadByPhone(input.closeKey, input.toMobile);
    if (!ref) {
      ref = await createCloseLead(input.closeKey, {
        companyName: input.company,
        contactName: input.contactName,
        phone: input.toMobile,
      });
    }
    if (!ref) return { ok: false, error: "could_not_create_contact" };

    const sent = await sendCloseSms(input.closeKey, {
      leadId: ref.leadId,
      contactId: ref.contactId,
      localPhone: input.fromNumber,
      remotePhone: input.toMobile,
      text: input.text,
    });
    if (sent.error || !sent.id) {
      return { ok: false, error: sent.error ?? "close_send_failed" };
    }
    // Close accepted it, but sends async — confirm it didn't immediately error
    // before we claim it sent (mirror of deliverEmailViaClose).
    if (await closeActivityErrored(input.closeKey, "sms", sent.id)) {
      return { ok: false, error: "close_send_errored" };
    }
    return { ok: true, closeMessageId: sent.id };
  } catch {
    return { ok: false, error: "close_exception" };
  }
}
