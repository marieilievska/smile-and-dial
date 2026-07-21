import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  cancelScheduledEvent,
  createInvitee,
  getAvailableTimes as calendlyGetAvailableTimes,
} from "@/lib/calendly/api";
import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import {
  localHourDaysAheadIso,
  parseZonedDatetime,
} from "@/lib/dialer/local-schedule";
import { renderTemplate, type TemplateContext } from "@/lib/close/templates";
import { deliverEmailViaClose } from "@/lib/close/send-email";
import { planEmailSend } from "@/lib/close/email-send-plan";
import { deliverSmsViaClose } from "@/lib/close/send-sms";
import { planTextSend } from "@/lib/close/text-send-plan";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * ElevenLabs server-tool webhooks.
 *
 * Each of our custom tools (see SERVER_TOOL_KEYS) is registered with
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

/** Our custom server tools, in the order the wizard lists them. */
export const SERVER_TOOL_KEYS = [
  "send_email",
  "send_text",
  "schedule_callback",
  "get_available_times",
  "book_appointment",
  "mark_dnc",
  "demo_front_desk",
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
 * The shared secret for server-tool webhooks. Prefers the env var (override)
 * but falls back to app_settings.elevenlabs_tool_webhook_secret — the DB value
 * is the reliable source since this project's Vercel env store has dropped
 * values before. Both the tool registration (header) and this validation read
 * it, so they always agree.
 */
export async function getToolWebhookSecret(): Promise<string> {
  const env = process.env.ELEVENLABS_TOOL_WEBHOOK_SECRET?.trim();
  if (env) return env;
  try {
    const supabase = makeServiceClient();
    const { data } = await supabase
      .from("app_settings")
      .select("elevenlabs_tool_webhook_secret")
      .eq("id", 1)
      .maybeSingle();
    return data?.elevenlabs_tool_webhook_secret?.trim() || "";
  } catch {
    return "";
  }
}

/**
 * Validate the shared-secret header ElevenLabs sends (configured as a request
 * header on each tool definition). Skipped in non-live mode (ELEVENLABS_LIVE
 * != "live") so Playwright can POST without a secret; in live mode a
 * constant-time match against the resolved secret is required.
 */
export async function isValidToolSecret(
  provided: string | null,
): Promise<boolean> {
  if (process.env.ELEVENLABS_LIVE !== "live") return true;
  const expected = await getToolWebhookSecret();
  if (!expected || !provided) return false;
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
    mobile_phone: string | null;
    owner_phone: string | null;
    business_email: string | null;
    owner_name: string | null;
    manager_name: string | null;
    employee_name: string | null;
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
      "id, owner_id, company, business_phone, mobile_phone, owner_phone, business_email, owner_name, manager_name, employee_name, timezone, status",
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

/** Human-readable slot label in the LEAD's local timezone. The agent reads
 *  these aloud as "your time," so they MUST be in the lead's zone — quoting them
 *  in a fixed Eastern zone booked an appointment 2 hours off for a Mountain-time
 *  lead (Aqua-Tots Lone Tree). Falls back to Eastern only when the lead's
 *  timezone is unknown. */
function fmtSlot(iso: string, timeZone: string | null | undefined): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone || "America/New_York",
  });
}

type CampaignCalendly = { token: string; eventTypeUri: string | null };

/**
 * Resolve the Calendly credentials + event type for a call: the CAMPAIGN
 * OWNER's connected token (per-user, from user_integrations) and the event
 * type EXPLICITLY assigned to the campaign.
 *
 * Returns:
 *  - null            — owner hasn't connected Calendly (demo/mock behavior).
 *  - {token, uri}    — connected AND a specific event was chosen → live booking.
 *  - {token, null}   — connected but NO event chosen → booking is OFF for this
 *                      campaign. We deliberately do NOT fall back to "the first
 *                      synced event": not every campaign is a booking campaign,
 *                      so an unset event means the AI should not book.
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
    case "send_text":
      return sendText(ctx, body);
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
/** The fixed email template attached to the campaign (campaigns.email_
 *  template_id). The send_email tool sends THIS template verbatim with the
 *  lead's variables filled — the AI doesn't write freeform copy. Null when
 *  the campaign has no template configured. */
async function resolveCampaignEmailTemplate(
  supabase: SupabaseAdmin,
  campaignId: string,
): Promise<{ id: string; name: string; subject: string; body: string } | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("email_template_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign?.email_template_id) return null;
  const { data: tmpl } = await supabase
    .from("email_templates")
    .select("id, name, subject, body")
    .eq("id", campaign.email_template_id)
    .maybeSingle();
  return tmpl ?? null;
}

/** Build the template-rendering context from the lead + owner + custom fields. */
async function buildEmailContext(ctx: CallContext): Promise<TemplateContext> {
  const [
    { data: lead },
    { data: ownerProfile },
    { data: customValues },
    { data: defs },
  ] = await Promise.all([
    ctx.supabase
      .from("leads")
      .select(
        "company, business_phone, business_email, owner_name, manager_name, employee_name, city, state",
      )
      .eq("id", ctx.lead.id)
      .maybeSingle(),
    ctx.supabase
      .from("profiles")
      .select("full_name")
      .eq("id", ctx.lead.owner_id)
      .maybeSingle(),
    ctx.supabase
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .eq("lead_id", ctx.lead.id),
    ctx.supabase.from("custom_field_defs").select("id, name"),
  ]);
  const defById = new Map((defs ?? []).map((d) => [d.id, d.name] as const));
  const customFields: Record<string, string> = {};
  for (const v of customValues ?? []) {
    const slug = defById.get(v.custom_field_id);
    if (slug && v.value != null) customFields[slug] = String(v.value);
  }
  const l = (lead ?? {}) as Record<string, string | null>;
  return {
    lead: {
      company: l.company,
      business_phone: l.business_phone,
      business_email: l.business_email,
      owner_name: l.owner_name,
      manager_name: l.manager_name,
      employee_name: l.employee_name,
      city: l.city,
      state: l.state,
    },
    owner: { full_name: ownerProfile?.full_name ?? null },
    customFields,
  };
}

/** Insert the sent `emails` row + bump the template's last_used_at. Shared by
 *  the real-delivery and mock paths (they differ only in from/message id). */
async function recordSentEmail(
  ctx: CallContext,
  args: {
    templateId: string;
    subject: string;
    body: string;
    toAddress: string;
    fromAddress: string;
    closeMessageId: string;
  },
): Promise<string | null> {
  const { data: inserted } = await ctx.supabase
    .from("emails")
    .insert({
      lead_id: ctx.lead.id,
      owner_id: ctx.lead.owner_id,
      campaign_id: ctx.campaignId,
      call_id: ctx.callId,
      direction: "sent",
      subject: args.subject,
      body: args.body,
      to_address: args.toAddress,
      from_address: args.fromAddress,
      close_message_id: args.closeMessageId,
      status: "sent",
      template_id: args.templateId,
    })
    .select("id")
    .maybeSingle();
  await ctx.supabase
    .from("email_templates")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", args.templateId);
  return inserted?.id ?? null;
}

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

  // Send the campaign's FIXED template (chosen in campaign settings). When no
  // template is attached we can only record the intent — there's nothing to
  // send — so the call still flows but the intent is recorded in system_events.
  const tmpl = await resolveCampaignEmailTemplate(ctx.supabase, ctx.campaignId);
  if (!tmpl) {
    await logToolEvent(ctx, "tool_send_email", {
      email,
      note,
      template_id: null,
      sent: false,
      reason: "no_template_on_campaign",
    });
    return {
      success: true,
      message: `Got it — I've noted to send that to ${email}.`,
    };
  }

  const renderCtx = await buildEmailContext(ctx);
  const subject = renderTemplate(tmpl.subject, renderCtx);
  const renderedBody = renderTemplate(tmpl.body, renderCtx);

  const live = process.env.ELEVENLABS_LIVE === "live";
  const sentMessage = `Done — I've sent the "${tmpl.name}" email to ${email}. It should arrive shortly.`;
  const notedMessage = `Got it — I've noted to send that to ${email}.`;

  // In live mode, look up the owner's Close key and attempt real delivery.
  // Non-live keeps a mock row so dev/test flows + the activity feed still work.
  let hasCloseKey = false;
  let delivered: Awaited<ReturnType<typeof deliverEmailViaClose>> | null = null;
  if (live) {
    const { data: integ } = await ctx.supabase
      .from("user_integrations")
      .select("close_api_key")
      .eq("user_id", ctx.lead.owner_id)
      .maybeSingle();
    const closeKey = integ?.close_api_key?.trim() || null;
    hasCloseKey = Boolean(closeKey);
    if (closeKey) {
      delivered = await deliverEmailViaClose({
        closeKey,
        senderName: renderCtx.owner?.full_name ?? null,
        toAddress: email,
        subject,
        body: renderedBody,
        contactName: ctx.lead.owner_name || ctx.lead.manager_name || null,
        company: ctx.lead.company,
        businessPhone: ctx.lead.business_phone,
      });
    }
  }

  const plan = planEmailSend({ live, hasCloseKey, delivered });

  // Honesty rule: never tell the lead we sent when we couldn't. When we can't
  // deliver we record the intent (system_events) but no fake "sent" row.
  if (plan.action === "note_only") {
    await logToolEvent(ctx, "tool_send_email", {
      email,
      note,
      template_id: tmpl.id,
      sent: false,
      reason: plan.reason,
    });
    return { success: true, message: notedMessage };
  }

  const isReal = plan.action === "record_real";
  const fromAddress =
    isReal && delivered?.ok
      ? delivered.fromAddress
      : renderCtx.owner?.full_name
        ? `${renderCtx.owner.full_name} via Close`
        : "Close mock";
  const closeMessageId =
    isReal && delivered?.ok
      ? delivered.closeMessageId
      : `mock-msg-${Date.now()}`;

  const emailId = await recordSentEmail(ctx, {
    templateId: tmpl.id,
    subject,
    body: renderedBody,
    toAddress: email,
    fromAddress,
    closeMessageId,
  });

  await logToolEvent(ctx, "tool_send_email", {
    email,
    template_id: tmpl.id,
    email_id: emailId,
    sent: true,
    mock: !isReal,
  });

  return { success: true, message: sentMessage };
}

// ---------------------------------------------------------------------------
// send_text
// ---------------------------------------------------------------------------
/** The fixed SMS template attached to the campaign (campaigns.sms_template_id).
 *  The send_text tool sends THIS template verbatim (+ an opt-out line). Null
 *  when the campaign has no SMS template configured. */
async function resolveCampaignSmsTemplate(
  supabase: SupabaseAdmin,
  campaignId: string,
): Promise<{ id: string; name: string; body: string } | null> {
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("sms_template_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign?.sms_template_id) return null;
  const { data: tmpl } = await supabase
    .from("sms_templates")
    .select("id, name, body")
    .eq("id", campaign.sms_template_id)
    .maybeSingle();
  return tmpl ?? null;
}

/** Normalize a mobile the AI read back into E.164 (defensive — the tool already
 *  asks for E.164). US country code assumed when none is present. */
function normalizeMobile(raw: string): string {
  const s = raw.replace(/[^\d+]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  if (s.length === 10) return `+1${s}`;
  if (s.length === 11 && s.startsWith("1")) return `+${s}`;
  return `+${s}`;
}

/** Insert the sent `texts` row + bump the template's last_used_at. Shared by the
 *  real-delivery and mock paths (they differ only in from/message id). */
async function recordSentText(
  ctx: CallContext,
  args: {
    templateId: string;
    body: string;
    toNumber: string;
    fromNumber: string;
    closeMessageId: string;
  },
): Promise<string | null> {
  const { data: inserted } = await ctx.supabase
    .from("texts")
    .insert({
      lead_id: ctx.lead.id,
      owner_id: ctx.lead.owner_id,
      campaign_id: ctx.campaignId,
      call_id: ctx.callId,
      direction: "sent",
      body: args.body,
      to_number: args.toNumber,
      from_number: args.fromNumber,
      close_message_id: args.closeMessageId,
      status: "sent",
      template_id: args.templateId,
    })
    .select("id")
    .maybeSingle();
  await ctx.supabase
    .from("sms_templates")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", args.templateId);
  return inserted?.id ?? null;
}

const SMS_OPT_OUT_LINE = "Reply STOP to opt out.";

async function sendText(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  // A text needs a MOBILE. The dialed business_phone is usually a landline, so
  // we use the mobile the AI confirmed on the call (or one stored earlier).
  const mobile =
    normalizeMobile(str(body.mobile)) || ctx.lead.mobile_phone || "";
  const note = str(body.note);
  if (!mobile) {
    return {
      success: false,
      message:
        "I don't have a mobile number to text — what's the best cell number to send it to?",
    };
  }

  // Persist the confirmed mobile (last-texted wins) so a future inbound STOP
  // from this number matches the lead and is honored.
  if (ctx.lead.mobile_phone !== mobile) {
    await ctx.supabase
      .from("leads")
      .update({ mobile_phone: mobile })
      .eq("id", ctx.lead.id);
  }

  // Never text an opted-out number — defense-in-depth beyond the dialer's DNC
  // skip, in case a STOP landed while a call to this lead was already in flight.
  if (ctx.lead.status === "dnc") {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      sent: false,
      reason: "lead_on_dnc",
    });
    return { success: true, message: "Got it — I've made a note." };
  }
  const { data: dncHit } = await ctx.supabase
    .from("dnc_entries")
    .select("phone")
    .eq("phone", mobile)
    .maybeSingle();
  if (dncHit) {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      sent: false,
      reason: "mobile_on_dnc",
    });
    return { success: true, message: "Got it — I've made a note." };
  }

  // Send the campaign's FIXED SMS template. No template → record the intent only.
  const tmpl = await resolveCampaignSmsTemplate(ctx.supabase, ctx.campaignId);
  if (!tmpl) {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      template_id: null,
      sent: false,
      reason: "no_template_on_campaign",
    });
    return {
      success: true,
      message: "Got it — I've noted to text that to you.",
    };
  }

  const renderCtx = await buildEmailContext(ctx);
  const rendered = renderTemplate(tmpl.body, renderCtx);
  const text = `${rendered}\n\n${SMS_OPT_OUT_LINE}`;

  const live = process.env.ELEVENLABS_LIVE === "live";
  const sentMessage =
    "Done — I've texted that to you. You should see it shortly.";
  const notedMessage = "Got it — I've noted to text that to you.";

  // Live: deliver via Close from the owner's configured send-from number. We only
  // claim "sent" on real success; otherwise we record the intent, no fake row.
  let hasCloseKey = false;
  let hasFromNumber = false;
  let fromNumber: string | null = null;
  let delivered: Awaited<ReturnType<typeof deliverSmsViaClose>> | null = null;
  if (live) {
    const { data: integ } = await ctx.supabase
      .from("user_integrations")
      .select("close_api_key, close_sms_from_number")
      .eq("user_id", ctx.lead.owner_id)
      .maybeSingle();
    const closeKey = integ?.close_api_key?.trim() || null;
    fromNumber = integ?.close_sms_from_number?.trim() || null;
    hasCloseKey = Boolean(closeKey);
    hasFromNumber = Boolean(fromNumber);
    if (closeKey && fromNumber) {
      delivered = await deliverSmsViaClose({
        closeKey,
        fromNumber,
        toMobile: mobile,
        text,
        company: ctx.lead.company,
        contactName: ctx.lead.owner_name || ctx.lead.manager_name || null,
      });
    }
  }

  const plan = planTextSend({ live, hasCloseKey, hasFromNumber, delivered });

  if (plan.action === "note_only") {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      template_id: tmpl.id,
      sent: false,
      reason: plan.reason,
    });
    return { success: true, message: notedMessage };
  }

  const isReal = plan.action === "record_real";
  const fromRecorded = isReal && fromNumber ? fromNumber : "Close mock";
  const closeMessageId =
    isReal && delivered?.ok
      ? delivered.closeMessageId
      : `mock-sms-${Date.now()}`;

  const textId = await recordSentText(ctx, {
    templateId: tmpl.id,
    body: text,
    toNumber: mobile,
    fromNumber: fromRecorded,
    closeMessageId,
  });

  await logToolEvent(ctx, "tool_send_text", {
    mobile,
    template_id: tmpl.id,
    text_id: textId,
    sent: true,
    mock: !isReal,
  });

  return { success: true, message: sentMessage };
}

// ---------------------------------------------------------------------------
// schedule_callback
// ---------------------------------------------------------------------------
async function scheduleCallback(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const raw = str(body.callback_datetime);
  // Trust an explicit offset; if the model dropped it, read the wall-clock time
  // in the LEAD's timezone (not the server's UTC) so the callback isn't stored
  // hours off.
  const when = parseZonedDatetime(raw, ctx.lead.timezone);
  if (!raw || !when || Number.isNaN(when.getTime())) {
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

  // Callbacks may be scheduled on weekends (agreed appointments), so honor the
  // exact time the lead asked for instead of rolling a weekend time to Monday.
  const scheduledAt = when.toISOString();

  // If this same call already booked a callback (the lead changed the time
  // mid-conversation), update that one in place instead of inserting a second.
  const { data: existing } = await ctx.supabase
    .from("callbacks")
    .select("id")
    .eq("originating_call_id", ctx.callId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();

  const { error } = existing
    ? await ctx.supabase
        .from("callbacks")
        .update({ scheduled_at: scheduledAt })
        .eq("id", existing.id)
    : await ctx.supabase.from("callbacks").insert({
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

  // Hand the lead to the callback queue at its EARLIEST pending callback (this
  // new one, or a sooner still-pending one) so a later callback never strands
  // an earlier overdue one.
  await syncLeadNextCallToEarliestCallback(ctx.supabase, ctx.lead.id);

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
    // Calendly is connected but this campaign has no event chosen → booking is
    // intentionally off; don't offer times.
    if (cal && !cal.eventTypeUri) {
      return {
        success: false,
        message: "Scheduling isn't enabled for this campaign.",
      };
    }
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
        label: fmtSlot(s.startTime, ctx?.lead.timezone),
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
  return genericAvailableTimes(ctx?.lead.timezone);
}

/** Three generic weekday slots at 10am / 2pm in the LEAD's local timezone, used
 *  in mock mode or when live Calendly has no openings in the window. Built with
 *  `localHourDaysAheadIso` (which anchors the hour in `tz` and rolls weekends
 *  forward) so a Mountain-time lead is offered 10am/2pm Mountain — not the fixed
 *  Eastern instants the old version produced. slot_id carries the ISO time so
 *  book_appointment can echo it back. */
function genericAvailableTimes(
  timeZone: string | null | undefined,
): ToolWebhookResult {
  const tz = timeZone || "America/New_York";
  const slots: { slot_id: string; label: string }[] = [];
  const seen = new Set<string>();
  for (let dayOffset = 1; dayOffset < 10 && slots.length < 3; dayOffset++) {
    for (const hour of [10, 14]) {
      if (slots.length >= 3) break;
      const iso = localHourDaysAheadIso(tz, dayOffset, hour);
      if (seen.has(iso)) continue; // weekend rolls can collide
      seen.add(iso);
      slots.push({ slot_id: iso, label: fmtSlot(iso, tz) });
    }
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
  // Calendly REQUIRES an invitee name — a booking sent without one is rejected
  // ("invitee either name or first_name must be filled"), and the generic
  // failure path below then tells the caller the SLOT is unavailable, which is
  // wrong (the Evolve Thermal Spa bug: it declined an open slot, then booked it
  // once a name was supplied). Prefer the name the agent passed, else any
  // contact we already know. If we have none, the guard below ASKS for it rather
  // than booking without one.
  const name =
    str(body.name) ||
    (ctx.lead.owner_name ?? "") ||
    (ctx.lead.manager_name ?? "") ||
    (ctx.lead.employee_name ?? "");
  if (!slotId) {
    return {
      success: false,
      message: "Which of the times I offered would you like to book?",
    };
  }

  const when = new Date(slotId);
  const label = Number.isNaN(when.getTime())
    ? slotId
    : fmtSlot(slotId, ctx.lead.timezone);

  const cal = await resolveCampaignCalendly(ctx.supabase, ctx.campaignId);

  // Calendly is connected but this campaign has no event chosen → booking is
  // intentionally off. Decline instead of faking a confirmation.
  if (cal && !cal.eventTypeUri) {
    await logToolEvent(ctx, "tool_book_appointment", {
      slot_id: slotId,
      email,
      booking_disabled: true,
    });
    return {
      success: false,
      message:
        "I'm not able to book a meeting on this call, but I'll make sure the team follows up.",
    };
  }

  // Live: book the slot directly on the campaign owner's Calendly.
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
    // Never send Calendly an empty name — ask for it rather than fail the
    // booking (which the caller would otherwise hear as the time being
    // unavailable).
    if (!name) {
      return {
        success: false,
        message: "What's their first name for the calendar invite?",
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
    let newEventId: string | null = null;
    if (result.inviteeUri) {
      const { data: inserted } = await ctx.supabase
        .from("calendly_events")
        .insert({
          owner_id: ctx.lead.owner_id,
          lead_id: ctx.lead.id,
          invitee_uri: result.inviteeUri,
          event_uri: result.eventUri ?? "",
          event_type_uri: cal.eventTypeUri,
          invitee_email: email,
          invitee_name: name || null,
          scheduled_at: when.toISOString(),
          status: "scheduled",
        })
        .select("id")
        .maybeSingle();
      newEventId = inserted?.id ?? null;
    }

    // De-dup: cancel any OTHER still-scheduled Calendly event for this lead — a
    // prior booking from earlier in THIS call (the agent rebooked because the
    // attendee or time changed mid-conversation). Without this the customer is
    // left double-booked, which is exactly what happened on the Aqua-Tots Lone
    // Tree call. Best-effort per event: a cancel that fails still gets marked
    // canceled locally + logged, and never blocks the new booking.
    if (newEventId) {
      const { data: priorEvents } = await ctx.supabase
        .from("calendly_events")
        .select("id, event_uri")
        .eq("lead_id", ctx.lead.id)
        .eq("status", "scheduled")
        .neq("id", newEventId);
      for (const prior of priorEvents ?? []) {
        const canceled = prior.event_uri
          ? await cancelScheduledEvent(prior.event_uri, cal.token)
          : { ok: false as const, error: "no event_uri on record" };
        await ctx.supabase
          .from("calendly_events")
          .update({ status: "canceled" })
          .eq("id", prior.id);
        await logToolEvent(ctx, "tool_book_appointment_dedup", {
          canceled_event_id: prior.id,
          event_uri: prior.event_uri,
          superseded_by: newEventId,
          calendly_cancel_ok: canceled.ok,
          calendly_cancel_error: canceled.ok ? null : canceled.error,
        });
      }
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
