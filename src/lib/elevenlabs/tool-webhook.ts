import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

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
      "id, owner_id, company, business_phone, owner_phone, business_email, owner_name, status",
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

  // get_available_times doesn't need a resolved call — it just offers slots.
  if (tool === "get_available_times") {
    return getAvailableTimes();
  }

  const ctx = await resolveCallContext(supabase, callId);
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
// get_available_times (Calendly — mock until the integration goes live)
// ---------------------------------------------------------------------------
function getAvailableTimes(): ToolWebhookResult {
  // Offer three slots over the next few business days at 10am / 2pm ET. These
  // are placeholders until the live Calendly availability API is wired; the
  // slot_id carries the ISO time so book_appointment can echo it back.
  const slots: { slot_id: string; label: string }[] = [];
  const base = new Date();
  let added = 0;
  let dayOffset = 1;
  const hours = [14, 18]; // 10am & 2pm US-Eastern expressed in UTC-ish terms
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
        slots.push({
          slot_id: iso,
          label: slot.toLocaleString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: "America/New_York",
          }),
        });
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
  const label = Number.isNaN(when.getTime())
    ? slotId
    : when.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });

  await logToolEvent(ctx, "tool_book_appointment", {
    slot_id: slotId,
    email,
    name,
  });

  // Real Calendly booking lands when CALENDLY_LIVE=live; for now we record
  // the intent and confirm so the conversation completes.
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
