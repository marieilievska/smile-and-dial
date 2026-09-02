import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  createInvitee,
  getAvailableTimes as calendlyGetAvailableTimes,
  getEventTypeConfig,
  type CalendlySlot,
} from "@/lib/calendly/api";
import {
  availabilityWindows,
  bookingTracking,
  buildInviteeLocation,
  buildQuestionsAndAnswers,
  OFFER_LOOKAHEAD_DAYS,
  relativeDayLabel,
} from "@/lib/calendly/booking";
import { hasBookingAtSlot } from "@/lib/calendly/booking-dedup";
import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import {
  localHourDaysAheadIso,
  parseZonedDatetime,
} from "@/lib/dialer/local-schedule";
import { renderTemplate, type TemplateContext } from "@/lib/close/templates";
import { shortenMessageLink } from "@/lib/shortlinks/shorten-message";
import { linkUtmParams } from "@/lib/shortlinks/destination";
import type { LeadLinkParams } from "@/lib/shortlinks/destination";
import { deliverEmailViaClose } from "@/lib/close/send-email";
import { planEmailSend } from "@/lib/close/email-send-plan";
import { deliverSmsViaClose } from "@/lib/close/send-sms";
import { planTextSend } from "@/lib/close/text-send-plan";
import {
  ownSiteOrigin,
  researchBusiness,
} from "@/lib/openai/business-research";
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
    city: string | null;
    state: string | null;
    website: string | null;
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
      "id, owner_id, company, business_phone, mobile_phone, owner_phone, business_email, city, state, website, owner_name, manager_name, employee_name, timezone, status",
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

type CampaignCalendly = {
  token: string;
  eventTypeUri: string | null;
  campaignName: string | null;
  /** Fixed-time event (webinar): book the event's soonest opening without the
   *  lead choosing a time. See bookAppointment. */
  fixedTimeBooking: boolean;
  /** The campaign's "Booking UTM campaign" setting — stamped as utm_campaign on
   *  every booking. null = fall back to the legacy map / campaign name. */
  bookingUtmCampaign: string | null;
};

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
    .select(
      "owner_id, calendly_event_id, name, fixed_time_booking, booking_utm_campaign",
    )
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
  return {
    token,
    eventTypeUri,
    campaignName: campaign.name ?? null,
    fixedTimeBooking: campaign.fixed_time_booking === true,
    bookingUtmCampaign: campaign.booking_utm_campaign ?? null,
  };
}

/** The soonest upcoming Calendly opening for an event type, or null when there
 *  are none in the scanned window. Reuses the same forward-window scan as
 *  get_available_times (Calendly caps each query at 7 days), so a webinar weeks
 *  out is still found. Openings come back chronological, so the first hit is the
 *  soonest — which for a fixed-time event is the session to book everyone into. */
async function soonestCalendlyOpening(
  eventTypeUri: string,
  token: string,
): Promise<string | null> {
  for (const w of availabilityWindows(Date.now())) {
    const live = await calendlyGetAvailableTimes(
      eventTypeUri,
      w.startISO,
      w.endISO,
      token,
    );
    if (live.length > 0) return live[0].startTime;
  }
  return null;
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
    case "demo_front_desk":
      return demoFrontDesk(ctx, body);
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

/** Build the template-rendering context from the lead + owner + custom fields.
 *  The campaign is included so the documented {{campaign.name}} token resolves
 *  (it silently rendered empty before) and so we can attribute short links to
 *  the campaign via utm_campaign. */
async function buildEmailContext(ctx: CallContext): Promise<TemplateContext> {
  const [
    { data: lead },
    { data: ownerProfile },
    { data: customValues },
    { data: defs },
    { data: campaign },
  ] = await Promise.all([
    ctx.supabase
      .from("leads")
      .select(
        "company, business_phone, business_email, owner_name, manager_name, employee_name, city, state, google_place_id",
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
    ctx.supabase
      .from("campaigns")
      .select("name")
      .eq("id", ctx.campaignId)
      .maybeSingle(),
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
      google_place_id: l.google_place_id,
    },
    campaign: { name: campaign?.name ?? null },
    owner: { full_name: ownerProfile?.full_name ?? null },
    customFields,
  };
}

/** The per-lead parameters the presell page reads, built from the database
 *  rather than from anything the AI heard on the call — exact spelling every
 *  time, and present even when the caller never mentioned their city.
 *  `address` is deliberately absent: we store city/state but no street address,
 *  and a half-filled address field reads as broken. */
function leadLinkParams(args: {
  renderCtx: TemplateContext;
  campaignId: string;
  channel: "sms" | "email";
  email: string | null;
}): LeadLinkParams {
  const lead = args.renderCtx.lead;
  return {
    business_name: lead.company ?? null,
    phone: lead.business_phone ?? null,
    email: args.email || (lead.business_email ?? null),
    google_place_id: lead.google_place_id ?? null,
    // Attribution: defaults for every campaign, overridden per-campaign (e.g.
    // HireAI Presell) in linkUtmParams. utm_medium is the send channel.
    ...linkUtmParams({
      campaignId: args.campaignId,
      campaignName: args.renderCtx.campaign?.name ?? null,
      channel: args.channel,
    }),
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
  // Personalise + shorten the template's link before anything is delivered or
  // recorded, so the stored body is exactly what the lead received.
  const renderedBody = await shortenMessageLink({
    supabase: ctx.supabase,
    leadId: ctx.lead.id,
    ownerId: ctx.lead.owner_id,
    campaignId: ctx.campaignId,
    channel: "email",
    campaignName: renderCtx.campaign?.name ?? null,
    company: ctx.lead.company,
    body: renderTemplate(tmpl.body, renderCtx),
    // The address the AI just confirmed out loud beats the stored one — it's
    // the one the lead actually gave us.
    params: leadLinkParams({
      renderCtx,
      campaignId: ctx.campaignId,
      channel: "email",
      email,
    }),
  });

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
  // Shortening matters most here: the personalised URL is ~250 characters, which
  // would split one text into three segments and attract carrier filtering.
  const rendered = await shortenMessageLink({
    supabase: ctx.supabase,
    leadId: ctx.lead.id,
    ownerId: ctx.lead.owner_id,
    campaignId: ctx.campaignId,
    channel: "sms",
    campaignName: renderCtx.campaign?.name ?? null,
    company: ctx.lead.company,
    body: renderTemplate(tmpl.body, renderCtx),
    // No email confirmed on a text — fall back to the stored one, or omit.
    params: leadLinkParams({
      renderCtx,
      campaignId: ctx.campaignId,
      channel: "sms",
      email: null,
    }),
  });
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

  // The message is what the model sees LAST before it speaks again, so it
  // carries the next step. Without it, gpt-class models fall back on their
  // customer-service prior right after a successful tool call — "and before I
  // let you go, can I help you with anything else?" — which the prompt forbids
  // (outbound call) but which two of today's 31 wrap-ups still produced.
  return {
    success: true,
    message:
      `Callback set for ${fmtSlot(scheduledAt, ctx.lead.timezone)}. ` +
      `NEXT: wrap up in ONE line ("Perfect, I'll give you a shout [day]. Appreciate you, talk soon.") ` +
      `and end the call. Do NOT ask if there's anything else you can help with.`,
  };
}

// ---------------------------------------------------------------------------
// get_available_times (live Calendly when configured, generic slots otherwise)
// ---------------------------------------------------------------------------
/** Upper bound on the slots handed to the agent in one call. A daily group
 *  session never gets near it inside OFFER_LOOKAHEAD_DAYS (five weekdays at
 *  most); the cap exists so a one-on-one event type — dozens of 30-minute
 *  openings in five days — can't flood the model's context. */
const MAX_OFFERED_SLOTS = 6;

/** One offered slot as the agent sees it. `label` is the full date + time in
 *  the LEAD's local time (so the prompt never does timezone math), `when` is the
 *  word a person would use for that day ("tomorrow", "Thursday"). */
type OfferedSlot = { slot_id: string; label: string; when: string };

async function getAvailableTimesResult(
  ctx: CallContext | null,
): Promise<ToolWebhookResult> {
  // Offer the campaign owner's real Calendly openings over the next few days.
  // Falls back to generic slots only if the owner hasn't connected Calendly at
  // all, so the conversation moves.
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
      // ONE short window (see OFFER_LOOKAHEAD_DAYS). The daily webinar runs
      // every weekday and its Calendly event only books a few days out, so the
      // agent gets EVERY open session in that range in a single call — a
      // handful of lines it can answer "does Thursday work?" from on the spot,
      // instead of the first three openings of a six-week scan plus a second
      // round-trip (dead air on the phone) for any day the owner names.
      const now = Date.now();
      const [window] = availabilityWindows(now, {
        windows: 1,
        spanDays: OFFER_LOOKAHEAD_DAYS,
      });
      const live: CalendlySlot[] = await calendlyGetAvailableTimes(
        cal.eventTypeUri,
        window.startISO,
        window.endISO,
        cal.token,
      );
      const slots: OfferedSlot[] = live
        .slice(0, MAX_OFFERED_SLOTS)
        .map((s) => ({
          slot_id: s.startTime,
          label: fmtSlot(s.startTime, ctx.lead.timezone),
          when: relativeDayLabel(s.startTime, now, ctx.lead.timezone),
        }));
      // A real Calendly event is attached, so offer its TRUE openings — or say
      // there are none. Never invent generic slots here: fake times contradict
      // the real date the agent quotes and produce un-bookable slot_ids (the
      // "why is it offering other times?" bug).
      if (slots.length > 0) {
        return {
          success: true,
          message:
            "Open sessions over the next few days, soonest first. Times are already in the lead's local time; `when` is how to say the day (today / tomorrow / the weekday).",
          slots,
        };
      }
      return {
        success: false,
        message:
          "No open sessions over the next few days. Don't invent a time — offer to check back another day instead.",
      };
    }
  }
  // Only reached with no resolved call, or an owner who hasn't connected
  // Calendly at all → generic demo/mock slots keep the conversation moving.
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
  const now = Date.now();
  const slots: OfferedSlot[] = [];
  const seen = new Set<string>();
  for (let dayOffset = 1; dayOffset < 10 && slots.length < 3; dayOffset++) {
    for (const hour of [10, 14]) {
      if (slots.length >= 3) break;
      const iso = localHourDaysAheadIso(tz, dayOffset, hour);
      if (seen.has(iso)) continue; // weekend rolls can collide
      seen.add(iso);
      slots.push({
        slot_id: iso,
        label: fmtSlot(iso, tz),
        when: relativeDayLabel(iso, now, tz),
      });
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
  let slotId = str(body.slot_id);
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

  // Resolve the campaign's Calendly BEFORE the slot check: a fixed-time event
  // supplies its own time, so we need to know that before deciding a missing
  // slot_id is a problem.
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

  // Fixed-time event (webinar): one known session, so the agent books with just
  // name + email and never calls get_available_times. Resolve the event's
  // soonest opening ourselves rather than making the model invent a slot_id it
  // was never given.
  if (!slotId && cal?.eventTypeUri && cal.fixedTimeBooking) {
    const soonest = await soonestCalendlyOpening(cal.eventTypeUri, cal.token);
    if (!soonest) {
      await logToolEvent(ctx, "tool_book_appointment", {
        email,
        fixed_time: true,
        no_opening: true,
      });
      return {
        success: false,
        message:
          "That session isn't open for booking right now — I'll have the team follow up.",
      };
    }
    slotId = soonest;
  }

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

    // Idempotency guard (webinar-SAFE — never cancels): if this lead is already
    // registered for this event at this exact slot, return that booking instead
    // of creating a SECOND Calendly invitee. book_appointment gets invoked twice
    // within one call (the model re-confirms, or ElevenLabs re-delivers a slow
    // tool call), and with the old cancel-based de-dup removed (cancelling a
    // shared webinar session drops every registrant) that produced duplicate
    // registrations for the same person on the same session. Backed atomically
    // by a partial unique index on (lead_id, event_type_uri, scheduled_at) where
    // status='scheduled'.
    const { data: leadBookings } = await ctx.supabase
      .from("calendly_events")
      .select("scheduled_at")
      .eq("lead_id", ctx.lead.id)
      .eq("event_type_uri", cal.eventTypeUri)
      .eq("status", "scheduled");
    if (hasBookingAtSlot(leadBookings ?? [], when.toISOString())) {
      await logToolEvent(ctx, "tool_book_appointment", {
        slot_id: slotId,
        email,
        live: true,
        already_booked: true,
      });
      return {
        success: true,
        message: `Already booked: ${label}, invite going to ${email}. ${AFTER_BOOKING_NEXT_STEP}`,
      };
    }

    // Read the host's live event-type config once, then echo back BOTH things
    // Calendly refuses a booking without:
    //  - the location (Zoom/Meet/etc.), or it returns "location_configuration.
    //    kind invalid location choice";
    //  - answers to every required booking-form question, or it returns
    //    "Required Questions and Answers cannot be blank." — the host added a
    //    required "Company name" field on 2026-08-18 and took booking to 0%.
    // Both are the HOST's settings and can change any day without a deploy, so
    // they're read per booking rather than assumed.
    const eventConfig = await getEventTypeConfig(cal.eventTypeUri, cal.token);
    const location = buildInviteeLocation(eventConfig.locations);
    const questionsAndAnswers = buildQuestionsAndAnswers(
      eventConfig.customQuestions,
      {
        company: ctx.lead.company,
        name,
        email,
        phone: ctx.lead.business_phone || ctx.lead.owner_phone,
      },
    );
    // UTM attribution so booked appointments are traceable to Smile & Dial in
    // Calendly's reporting (utm_source=smile_dial, utm_medium=voice, campaign
    // per bookingTracking). Surfaces on the invitee + the post-call webhook.
    const tracking = bookingTracking({
      campaignId: ctx.campaignId,
      campaignName: cal.campaignName,
      leadId: ctx.lead.id,
      bookingUtmCampaign: cal.bookingUtmCampaign,
    });
    const result = await createInvitee(
      {
        eventTypeUri: cal.eventTypeUri,
        startTime: when.toISOString(),
        email,
        name: name || undefined,
        timezone: ctx.lead.timezone || "America/New_York",
        location,
        tracking,
        questionsAndAnswers,
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
      // Only a genuine availability clash should send the AI back to pick
      // another time. Every OTHER failure is a config problem on the host's
      // Calendly (a required question, a bad location, a revoked token) that
      // re-picking cannot fix — the old blanket "that time just became
      // unavailable" made the AI re-offer the SAME slot over and over and let a
      // full-day, 100%-failure outage pass as ordinary bad luck. Say something
      // true instead, and bank the email so the lead isn't lost.
      const slotGone =
        /unavailable|already.*(booked|taken)|no longer|invalid start.?time|spot|capacity|full/i.test(
          result.error ?? "",
        );
      return {
        success: false,
        message: slotGone
          ? "That time is no longer open. Offer the lead the next open option from your list instead."
          : `I can't complete the booking from here, but I've got ${email} — the team will send the invite through shortly.`,
      };
    }

    // Record the booking and move the lead into the 'scheduled' pipeline.
    //
    // We deliberately do NOT cancel any prior booking for this lead. The old
    // de-dup cancelled the lead's other still-scheduled event to avoid a double
    // booking — safe for a 1:1 meeting, but catastrophic for a GROUP event
    // (webinar), where the "scheduled_event" is the SHARED session: cancelling
    // it drops EVERY registrant (it wiped 3 real ones during a test). Operator's
    // call (2026-07-31): never cancel — allow a duplicate booking instead. A
    // repeat invite is harmless; a cancelled session is not. The rare 1:1 rebook
    // now leaves two holds for a human to reconcile, which is the accepted trade.
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
      message: `Booked: ${label}, invite going to ${email}. ${AFTER_BOOKING_NEXT_STEP}`,
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
    message: `Booked: ${label}${email ? `, invite going to ${email}` : ""}. ${AFTER_BOOKING_NEXT_STEP}`,
  };
}

/** Appended to every successful booking result. The tool result is the last
 *  thing the model reads before its next line, so it is the most reliable
 *  place to say what that line must be. On 2026-09-02 one of two bookings
 *  skipped the scripted sign-off entirely and said "Can I help you with
 *  anything else?" — the model's customer-service reflex after a successful
 *  tool call. The prompt already forbids the phrase; this closes the gap at the
 *  moment it actually happens. */
const AFTER_BOOKING_NEXT_STEP =
  "NEXT: say the sign-off from your script word for word (restate the day and time, " +
  'invite\'s hitting their inbox, then "Appreciate you, talk soon") and end the call. ' +
  "Do NOT ask if there's anything else you can help with.";

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

// ---------------------------------------------------------------------------
// demo_front_desk
// ---------------------------------------------------------------------------
/** The lead's imported `booking_crm_software` value (Vagaro, Square, ...).
 *  We know this from import rather than from the web, so it is the one fact in
 *  the brief that cannot be wrong — and it's what lets the demo say "I'll get
 *  you on the books in Vagaro". Same two-step lookup the conversation-init
 *  webhook does for the matching dynamic variable. Null when unset. */
async function resolveBookingSoftware(
  ctx: CallContext,
): Promise<string | null> {
  const { data: def } = await ctx.supabase
    .from("custom_field_defs")
    .select("id")
    .eq("slug", "booking_crm_software")
    .maybeSingle();
  if (!def?.id) return null;
  const { data: val } = await ctx.supabase
    .from("lead_custom_values")
    .select("value")
    .eq("lead_id", ctx.lead.id)
    .eq("custom_field_id", def.id)
    .maybeSingle();
  const v = val?.value;
  const s = typeof v === "string" ? v : v != null ? String(v) : "";
  return s.trim() || null;
}

/**
 * Research the lead's business live so the agent can role-play their own front
 * desk. Returns the brief alongside a speakable `message`; the agent's own
 * prompt decides how the demo is performed.
 *
 * Always succeeds. When research finds nothing the brief is still complete and
 * the message tells the agent to keep the demo general — a stalled tool call
 * mid-conversation is far worse than a vague demo.
 */
async function demoFrontDesk(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  const startedAt = Date.now();

  const brief = await researchBusiness({
    company: ctx.lead.company,
    city: ctx.lead.city,
    state: ctx.lead.state,
    website: ctx.lead.website,
    bookingSoftware: await resolveBookingSoftware(ctx),
    heardOnCall: str(body.heard_on_call) || null,
  });

  // Free enrichment: essentially no lead has a website today, and that column
  // is what pins the NEXT research run. Only ever fill a blank — never
  // overwrite (the same rule sendEmail follows for business_email) — and only
  // with the business's OWN site, never a directory listing.
  const discovered = ctx.lead.website ? null : ownSiteOrigin(brief.source_url);
  if (discovered) {
    await ctx.supabase
      .from("leads")
      .update({ website: discovered })
      .eq("id", ctx.lead.id);
  }

  await logToolEvent(ctx, "tool_demo_front_desk", {
    found: brief.found,
    source_url: brief.source_url,
    website_captured: discovered,
    took_ms: Date.now() - startedAt,
  });

  return {
    success: true,
    message: brief.found
      ? "I've got their details — use this brief to play their front desk."
      : "I couldn't confirm much about them online — keep the demo general and don't state any specifics.",
    brief,
  };
}
