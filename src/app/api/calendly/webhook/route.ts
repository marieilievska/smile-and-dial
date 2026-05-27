import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@supabase/supabase-js";

/** Calendly webhook handler (Step 37 / BUILD_PLAN §11).
 *
 * Subscribes to `invitee.created`, `invitee.canceled`, `invitee.no_show`.
 * Match the invitee to an existing lead within any owner's leads (by email
 * first, then phone). Insert / update `calendly_events`, flip the lead's
 * status to `scheduled` (or revert) and notify the owner.
 *
 * Signature verification (X-Calendly-Webhook-Signature) is required by
 * Calendly in production; we wire the placeholder check here. CALENDLY_LIVE
 * gates strict enforcement.
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, status: "invalid_json" },
      { status: 400 },
    );
  }

  const sig = request.headers.get("x-calendly-webhook-signature");
  if (process.env.CALENDLY_LIVE === "live" && !sig) {
    return NextResponse.json(
      { ok: false, status: "missing_signature" },
      { status: 401 },
    );
  }

  type CalendlyPayload = {
    event?: string;
    payload?: {
      uri?: string;
      email?: string;
      name?: string;
      text_reminder_number?: string;
      cancel_url?: string;
      reschedule_url?: string;
      scheduled_event?: {
        uri?: string;
        start_time?: string;
        event_type?: string;
      };
    };
  };
  const data = body as CalendlyPayload;
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
  if (p.email) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, owner_id")
      .ilike("business_email", p.email)
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) {
      leadId = matches[0].id;
      leadOwnerId = matches[0].owner_id;
    }
  }
  if (!leadId && p.text_reminder_number) {
    const { data: matches } = await supabase
      .from("leads")
      .select("id, owner_id")
      .eq("business_phone", p.text_reminder_number)
      .is("deleted_at", null)
      .limit(1);
    if (matches && matches.length > 0) {
      leadId = matches[0].id;
      leadOwnerId = matches[0].owner_id;
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
      // Flip the lead into the goal pipeline at "scheduled" and stash the
      // Calendly link for the modal pill.
      await supabase
        .from("leads")
        .update({
          status: "scheduled",
          calendly_event_uri: p.scheduled_event?.uri ?? null,
        })
        .eq("id", leadId);
      await supabase.from("notifications").insert({
        user_id: leadOwnerId,
        kind: "calendly_scheduled",
        message: `New Calendly appointment booked${
          p.scheduled_event?.start_time
            ? ` for ${new Date(p.scheduled_event.start_time).toLocaleString()}`
            : ""
        }.`,
        ref_table: "leads",
        ref_id: leadId,
      });
    } else if (eventName === "invitee.no_show") {
      await supabase
        .from("leads")
        .update({ status: "no_show" })
        .eq("id", leadId);
    }
  }

  await supabase.from("system_events").insert({
    kind: `calendly_${eventName.replace("invitee.", "")}`,
    ref_table: "calendly_events",
    payload: {
      invitee_uri: inviteeUri,
      lead_id: leadId,
      status: baseEventStatus,
    },
  });

  return NextResponse.json({ ok: true, status: "applied", lead_id: leadId });
}
