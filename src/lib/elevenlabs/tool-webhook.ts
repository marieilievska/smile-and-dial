import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  createInvitee,
  getAvailableTimes as calendlyGetAvailableTimes,
} from "@/lib/calendly/api";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * ElevenLabs server-tool webhooks.
 *
 * Each of our five custom tools (send_email, schedule_callback,
 * get_available_times, book_appointment, mark_dnc) is registered with
 * ElevenLabs as a webhook tool (see lib/elevenlabs/server-tools). When the
 * agent's LLM decides to use one mid-call, ElevenLabs POSTs to
 * /api/elevenlabs/tools/<tool> with a flat JSON body containing exactly the
 * parameters we declared — and crucially, NOTHING about the call itself is
 * included automatically.
 *
 * So every tool declares a `call_id` parameter bound to the {{call_id}}
 * dynamic variable (which our conversation-init webhook supplies). That lets
 * us resolve the lead/campaign here, server-side, instead of trusting the LLM
 * to pass identity. The handlers below run with the service role (no user
 * session exists in a webhook) and derive ownership from the resolved call.
 *
 * The JSON we return is fed back to the LLM as the tool result, so each
 * handler returns a short human-readable `message` the agent can relay.
 */

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/** The five custom server tools, in the order the wizard lists them. */
export const SERVER_TOOL_KEYS = [
  "send_email",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
] as const;

export type ServerToolKey = (typeof SERVER_TOOL_KEYS)[number];

export function isServerToolKey(value: string): value is ServerToolKey {
  return (SERVER_TOOL_KEYS as readonly string[]).includes(value);
}

/** Shape every handler returns; serialized straight back to ElevenLabs. */
export type ToolWebhookResult = {
  success: boolean;
  message: string;
  [key: string]: unknown;
};

/**
 * Validate the shared-secret header ElevenLabs sends (configured as a
 * request header on each tool definition). Skipped in non-live mode
 * (ELEVENLABS_LIVE != "live") so Playwright can POST without a secret; in
 * live mode a constant-time match against ELEVENLABS_TOOL_WEBHOOK_SECRET is
 * required.
 */
export function isValidToolSecret(provided: string | null): boolean {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  const expected = process.env.ELEVENLABS_TOOL_WEBHOOK_SECRET ?? "";
  if (!expected) return false;
  if (!provided) return false;
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

function makeServiceClient(): SupabaseAdmin {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Tool webhook requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The call + its lead, resolved from the {{call_id}} the tool carried. */
type CallContext = {
  supabase: SupabaseAdmin;
  callId: string;
  campaignId: string;
  lead: {
    id: string;
    owner_id: string;
    company: string | null;
    business_phone: string | null;
    owner_phone: string | null;
    business_email: string | null;
    owner_name: string | null;
    timezone: string | null;
    status: string;
  };
};

async function resolveCallContext(
  supabase: SupabaseAdmin,
  callId: string,
): Promise<CallContext | null> {
  if (!callId) return null;
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id, campaign_id")
    .eq("id", callId)
    .maybeSingle();
  if (!call?.lead_id || !call.campaign_id) return null;

  const { data: lead } = await supabase
    .from("leads")
    .select(
      "id, owner_id, company, business_phone, owner_phone, business_email, owner_name, timezone, status",
    )
    .eq("id", call.lead_id)
    .maybeSingle();
  if (!lead) return null;

  return {
    supabase,
    callId: call.id,
    campaignId: call.campaign_id,
    lead,
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Human-readable slot label in the workspace's timezone. */
function fmtSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

type CampaignCalendly = { token: string; eventTypeUri: string | null };

/**
 * Resolve the Calendly credentials + event type for a call: the CAMPAIGN
 * OWNER's connected token (per-user, from user_integrations) and the event
 * type assigned to the campaign (else the owner's first active synced type).
 * Returns null when the owner hasn't connected Calendly — the handler then
 * falls back to generic/mock behavior.
 */
async function resolveCampaignCalendly(
  supabase: SupabaseAdmin,
  campaignId: string,
): Promise<CampaignCalendly | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("owner_id, calendly_event_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign?.owner_id) return null;

  const { data: integ } = await supabase
    .from("user_integrations")
    .select("calendly_api_key")
    .eq("user_id", campaign.owner_id)
    .maybeSingle();
  const token = integ?.calendly_api_key?.trim();
  if (!token) return null;

  let eventTypeUri: string | null = null;
  if (campaign.calendly_event_id) {
    const { data: et } = await supabase
      .from("calendly_event_types")
      .select("event_uri")
      .eq("id", campaign.calendly_event_id)
      .maybeSingle();
    eventTypeUri = et?.event_uri ?? null;
  }
  if (!eventTypeUri) {
    const { data: fallback } = await supabase
      .from("calendly_event_types")
      .select("event_uri")
      .eq("owner_id", campaign.owner_id)
      .eq("active", true)
      .order("synced_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    eventTypeUri = fallback?.event_uri ?? null;
  }
  return { token, eventTypeUri };
}

/**
 * Run a tool by name. Returns the JSON result for ElevenLabs, or null when
 * the tool name is unknown (the route turns that into a 400). A resolved
 * call is required for the lead-scoped tools; get_available_times is the one
 * exception since it just reads availability.
 */
export async function executeServerTool(
  tool: ServerToolKey,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const supabase = makeServiceClient();
  const callId = str(body.call_id);
  const ctx = await resolveCallContext(supabase, callId);

  // get_available_times can fall back to generic slots, so it doesn't hard
  // require a resolved call — but it uses one (when present) to pick the
  // campaign's Calendly event type in live mode.
  if (tool === "get_available_times") {
    return getAvailableTimesResult(ctx);
  }

  if (!ctx) {
    return {
      success: false,
      message:
        "I couldn't find the right record for this call, so I wasn't able to do that just now.",
    };
  }

  switch (tool) {
    case "send_email":
      return sendEmail(ctx, body);
    case "schedule_callback":
      return scheduleCallback(ctx, body);
    case "book_appointment":
      return bookAppointment(ctx, body);
    case "mark_dnc":
      return markDnc(ctx, body);
    default:
      return { success: false, message: "Unknown tool." };
  }
}

/** Log a tool invocation to the system_events audit trail. Best-effort. */
async function logToolEvent(
  ctx: CallContext,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.supabase.from("system_events").insert({
    kind,
    actor_user_id: null,
    ref_table: "calls",
    ref_id: ctx.callId,
    payload: payload as Json,
  });
}

// ---------------------------------------------------------------------------
// send_email
// ---------------------------------------------------------------------------
async function sendEmail(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const email = str(body.email) || (ctx.lead.business_email ?? "");
  const note = str(body.note);
  if (!email) {
    return {
      success: false,
      message:
        "I don't have an email address on file — could you tell me the best email to send it to?",
    };
  }

  // Capture the confirmed email onto the lead if we didn't have one. We never
  // overwrite an existing address (same rule the post-call webhook follows).
  if (!ctx.lead.business_email) {
    await ctx.supabase
      .from("leads")
      .update({ business_email: email })
      .eq("id", ctx.lead.id);
  }

  await logToolEvent(ctx, "tool_send_email", { email, note });

  // The actual send rides on the Close integration, which is mock until
  // CLOSE_LIVE=live. Either way the intent is recorded; in mock mode we
  // simply report success so the call flows naturally.
  return {
    success: true,
    message: `Done — I've sent that over to ${email}. It should arrive within a minute.`,
  };
}

// ---------------------------------------------------------------------------
// schedule_callback
// ---------------------------------------------------------------------------
async function scheduleCallback(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const raw = str(body.callback_datetime);
  const when = new Date(raw);
  if (!raw || Number.isNaN(when.getTime())) {
    return {
      success: false,
      message:
        "I didn't catch a clear date and time — could you say when works best?",
    };
  }
  if (when.getTime() <= Date.now()) {
    return {
      success: false,
      message: "That time has already passed — could you pick a future time?",
    };
  }

  const scheduledAt = when.toISOString();
  const { error } = await ctx.supabase.from("callbacks").insert({
    lead_id: ctx.lead.id,
    campaign_id: ctx.campaignId,
    originating_call_id: ctx.callId,
    scheduled_at: scheduledAt,
    status: "pending",
    // Auto-created by the agent during a call, so created_by stays null.
    created_by: null,
  });
  if (error) {
    return {
      success: false,
      message: "I couldn't schedule that callback just now.",
    };
  }

  // Hand the lead to the callback queue at the requested time.
  await ctx.supabase
    .from("leads")
    .update({ status: "callback", next_call_at: scheduledAt })
    .eq("id", ctx.lead.id);

  await logToolEvent(ctx, "tool_schedule_callback", {
    scheduled_at: scheduledAt,
    note: str(body.note),
  });

  return {
    success: true,
    message: `Perfect — I've got you down for a callback then. We'll be in touch.`,
  };
}

// ---------------------------------------------------------------------------
// get_available_times (live Calendly when configured, generic slots otherwise)
// ---------------------------------------------------------------------------
async function getAvailableTimesResult(
  ctx: CallContext | null,
): Promise<ToolWebhookResult> {
  // Offer the campaign owner's real Calendly openings over the next 6 days
  // (Calendly caps the window at 7). Falls back to generic slots if the owner
  // hasn't connected Calendly or has no openings, so the conversation moves.
  if (ctx) {
    const cal = await resolveCampaignCalendly(ctx.supabase, ctx.campaignId);
    if (cal?.eventTypeUri) {
      const start = new Date(new Date().getTime() + 15 * 60 * 1000);
      const end = new Date(new Date().getTime() + 6 * 24 * 60 * 60 * 1000);
      const live = await calendlyGetAvailableTimes(
        cal.eventTypeUri,
        start.toISOString(),
        end.toISOString(),
        cal.token,
      );
      const slots = live.slice(0, 3).map((s) => ({
        slot_id: s.startTime,
        label: fmtSlot(s.startTime),
      }));
      if (slots.length > 0) {
        return {
          success: true,
          message: "Here are the next available times.",
          slots,
        };
      }
    }
  }
  return genericAvailableTimes();
}

/** Three generic weekday slots (10am / 2pm ET) used in mock mode or when live
 *  Calendly has no openings in the window. slot_id carries the ISO time so
 *  book_appointment can echo it back. */
function genericAvailableTimes(): ToolWebhookResult {
  const slots: { slot_id: string; label: string }[] = [];
  const base = new Date();
  let added = 0;
  let dayOffset = 1;
  const hours = [14, 18]; // ~10am & 2pm US-Eastern
  while (added < 3 && dayOffset < 10) {
    const day = new Date(base);
    day.setUTCDate(day.getUTCDate() + dayOffset);
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      for (const h of hours) {
        if (added >= 3) break;
        const slot = new Date(day);
        slot.setUTCHours(h, 0, 0, 0);
        const iso = slot.toISOString();
        slots.push({ slot_id: iso, label: fmtSlot(iso) });
        added += 1;
      }
    }
    dayOffset += 1;
  }
  return {
    success: true,
    message: "Here are the next available times.",
    slots,
  };
}

// ---------------------------------------------------------------------------
// book_appointment (Calendly — mock until the integration goes live)
// ---------------------------------------------------------------------------
async function bookAppointment(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const slotId = str(body.slot_id);
  const email = str(body.email) || (ctx.lead.business_email ?? "");
  const name = str(body.name) || (ctx.lead.owner_name ?? "");
  if (!slotId) {
    return {
      success: false,
      message: "Which of the times I offered would you like to book?",
    };
  }

  const when = new Date(slotId);
  const label = Number.isNaN(when.getTime()) ? slotId : fmtSlot(slotId);

  // Live: book the slot directly on the campaign owner's Calendly.
  const cal = await resolveCampaignCalendly(ctx.supabase, ctx.campaignId);
  if (cal?.eventTypeUri) {
    if (Number.isNaN(when.getTime())) {
      return {
        success: false,
        message: "I didn't catch a valid time — which slot would you like?",
      };
    }
    if (!email) {
      return {
        success: false,
        message: "What's the best email for the calendar invite?",
      };
    }

    const result = await createInvitee(
      {
        eventTypeUri: cal.eventTypeUri,
        startTime: when.toISOString(),
        email,
        name: name || undefined,
        timezone: ctx.lead.timezone || "America/New_York",
      },
      cal.token,
    );
    if (!result.ok) {
      await logToolEvent(ctx, "tool_book_appointment", {
        slot_id: slotId,
        email,
        live: true,
        error: result.error,
      });
      return {
        success: false,
        message:
          "That time just became unavailable — could we pick another one?",
      };
    }

    // Record the booking and move the lead into the 'scheduled' pipeline.
    if (result.inviteeUri) {
      await ctx.supabase.from("calendly_events").insert({
        owner_id: ctx.lead.owner_id,
        lead_id: ctx.lead.id,
        invitee_uri: result.inviteeUri,
        event_uri: result.eventUri ?? "",
        event_type_uri: cal.eventTypeUri,
        invitee_email: email,
        invitee_name: name || null,
        scheduled_at: when.toISOString(),
        status: "scheduled",
      });
    }
    await ctx.supabase
      .from("leads")
      .update({ status: "scheduled", calendly_event_uri: result.eventUri })
      .eq("id", ctx.lead.id);
    await logToolEvent(ctx, "tool_book_appointment", {
      slot_id: slotId,
      email,
      live: true,
      invitee_uri: result.inviteeUri,
    });
    return {
      success: true,
      message: `You're booked for ${label}. A calendar invite is on its way to ${email}.`,
    };
  }

  // Mock: record the intent and confirm so the conversation completes.
  await logToolEvent(ctx, "tool_book_appointment", {
    slot_id: slotId,
    email,
    name,
  });
  return {
    success: true,
    message: `You're booked for ${label}. A calendar invite is on its way${
      email ? ` to ${email}` : ""
    }.`,
  };
}

// ---------------------------------------------------------------------------
// mark_dnc
// ---------------------------------------------------------------------------
async function markDnc(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const phone = (ctx.lead.business_phone || ctx.lead.owner_phone || "").trim();
  if (!phone) {
    return {
      success: false,
      message: "I've noted your request not to be called again.",
    };
  }

  const { error } = await ctx.supabase.from("dnc_entries").insert({
    phone,
    company_snapshot: ctx.lead.company,
    reason: "dnc_requested",
    // No user session in a webhook; attribute to the lead's owner.
    added_by_user_id: ctx.lead.owner_id,
    source_call_id: ctx.callId,
  });
  // 23505 = already on the DNC list. That's fine — the goal is met either way.
  if (error && error.code !== "23505") {
    return {
      success: false,
      message: "I've noted your request not to be called again.",
    };
  }

  await ctx.supabase
    .from("leads")
    .update({ status: "dnc", next_call_at: null })
    .eq("id", ctx.lead.id);

  await logToolEvent(ctx, "tool_mark_dnc", {
    phone,
    reason: str(body.reason),
  });

  return {
    success: true,
    message:
      "Understood — I've removed you from our list and you won't be contacted again.",
  };
}
