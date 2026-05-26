import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@supabase/supabase-js";

/** Close inbound webhook (Step 38 / BUILD_PLAN §12).
 *
 *  Subscribes to `email.received`. We try two matches in order:
 *    1. If `in_reply_to_close_message_id` matches an emails row we sent,
 *       attach to that thread.
 *    2. Otherwise match by `from` address to a lead's business_email.
 *
 *  On match, we write a direction=received row, flip the lead's status to
 *  `email_replied`, and write a notification for the owner.
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

  const sig = request.headers.get("x-close-signature");
  if (process.env.CLOSE_LIVE === "live" && !sig) {
    return NextResponse.json(
      { ok: false, status: "missing_signature" },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, status: "invalid_json" },
      { status: 400 },
    );
  }

  type ClosePayload = {
    event?: string;
    data?: {
      id?: string; // close message id
      from?: string;
      to?: string;
      subject?: string;
      body_text?: string;
      body_html?: string;
      in_reply_to?: string; // close_message_id of the parent
      date_received?: string;
    };
  };
  const p = body as ClosePayload;
  if ((p.event ?? "") !== "email.received") {
    // We only care about replies; ignore everything else.
    return NextResponse.json({ ok: true, status: "ignored" });
  }
  const data = p.data ?? {};
  if (!data.id) {
    return NextResponse.json(
      { ok: false, status: "missing_close_message_id" },
      { status: 400 },
    );
  }

  let leadId: string | null = null;
  let ownerId: string | null = null;

  // 1) Try to attach via the parent thread.
  if (data.in_reply_to) {
    const { data: parent } = await supabase
      .from("emails")
      .select("lead_id, owner_id")
      .eq("close_message_id", data.in_reply_to)
      .maybeSingle();
    if (parent) {
      leadId = parent.lead_id;
      ownerId = parent.owner_id;
    }
  }

  // 2) Fall back to matching by sender email.
  if (!leadId && data.from) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, owner_id")
      .ilike("business_email", data.from)
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) {
      leadId = matches[0].id;
      ownerId = matches[0].owner_id;
    }
  }

  if (!leadId || !ownerId) {
    await supabase.from("system_events").insert({
      kind: "close_unmatched_reply",
      ref_table: "emails",
      payload: { close_message_id: data.id, from: data.from ?? null },
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
    subject: data.subject ?? null,
    body: data.body_text ?? data.body_html ?? null,
    to_address: data.to ?? null,
    from_address: data.from ?? null,
    close_message_id: data.id,
    status: "received",
    raw: data as object,
  });
  if (insertErr) {
    // 23505 = unique_violation. Anything else, log + 200.
    const code = (insertErr as { code?: string }).code ?? "";
    if (code !== "23505") {
      await supabase.from("system_events").insert({
        kind: "close_webhook_error",
        ref_table: "emails",
        payload: {
          close_message_id: data.id,
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
    .eq("id", leadId);

  await supabase.from("notifications").insert({
    user_id: ownerId,
    kind: "email_replied",
    message: `Lead replied via email${data.subject ? `: ${data.subject}` : "."}`,
    ref_table: "leads",
    ref_id: leadId,
  });

  await supabase.from("system_events").insert({
    kind: "close_email_received",
    ref_table: "leads",
    ref_id: leadId,
    payload: { close_message_id: data.id },
  });

  return NextResponse.json({ ok: true, status: "applied", lead_id: leadId });
}
