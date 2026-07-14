import "server-only";

import {
  closeSenderEmail,
  createCloseLead,
  findCloseLeadByEmail,
  sendCloseEmail,
} from "./api";

export type DeliverEmailInput = {
  closeKey: string;
  senderName: string | null;
  toAddress: string;
  subject: string;
  body: string;
  contactName: string | null;
  company: string | null;
  businessPhone: string | null;
};

export type DeliverEmailResult =
  | { ok: true; closeMessageId: string; fromAddress: string }
  | { ok: false; error: string };

/** Deliver one email through the owner's Close account: resolve the sending
 *  address, find-or-create the Close contact, then post an outbox email that
 *  Close delivers. Never throws — returns {ok:false, error} so callers can be
 *  honest instead of recording a false "sent". The caller owns template
 *  rendering, the owner-key lookup, and writing the `emails` row. */
export async function deliverEmailViaClose(
  input: DeliverEmailInput,
): Promise<DeliverEmailResult> {
  try {
    const senderEmail = await closeSenderEmail(input.closeKey);
    if (!senderEmail) return { ok: false, error: "no_connected_sending_email" };

    const fromAddress = input.senderName
      ? `${input.senderName} <${senderEmail}>`
      : senderEmail;

    let ref = await findCloseLeadByEmail(input.closeKey, input.toAddress);
    if (!ref) {
      ref = await createCloseLead(input.closeKey, {
        companyName: input.company,
        contactName: input.contactName,
        email: input.toAddress,
        phone: input.businessPhone,
      });
    }
    if (!ref) return { ok: false, error: "could_not_create_contact" };

    const sent = await sendCloseEmail(input.closeKey, {
      leadId: ref.leadId,
      contactId: ref.contactId,
      to: input.toAddress,
      subject: input.subject,
      bodyText: input.body,
      sender: fromAddress,
    });
    if (sent.error || !sent.id) {
      return { ok: false, error: sent.error ?? "close_send_failed" };
    }
    return { ok: true, closeMessageId: sent.id, fromAddress };
  } catch {
    // A Close fetch rejected (DNS/TLS/socket/outage). Honor the "never throws"
    // contract so the caller's honest fallback fires ("I've noted to send
    // that") instead of an unhandled 500 mid-call.
    return { ok: false, error: "close_exception" };
  }
}
