import { NextResponse, type NextRequest } from "next/server";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  escapeLikePattern,
  isIlikeSafe,
  isStopMessage,
  isUuid,
  parseCloseWebhookEvent,
  verifyCloseSignature,
  type CloseInboundEmail,
  type CloseInboundSms,
} from "@/lib/close/webhook";

/** Close inbound webhook (Step 38 / BUILD_PLAN §12).
 *
 *  Close API keys are PER USER, so each user has their own subscription
 *  (created by enableCloseInboundWebhook) pointing at
 *  `/api/close/webhook?u=<user_id>` and signed with that subscription's
 *  `signature_key`. Every delivery is verified against the stored key over
 *  the RAW body (close-sig-hash = HMAC-SHA256(fromhex(key),
 *  close-sig-timestamp + body)), with a 5-minute timestamp window; anything
 *  unsigned, mis-signed, or for a user without a subscription is a 401. No
 *  env flag gates this — the key either exists for that user or it doesn't.
 *
 *  Subscribed events: `activity.email created` and `activity.sms created`.
 *  Both also fire for OUTBOUND messages, so only `direction: "incoming"`
 *  emails and `direction: "inbound"` SMS are acted on; everything else is a
 *  200 `ignored`. Every lead / email lookup is scoped to `owner_id = u`.
 *
 *  Email: attach to the thread we sent (in_reply_to_id / thread_id →
 *  `emails.close_message_id`), else match the sender address to a lead's
 *  business_email; write a received `emails` row, flip the lead to
 *  `email_replied`, notify the owner.
 *  SMS: match the sender's number to mobile_phone then business_phone; write a
 *  received `texts` row; STOP → DNC every number + status `dnc`; notify.
 */
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return NextResponse.json(
      { ok: false, status: "config_missing" },
      { status: 500 },
    );
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Which user's subscription this delivery belongs to — the `u` we put in
  // the URL when creating it. Everything below is scoped to that owner.
  const ownerId = request.nextUrl.searchParams.get("u");
  if (!isUuid(ownerId)) {
    return NextResponse.json(
      { ok: false, status: "missing_user" },
      { status: 401 },
    );
  }

  // Raw text first: the signature covers the exact bytes Close sent, so the
  // body must not be re-serialised before hashing.
  const rawBody = await request.text();

  const { data: integ } = await supabase
    .from("user_integrations")
    .select("close_webhook_signature_key")
    .eq("user_id", ownerId)
    .maybeSingle();
  const signatureKey = integ?.close_webhook_signature_key?.trim() || "";
  if (!signatureKey) {
    return NextResponse.json(
      { ok: false, status: "webhook_not_enabled" },
      { status: 401 },
    );
  }

  const check = verifyCloseSignature(
    rawBody,
    request.headers.get("close-sig-timestamp"),
    request.headers.get("close-sig-hash"),
    signatureKey,
    Date.now(),
  );
  if (!check.ok) {
    return NextResponse.json(
      { ok: false, status: "bad_signature", reason: check.reason },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { ok: false, status: "invalid_json" },
      { status: 400 },
    );
  }

  const parsed = parseCloseWebhookEvent(body);
  if (parsed.kind === "ignored") {
    return NextResponse.json({
      ok: true,
      status: "ignored",
      reason: parsed.reason,
    });
  }
  if (parsed.kind === "sms") {
    return handleInboundSms(supabase, ownerId, parsed);
  }
  return handleInboundEmail(supabase, ownerId, parsed);
}

async function handleInboundEmail(
  supabase: SupabaseClient,
  ownerId: string,
  email: CloseInboundEmail,
) {
  let leadId: string | null = null;

  // 1) Attach via the thread: the email Close says this replies to, else the
  //    thread's first activity (Close's thread_id IS that activity's id). Both
  //    are ids we stored on the emails we sent through Close.
  for (const ref of [email.inReplyToId, email.threadId]) {
    if (!ref || ref === email.closeMessageId) continue;
    const { data: parents } = await supabase
      .from("emails")
      .select("lead_id")
      .eq("owner_id", ownerId)
      .eq("close_message_id", ref)
      .limit(1);
    if (parents && parents.length > 0) {
      leadId = parents[0].lead_id;
      break;
    }
  }

  // 2) Fall back to the sender address against this owner's leads. The value
  //    is escaped so `%`/`_` in an address can't widen the match.
  if (!leadId && email.senderEmail && isIlikeSafe(email.senderEmail)) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id")
      .eq("owner_id", ownerId)
      .ilike("business_email", escapeLikePattern(email.senderEmail))
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) leadId = matches[0].id;
  }

  if (!leadId) {
    await supabase.from("system_events").insert({
      kind: "close_unmatched_reply",
      ref_table: "emails",
      payload: {
        close_message_id: email.closeMessageId,
        from: email.senderRaw,
        owner_id: ownerId,
      },
    });
    return NextResponse.json({ ok: true, status: "unmatched" });
  }

  // Write the received email row. Idempotency: a partial unique index on
  // close_message_id prevents dupes, so on retry we just swallow the error
  // and return ok.
  const { error: insertErr } = await supabase.from("emails").insert({
    lead_id: leadId,
    owner_id: ownerId,
    direction: "received",
    subject: email.subject,
    body: email.body,
    to_address: email.to,
    from_address: email.senderRaw ?? email.senderEmail,
    close_message_id: email.closeMessageId,
    status: "received",
    raw: email.raw,
  });
  if (insertErr) {
    // 23505 = unique_violation. Anything else, log + 200.
    const code = (insertErr as { code?: string }).code ?? "";
    if (code !== "23505") {
      await supabase.from("system_events").insert({
        kind: "close_webhook_error",
        ref_table: "emails",
        payload: {
          close_message_id: email.closeMessageId,
          error: insertErr.message,
        },
      });
      return NextResponse.json({ ok: false, status: "insert_failed" });
    }
    // Duplicate replay — already applied; return ok without re-flipping
    // status or re-notifying.
    return NextResponse.json({ ok: true, status: "duplicate" });
  }

  // Flip the lead's status to email_replied; pause dialing.
  await supabase
    .from("leads")
    .update({ status: "email_replied", next_call_at: null })
    .eq("id", leadId)
    .eq("owner_id", ownerId);

  await supabase.from("notifications").insert({
    user_id: ownerId,
    kind: "email_replied",
    message: `Lead replied via email${email.subject ? `: ${email.subject}` : "."}`,
    ref_table: "leads",
    ref_id: leadId,
  });

  await supabase.from("system_events").insert({
    kind: "close_email_received",
    ref_table: "leads",
    ref_id: leadId,
    payload: { close_message_id: email.closeMessageId },
  });

  return NextResponse.json({ ok: true, status: "applied", lead_id: leadId });
}

/** Handle an inbound Close SMS: match the lead by the sender's number, log a
 *  received `texts` row, and honor STOP as a FULL do-not-contact (DNC every
 *  number we have for the lead + terminalize it, so calls and texts both stop). */
async function handleInboundSms(
  supabase: SupabaseClient,
  ownerId: string,
  sms: CloseInboundSms,
) {
  const closeMessageId = sms.closeMessageId;
  const fromNumber = sms.fromNumber;
  const textBody = sms.text;
  if (!fromNumber) {
    return NextResponse.json({ ok: true, status: "ignored_no_sender" });
  }

  // Match the lead by the mobile we text, then by the business number —
  // among THIS owner's leads only.
  let lead: {
    id: string;
    business_phone: string | null;
    mobile_phone: string | null;
    company: string | null;
  } | null = null;
  for (const col of ["mobile_phone", "business_phone"] as const) {
    const { data: rows } = await supabase
      .from("leads")
      .select("id, business_phone, mobile_phone, company")
      .eq("owner_id", ownerId)
      .eq(col, fromNumber)
      .is("deleted_at", null)
      .limit(1);
    if (rows && rows.length > 0) {
      lead = rows[0];
      break;
    }
  }
  if (!lead) {
    await supabase.from("system_events").insert({
      kind: "close_unmatched_reply",
      ref_table: "texts",
      payload: {
        close_message_id: closeMessageId,
        from: fromNumber,
        owner_id: ownerId,
      },
    });
    return NextResponse.json({ ok: true, status: "unmatched" });
  }

  const isStop = isStopMessage(textBody);

  // Honor STOP FIRST — before the dedup short-circuit below — so the opt-out is
  // enforced even if a later step fails and Close retries the webhook. Every
  // operation here is idempotent (dnc_entries tolerates 23505; the status set is
  // a no-op when already dnc), so re-running on a retry is safe.
  if (isStop) {
    const numbers = [lead.business_phone, lead.mobile_phone].filter(
      (n): n is string => Boolean(n),
    );
    for (const phone of numbers) {
      const { error } = await supabase.from("dnc_entries").insert({
        phone,
        company_snapshot: lead.company,
        reason: "dnc_requested",
        added_by_user_id: ownerId,
      });
      // 23505 = already on the list; the goal is met either way.
      if (error && (error as { code?: string }).code !== "23505") {
        await supabase.from("system_events").insert({
          kind: "sms_stop_dnc_error",
          ref_table: "leads",
          ref_id: lead.id,
          payload: { phone, error: error.message },
        });
      }
    }
    await supabase
      .from("leads")
      .update({ status: "dnc", next_call_at: null })
      .eq("id", lead.id)
      .eq("owner_id", ownerId);
  }

  // Record the inbound text. The partial unique index on close_message_id makes
  // this the atomic dedup point: a Close retry hits 23505 and returns early —
  // AFTER the idempotent STOP handling above, so an opt-out is never dropped.
  const { error: insertErr } = await supabase.from("texts").insert({
    lead_id: lead.id,
    owner_id: ownerId,
    direction: "received",
    body: textBody,
    from_number: fromNumber,
    to_number: sms.toNumber,
    close_message_id: closeMessageId,
    status: "received",
    raw: sms.raw,
  });
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      return NextResponse.json({ ok: true, status: "duplicate" });
    }
    await supabase.from("system_events").insert({
      kind: "close_webhook_error",
      ref_table: "texts",
      payload: { close_message_id: closeMessageId, error: insertErr.message },
    });
    return NextResponse.json({ ok: false, status: "insert_failed" });
  }

  await supabase.from("notifications").insert(
    isStop
      ? {
          user_id: ownerId,
          kind: "sms_opt_out",
          message: "Lead replied STOP — added to do-not-call (calls + texts).",
          ref_table: "leads",
          ref_id: lead.id,
        }
      : {
          user_id: ownerId,
          kind: "text_replied",
          message: `Lead replied by text${textBody ? `: ${textBody.slice(0, 80)}` : "."}`,
          ref_table: "leads",
          ref_id: lead.id,
        },
  );

  await supabase.from("system_events").insert({
    kind: isStop ? "sms_opt_out" : "close_sms_received",
    ref_table: "leads",
    ref_id: lead.id,
    payload: { close_message_id: closeMessageId },
  });

  return NextResponse.json({ ok: true, status: "applied", lead_id: lead.id });
}
