import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@supabase/supabase-js";
import {
  leadStatusAfterInviteeCreated,
  verifyCalendlySignature,
  type CalendlyWebhookPayload,
} from "@/lib/calendly/webhook";
import { getCalendlyWebhookSigningKey } from "@/lib/calendly/webhook-secret";
import { etDateTime } from "@/lib/time/eastern";

/** Calendly webhook handler (Step 37 / BUILD_PLAN §11).
 *
 * Subscribes to `invitee.created`, `invitee.canceled`, `invitee.no_show`.
 * Match the invitee to an existing lead within any owner's leads (by email
 * first, then phone). Insert / update `calendly_events`, flip the lead's
 * status to `scheduled` (or revert) and notify the owner.
 *
 * Signature: Calendly sends `Calendly-Webhook-Signature: t=<unix secs>,v1=<hex>`
 * where v1 = HMAC-SHA256(signingKey, `${t}.${rawBody}`), the signing key being
 * the one returned when the webhook subscription was created. We verify over
 * the RAW request text whenever a key is configured (env
 * CALENDLY_WEBHOOK_SIGNING_KEY, else app_settings.calendly_webhook_signing_key);
 * with no key configured anywhere, unsigned deliveries are accepted as before.
 *
 * Host-side reschedule = `invitee.canceled` for the old invitee (with
 * `rescheduled: true` + `new_invitee`) followed by `invitee.created` for the
 * new one (with `old_invitee`). The upsert on invitee_uri yields one canceled
 * row + one scheduled row; the lead's calendly_event_uri moves to the new
 * event and a `goal_met` lead is NOT downgraded to `scheduled`.
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

  const rawBody = await request.text();

  const signingKey = await getCalendlyWebhookSigningKey();
  if (signingKey) {
    const check = verifyCalendlySignature(
      rawBody,
      request.headers.get("calendly-webhook-signature"),
      signingKey,
      Date.now(),
    );
    if (!check.ok) {
      return NextResponse.json(
        { ok: false, status: "bad_signature", reason: check.reason },
        { status: 401 },
      );
    }
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

  const data = body as CalendlyWebhookPayload;
  const eventName = data.event ?? "";
  const p = data.payload ?? {};
  const inviteeUri = p.uri ?? "";
  if (!inviteeUri) {
    return NextResponse.json(
      { ok: false, status: "missing_invitee_uri" },
      { status: 400 },
    );
  }

  // Match a lead by email (case-insensitive) first, then by phone.
  let leadOwnerId: string | null = null;
  let leadId: string | null = null;
  let leadStatus: string | null = null;
  if (p.email) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, owner_id, status")
      .ilike("business_email", p.email)
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) {
      leadId = matches[0].id;
      leadOwnerId = matches[0].owner_id;
      leadStatus = matches[0].status;
    }
  }
  if (!leadId && p.text_reminder_number) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, owner_id, status")
      .eq("business_phone", p.text_reminder_number)
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) {
      leadId = matches[0].id;
      leadOwnerId = matches[0].owner_id;
      leadStatus = matches[0].status;
    }
  }

  // We need an owner to file the event under. If no lead matched, attribute
  // to a system_events row but skip the calendly_events insert.
  if (!leadOwnerId) {
    await supabase.from("system_events").insert({
      kind: "calendly_unmatched_invitee",
      ref_table: "calendly_events",
      payload: {
        event: eventName,
        email: p.email ?? null,
        phone: p.text_reminder_number ?? null,
        invitee_uri: inviteeUri,
      },
    });
    return NextResponse.json({ ok: true, status: "unmatched" });
  }

  const baseEventStatus =
    eventName === "invitee.canceled"
      ? "canceled"
      : eventName === "invitee.no_show"
        ? "no_show"
        : "scheduled";

  await supabase.from("calendly_events").upsert(
    {
      owner_id: leadOwnerId,
      lead_id: leadId,
      invitee_uri: inviteeUri,
      event_uri: p.scheduled_event?.uri ?? "",
      event_type_uri: p.scheduled_event?.event_type ?? null,
      invitee_email: p.email ?? null,
      invitee_phone: p.text_reminder_number ?? null,
      invitee_name: p.name ?? null,
      scheduled_at: p.scheduled_event?.start_time ?? null,
      cancel_url: p.cancel_url ?? null,
      reschedule_url: p.reschedule_url ?? null,
      status: baseEventStatus,
      raw: data as object,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "invitee_uri" },
  );

  if (leadId) {
    if (eventName === "invitee.created") {
      // Move the lead into the goal pipeline at "scheduled" (unless it is
      // already goal_met — a reschedule must not downgrade a confirmed
      // booking) and always repoint the Calendly link to the new event.
      const nextStatus = leadStatusAfterInviteeCreated(leadStatus);
      await supabase
        .from("leads")
        .update({
          ...(nextStatus ? { status: nextStatus } : {}),
          calendly_event_uri: p.scheduled_event?.uri ?? null,
        })
        .eq("id", leadId);
      const when = p.scheduled_event?.start_time
        ? ` ${p.old_invitee ? "to" : "for"} ${etDateTime(p.scheduled_event.start_time, "", true)}`
        : "";
      await supabase.from("notifications").insert({
        user_id: leadOwnerId,
        kind: "calendly_scheduled",
        message: p.old_invitee
          ? `Calendly appointment moved${when}.`
          : `New Calendly appointment booked${when}.`,
        ref_table: "leads",
        ref_id: leadId,
      });
    } else if (eventName === "invitee.no_show") {
      await supabase
        .from("leads")
        .update({ status: "no_show" })
        .eq("id", leadId);
    }
    // invitee.canceled with rescheduled=true: nothing more to do to the lead;
    // the matching invitee.created (old_invitee set) follows and repoints it.
  }

  await supabase.from("system_events").insert({
    kind: `calendly_${eventName.replace("invitee.", "")}`,
    ref_table: "calendly_events",
    payload: {
      invitee_uri: inviteeUri,
      lead_id: leadId,
      status: baseEventStatus,
      rescheduled: p.rescheduled ?? false,
      new_invitee: p.new_invitee ?? null,
      old_invitee: p.old_invitee ?? null,
    },
  });

  return NextResponse.json({ ok: true, status: "applied", lead_id: leadId });
}
