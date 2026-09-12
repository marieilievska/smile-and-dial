import "server-only";

import { timingSafeEqual } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  createInvitee,
  fetchAvailableTimes,
  getEventTypeConfig,
} from "@/lib/calendly/api";
import {
  availabilityWindows,
  bookingPhoneAudit,
  bookingPhoneOutcome,
  bookingTracking,
  buildInviteeLocation,
  buildOptionalPhoneAnswer,
  buildQuestionsAndAnswers,
  type DncLookup,
  isSlotGoneError,
  pickBookingPhone,
  relativeDayLabel,
  requiredQuestionPhone,
} from "@/lib/calendly/booking";
import { agreedDayMatchesSlot } from "@/lib/calendly/agreed-day";
import { hasBookingAtSlot } from "@/lib/calendly/booking-dedup";
import {
  BOOKING_NOT_CONFIGURED_MESSAGE,
  planBookingTool,
} from "@/lib/calendly/booking-tools-plan";
import { resolveOfferableSlots } from "@/lib/calendly/copy-store";
import {
  AVAILABILITY_TIMEOUT_MS,
  soonestFromCopy,
} from "@/lib/calendly/copy-rules";
import { afterResponse } from "@/lib/server/after-response";
import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import {
  clampCallbackToFloor,
  localHourDaysAheadIso,
  relativeCallbackInstant,
  resolveCallbackDatetime,
} from "@/lib/dialer/local-schedule";
import { toUsCaPhone } from "@/lib/leads/us-ca-phone";
import { renderTemplate, type TemplateContext } from "@/lib/close/templates";
import { etDayString } from "@/lib/time/eastern";
import { shortenMessageLink } from "@/lib/shortlinks/shorten-message";
import { linkUtmParams } from "@/lib/shortlinks/destination";
import type { LeadLinkParams } from "@/lib/shortlinks/destination";
import { deliverEmailViaClose } from "@/lib/close/send-email";
import {
  emailNotSentMessage,
  emailToolReadiness,
  planEmailSend,
} from "@/lib/close/email-send-plan";
import { deliverSmsViaClose } from "@/lib/close/send-sms";
import { syncCloseSmsNumbers } from "@/lib/close/sms-numbers";
import { planTextSend, textNotSentMessage } from "@/lib/close/text-send-plan";
import {
  ownSiteOrigin,
  researchBusinessWithUsage,
} from "@/lib/openai/business-research";
import { recordAiCharge } from "@/lib/costs/ai-charges";
import { numField, withRecomputedTotal } from "@/lib/costs/breakdown";
import type { Database, Json } from "@/lib/supabase/database.types";
import { ToolTimer } from "@/lib/elevenlabs/tool-timing";

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
  /** Times the steps of this one tool call; snapshotted onto its audit row. */
  timer: ToolTimer;
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
  timer: ToolTimer,
): Promise<CallContext | null> {
  if (!callId) return null;
  const { data: call } = await timer.time("context", () =>
    supabase
      .from("calls")
      .select("id, lead_id, campaign_id")
      .eq("id", callId)
      .maybeSingle(),
  );
  if (!call?.lead_id || !call.campaign_id) return null;

  const { data: lead } = await timer.time("context", () =>
    supabase
      .from("leads")
      .select(
        "id, owner_id, company, business_phone, mobile_phone, owner_phone, business_email, city, state, website, owner_name, manager_name, employee_name, timezone, status",
      )
      .eq("id", call.lead_id)
      .maybeSingle(),
  );
  if (!lead) return null;

  return {
    supabase,
    callId: call.id,
    campaignId: call.campaign_id,
    lead,
    timer,
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
  /** The event-type ROW id (not the Calendly URI), so a refreshed copy can be
   *  written back. Null when the campaign has no event chosen. */
  eventTypeId: string | null;
  /** Our stored copy of this event's open times, and when it was read. May be
   *  stale or absent — calendly/copy-rules decides whether to trust it. */
  availabilitySlots: unknown;
  availabilityFetchedAt: string | null;
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
  let eventTypeId: string | null = null;
  let availabilitySlots: unknown = null;
  let availabilityFetchedAt: string | null = null;
  if (campaign.calendly_event_id) {
    const { data: et } = await supabase
      .from("calendly_event_types")
      .select("id, event_uri, availability_slots, availability_fetched_at")
      .eq("id", campaign.calendly_event_id)
      .maybeSingle();
    eventTypeUri = et?.event_uri ?? null;
    eventTypeId = et?.id ?? null;
    availabilitySlots = et?.availability_slots ?? null;
    availabilityFetchedAt = et?.availability_fetched_at ?? null;
  }
  return {
    token,
    eventTypeUri,
    campaignName: campaign.name ?? null,
    fixedTimeBooking: campaign.fixed_time_booking === true,
    bookingUtmCampaign: campaign.booking_utm_campaign ?? null,
    eventTypeId,
    availabilitySlots,
    availabilityFetchedAt,
  };
}

/** The soonest upcoming Calendly opening for an event type, or null when there
 *  are none in the scanned windows — or when Calendly doesn't answer. Reuses
 *  the same forward-window scan as get_available_times (Calendly caps each
 *  query at 7 days), so a webinar weeks out is still found. Bounded per window
 *  (AVAILABILITY_TIMEOUT_MS) and STOPS at the first window Calendly fails to
 *  answer, returning null rather than trying the rest: a Calendly that times
 *  out once is not going to answer five more windows inside the ~20 s
 *  ElevenLabs allows for this tool call. An empty but successful window just
 *  moves on to the next one. Openings come back chronological, so the first
 *  hit in a successful window is the soonest — which for a fixed-time event is
 *  the session to book everyone into. */
async function soonestCalendlyOpening(
  eventTypeUri: string,
  token: string,
): Promise<string | null> {
  for (const w of availabilityWindows(Date.now())) {
    const result = await fetchAvailableTimes(
      eventTypeUri,
      w.startISO,
      w.endISO,
      token,
      AVAILABILITY_TIMEOUT_MS,
    );
    if (!result.ok) return null;
    if (result.slots.length > 0) return result.slots[0].startTime;
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
  // One timer per tool call, from the first line of work to the audit row.
  const timer = new ToolTimer();
  const ctx = await resolveCallContext(supabase, callId, timer);

  // get_available_times doesn't hard require a resolved call: off-live it falls
  // back to generic slots, and on a live call it declines honestly (it needs
  // the call to know whose Calendly to read).
  if (tool === "get_available_times") {
    return getAvailableTimesResult(supabase, ctx, callId, timer);
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
  // Snapshot now, so total_ms measures the tool — not the audit write, and not
  // however long after() waits before running it.
  const row = {
    kind,
    actor_user_id: null,
    ref_table: "calls",
    ref_id: ctx.callId,
    payload: { ...payload, timings: ctx.timer.snapshot() } as Json,
  };
  // Written after the response: an audit row must never make a caller wait.
  await afterResponse(async () => {
    await ctx.supabase.from("system_events").insert(row);
  });
}

/** One `tool_*_not_configured` row per campaign per hour. A campaign of 300
 *  dials whose owner never connected Calendly (or Close, or attached a
 *  template) would otherwise write 300 identical rows into the Activity feed. */
const NOT_CONFIGURED_LOG_THROTTLE_MS = 60 * 60 * 1000;

type ToolNotConfiguredKind =
  | "tool_booking_not_configured"
  | "tool_email_not_configured"
  | "tool_text_not_configured";

/** Record that a LIVE call reached a tool with nothing configured behind it
 *  (no Calendly, no Close, no template…), so the gap is visible instead of
 *  silently eating every attempt. Campaign-scoped (ref_table "campaigns") and
 *  throttled to once an hour per campaign PER KIND; with no resolvable
 *  campaign it's logged against the call id every time (rare — the tool
 *  definition lost its call_id). Best-effort. */
async function logToolNotConfigured(
  supabase: SupabaseAdmin,
  input: {
    kind: ToolNotConfiguredKind;
    campaignId: string | null;
    callId: string | null;
    tool: string;
    reason: string;
  },
): Promise<void> {
  try {
    if (input.campaignId) {
      const since = new Date(
        Date.now() - NOT_CONFIGURED_LOG_THROTTLE_MS,
      ).toISOString();
      const { data: recent } = await supabase
        .from("system_events")
        .select("id")
        .eq("kind", input.kind)
        .eq("ref_table", "campaigns")
        .eq("ref_id", input.campaignId)
        .gte("created_at", since)
        .limit(1);
      if (recent && recent.length > 0) return; // throttled
    }
    await supabase.from("system_events").insert({
      kind: input.kind,
      actor_user_id: null,
      ref_table: input.campaignId ? "campaigns" : "calls",
      ref_id: input.campaignId ?? input.callId,
      payload: {
        campaign_id: input.campaignId,
        call_id: input.callId,
        tool: input.tool,
        reason: input.reason,
      },
    });
  } catch {
    // best-effort — never fail the tool call over an audit row
  }
}

/** A booking tool reached with no Calendly behind it — see logToolNotConfigured. */
async function logBookingNotConfigured(
  supabase: SupabaseAdmin,
  input: {
    campaignId: string | null;
    callId: string | null;
    tool: "get_available_times" | "book_appointment";
    reason: "owner_calendly_not_connected" | "unresolved_call";
  },
): Promise<void> {
  await logToolNotConfigured(supabase, {
    kind: "tool_booking_not_configured",
    ...input,
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

  // Send the campaign's FIXED template (chosen in campaign settings). Live
  // delivery goes through the lead owner's Close account; non-live keeps a
  // mock row so dev/test flows + the activity feed still work.
  const tmpl = await resolveCampaignEmailTemplate(ctx.supabase, ctx.campaignId);
  const live = process.env.ELEVENLABS_LIVE === "live";
  let closeKey: string | null = null;
  if (live) {
    const { data: integ } = await ctx.supabase
      .from("user_integrations")
      .select("close_api_key")
      .eq("user_id", ctx.lead.owner_id)
      .maybeSingle();
    closeKey = integ?.close_api_key?.trim() || null;
  }

  // Can this call send an email AT ALL? No template means there is nothing to
  // send; live with no Close key means nowhere to send it from. Either way the
  // agent is told plainly (success:false) so it never promises an email that
  // isn't coming — the old "Got it — I've noted to send that" read as a yes.
  // The intent is still recorded per call, and the configuration gap once an
  // hour per campaign so it shows in the Activity feed (same pattern as
  // tool_booking_not_configured). No `emails` row is ever written here.
  const readiness = emailToolReadiness({
    live,
    hasTemplate: Boolean(tmpl),
    hasCloseKey: Boolean(closeKey),
  });
  if (!tmpl || !readiness.ready) {
    const reason = readiness.ready
      ? "no_template_on_campaign"
      : readiness.reason;
    await logToolEvent(ctx, "tool_send_email", {
      email,
      note,
      template_id: tmpl?.id ?? null,
      sent: false,
      reason,
    });
    if (live) {
      await logToolNotConfigured(ctx.supabase, {
        kind: "tool_email_not_configured",
        campaignId: ctx.campaignId,
        callId: ctx.callId,
        tool: "send_email",
        reason,
      });
    }
    return { success: false, message: emailNotSentMessage(reason) };
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

  const sentMessage = `Done — I've sent the "${tmpl.name}" email to ${email}. It should arrive shortly.`;

  // Live: attempt real delivery through the owner's Close account.
  let delivered: Awaited<ReturnType<typeof deliverEmailViaClose>> | null = null;
  if (live && closeKey) {
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

  const plan = planEmailSend({
    live,
    hasCloseKey: Boolean(closeKey),
    delivered,
  });

  // Honesty rule: never tell the lead we sent when we couldn't. When delivery
  // fails we record the intent (system_events), write no fake "sent" row, and
  // tell the agent it did NOT go out (success:false) so it can say so. A Close
  // account with no email it can send from is a configuration gap — surfaced
  // once an hour per campaign like the other not-configured events.
  if (plan.action === "note_only") {
    await logToolEvent(ctx, "tool_send_email", {
      email,
      note,
      template_id: tmpl.id,
      sent: false,
      reason: plan.reason,
    });
    if (plan.reason === "no_connected_sending_email") {
      await logToolNotConfigured(ctx.supabase, {
        kind: "tool_email_not_configured",
        campaignId: ctx.campaignId,
        callId: ctx.callId,
        tool: "send_email",
        reason: plan.reason,
      });
    }
    return { success: false, message: emailNotSentMessage(plan.reason) };
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
/** A cell the agent heard, in E.164, or "" when it isn't a usable US/Canada
 *  number. One rule with the booking path (toUsCaPhone), which is the point:
 *  this used to prefix "+" onto whatever digits arrived, so a foreign number —
 *  or half of a misheard one — was stored on the lead, texted, matched against
 *  inbound replies, and handed to Calendly as the booking phone, while the
 *  very same cell was refused for a booking. */
function normalizeMobile(raw: string): string {
  return toUsCaPhone(raw) ?? "";
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
  // The stored one goes through the same check rather than being trusted: the
  // old rule saved foreign and half-heard numbers and nothing has re-examined
  // them since. One in an older format is tidied up by the save below.
  const mobile =
    normalizeMobile(str(body.mobile)) ||
    normalizeMobile(ctx.lead.mobile_phone ?? "");
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
  // The LEAD OWNER's list, and only theirs: DNC is enforced per person
  // (20260906020000), so a teammate's entry for this mobile does not stop this
  // owner's text. limit(1), not maybeSingle(): the owner filter makes at most
  // one row possible today, but maybeSingle() errors on two — which would read
  // as "not on DNC" and text an opted-out number, so keep the safe shape.
  const { data: dncHits } = await ctx.supabase
    .from("dnc_entries")
    .select("phone")
    .eq("phone", mobile)
    .eq("owner_id", ctx.lead.owner_id)
    .limit(1);
  if (dncHits && dncHits.length > 0) {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      sent: false,
      reason: "mobile_on_dnc",
    });
    return { success: true, message: "Got it — I've made a note." };
  }

  // Send the campaign's FIXED SMS template. No template → nothing to send:
  // tell the agent plainly (success:false) and surface the gap once an hour
  // per campaign, mirroring send_email.
  const live = process.env.ELEVENLABS_LIVE === "live";
  const tmpl = await resolveCampaignSmsTemplate(ctx.supabase, ctx.campaignId);
  if (!tmpl) {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      template_id: null,
      sent: false,
      reason: "no_template_on_campaign",
    });
    if (live) {
      await logToolNotConfigured(ctx.supabase, {
        kind: "tool_text_not_configured",
        campaignId: ctx.campaignId,
        callId: ctx.callId,
        tool: "send_text",
        reason: "no_template_on_campaign",
      });
    }
    return {
      success: false,
      message: textNotSentMessage("no_template_on_campaign"),
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

  const sentMessage =
    "Done — I've texted that to you. You should see it shortly.";

  // Live: deliver via Close from the number read from the owner's Close
  // account (syncCloseSmsNumbers picks it; the Close card lets them choose).
  // We only claim "sent" on real success; otherwise we record the intent, no
  // fake row.
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
    // Nothing stored yet (connected before numbers were read from Close, or
    // that read failed): ask Close once now and persist the answer, so this
    // text still goes out and the next call skips the round-trip.
    if (closeKey && !fromNumber) {
      const synced = await syncCloseSmsNumbers(ctx.supabase, {
        userId: ctx.lead.owner_id,
        apiKey: closeKey,
        current: null,
      });
      if (synced.ok) fromNumber = synced.fromNumber;
    }
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

  // Honesty rule: never tell the lead we texted when we couldn't. The agent is
  // told it did NOT go out (success:false) with the real reason — "no texting
  // number is set up in Close", not "I've noted to text that". A missing Close
  // connection or texting number is a configuration gap, surfaced once an hour
  // per campaign.
  if (plan.action === "note_only") {
    await logToolEvent(ctx, "tool_send_text", {
      mobile,
      note,
      template_id: tmpl.id,
      sent: false,
      reason: plan.reason,
    });
    if (
      plan.reason === "owner_close_not_connected" ||
      plan.reason === "no_sms_from_number"
    ) {
      await logToolNotConfigured(ctx.supabase, {
        kind: "tool_text_not_configured",
        campaignId: ctx.campaignId,
        callId: ctx.callId,
        tool: "send_text",
        reason: plan.reason,
      });
    }
    return { success: false, message: textNotSentMessage(plan.reason) };
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
  // A DELAY the agent captured as minutes wins outright: it carries no time
  // zone, so unlike a clock time there is no frame to get wrong. The model
  // writes relative requests on ElevenLabs' own Eastern clock even when it was
  // handed the lead's zone and local time correctly, and re-reading that clock
  // in the lead's zone booked "in an hour" three hours late for a Los Angeles
  // lead. Counting minutes from now sidesteps the whole question.
  //
  // Otherwise the clock time is read in the LEAD's timezone and any offset the
  // model attached is ignored: it stamps -04:00 on every lead, so "10:00-04:00"
  // for a Honolulu spa used to mean 4 AM there. 10:00 means 10:00 where they
  // are. The one exception is a reading that lands in the past, which the model
  // never intends — there the stamped offset is what it meant (see
  // resolveCallbackDatetime), and without it "call me in 20 minutes" from an
  // Atlantic lead was refused as already passed.
  const relative = relativeCallbackInstant(body.callback_relative_minutes);
  const when = relative ?? resolveCallbackDatetime(raw, ctx.lead.timezone);
  // No `!raw` check: a minute count on its own is a complete answer, and
  // refusing it because the model skipped the datetime would throw away the
  // one reading we can trust.
  if (!when || Number.isNaN(when.getTime())) {
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
  // A time that is real but only moments away is held to the floor: callbacks
  // bypass the throughput caps, so "in one minute" would have the dialer ring
  // the number we are still hanging up on. No need to re-ask the lead over a
  // few minutes — the agent's "I'll give you a shout shortly" still holds.
  const scheduledAt = clampCallbackToFloor(when).toISOString();

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
    // What the model sent, so an audit can see when its offset disagreed
    // with the lead's zone.
    model_datetime: raw,
    // The relative delay, when the model gave one, plus which of the two
    // readings actually won — the pair that makes a mis-timed callback
    // diagnosable from the Activity feed alone.
    model_relative_minutes: str(body.callback_relative_minutes) || null,
    resolved_from: relative ? "relative_minutes" : "datetime",
    lead_timezone: ctx.lead.timezone,
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
  supabase: SupabaseAdmin,
  ctx: CallContext | null,
  callId: string,
  timer: ToolTimer,
): Promise<ToolWebhookResult> {
  const live = process.env.ELEVENLABS_LIVE === "live";
  // Offer the campaign owner's real Calendly openings over the next few days.
  // Generic slots are a NON-LIVE convenience only (dev/test flows): on a real
  // call with no Calendly to book into, invented times are a promise the
  // booking tool can't keep, so the agent is told to decline instead.
  if (ctx) {
    const cal = await timer.time("context", () =>
      resolveCampaignCalendly(ctx.supabase, ctx.campaignId),
    );
    const plan = planBookingTool({
      live,
      hasToken: Boolean(cal),
      hasEventType: Boolean(cal?.eventTypeUri),
    });
    // Calendly is connected but this campaign has no event chosen → booking is
    // intentionally off; don't offer times.
    if (plan === "disabled") {
      return {
        success: false,
        message: "Scheduling isn't enabled for this campaign.",
      };
    }
    if (plan === "not_configured") {
      await logBookingNotConfigured(ctx.supabase, {
        campaignId: ctx.campaignId,
        callId: ctx.callId,
        tool: "get_available_times",
        reason: "owner_calendly_not_connected",
      });
      return {
        success: false,
        message: BOOKING_NOT_CONFIGURED_MESSAGE.get_available_times,
      };
    }
    if (plan === "live" && cal?.eventTypeUri) {
      const eventTypeUri = cal.eventTypeUri;
      // ONE short window (OFFER_LOOKAHEAD_DAYS, applied inside the copy
      // refresh — see calendly/copy-store). The daily webinar runs
      // every weekday and its Calendly event only books a few days out, so the
      // agent gets EVERY open session in that range in a single call — a
      // handful of lines it can answer "does Thursday work?" from on the spot,
      // instead of the first three openings of a six-week scan plus a second
      // round-trip (dead air on the phone) for any day the owner names.
      const now = Date.now();
      // Answer from our copy of Calendly's openings when it is fresh enough —
      // asking Calendly here costs 1.0-1.4s of silence with the caller on the
      // line. The dialer keeps the copy warm while it is placing calls; when
      // to trust it (and when to fetch live anyway) is decided in
      // calendly/copy-rules.
      const offer = await timer.time("calendly_availability", () =>
        resolveOfferableSlots(
          ctx.supabase,
          {
            eventTypeId: cal.eventTypeId ?? "",
            eventTypeUri,
            token: cal.token,
            slots: cal.availabilitySlots,
            fetchedAt: cal.availabilityFetchedAt,
          },
          now,
          afterResponse,
        ),
      );
      const slots: OfferedSlot[] = offer.slots
        .slice(0, MAX_OFFERED_SLOTS)
        .map((startTime) => ({
          slot_id: startTime,
          label: fmtSlot(startTime, ctx.lead.timezone),
          when: relativeDayLabel(startTime, now, ctx.lead.timezone),
        }));
      // A real Calendly event is attached, so offer its TRUE openings — or say
      // there are none. Never invent generic slots here: fake times contradict
      // the real date the agent quotes and produce un-bookable slot_ids (the
      // "why is it offering other times?" bug).
      if (slots.length > 0) {
        await logToolEvent(ctx, "tool_get_available_times", {
          slots: slots.length,
          source: offer.source,
          copy_age_s: offer.copyAgeS,
        });
        return {
          success: true,
          message:
            "Open sessions over the next few days, soonest first, times already in the lead's local time; `when` is how to say the day (today / tomorrow / the weekday). Offer up to three, soonest first, with their local times, in ONE question, then confirm the one they pick with its date. Never mention a day that is not in this list.",
          slots,
        };
      }
      await logToolEvent(ctx, "tool_get_available_times", {
        slots: 0,
        source: offer.source,
        copy_age_s: offer.copyAgeS,
      });
      return {
        success: false,
        message:
          "No open sessions over the next few days. Don't invent a time — offer to check back another day instead.",
      };
    }
  }
  // Live with no resolved call: we can't tell whose Calendly to read, so there
  // is nothing real to offer. Never hand out slots that can't be booked.
  if (!ctx && live) {
    await logBookingNotConfigured(supabase, {
      campaignId: null,
      callId: callId || null,
      tool: "get_available_times",
      reason: "unresolved_call",
    });
    return {
      success: false,
      message:
        "I couldn't find the right record for this call, so I can't offer times right now. Don't invent a time — offer to have the team follow up instead.",
    };
  }
  // Only reached off-live: no resolved call, or an owner who hasn't connected
  // Calendly at all → generic demo/mock slots keep the conversation moving.
  return genericAvailableTimes(ctx?.lead.timezone);
}

/** Three generic weekday slots at 10am / 2pm in the LEAD's local timezone, used
 *  in mock (non-live) mode only — a live call with no Calendly declines instead
 *  (see planBookingTool). Built with
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
// book_appointment (live Calendly when configured; mock only off-live)
// ---------------------------------------------------------------------------
async function bookAppointment(
  ctx: CallContext,
  body: Record<string, unknown>,
): Promise<ToolWebhookResult> {
  let slotId = str(body.slot_id);
  // Whether the AGENT picked this slot (vs. the fixed-time path below, where
  // the server resolves it and the day guard must not apply).
  const agentPickedSlot = Boolean(slotId);
  const agreedDay = str(body.agreed_day);
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

  // The number for the host's Calendly "Phone Number" question: the cell the
  // person booking gave on this call, otherwise the lead's business number
  // (Marija, 2026-09-10). A host automation texts that field.
  const rawMobile = str(body.mobile);
  const bookingPhone = pickBookingPhone({
    mobile: rawMobile,
    businessPhone: ctx.lead.business_phone,
  });
  // Folded into every live-booking audit event, so how often a cell is given
  // (and how often one is misheard, unusable or replaces another) can be read
  // from system_events.
  const phoneAudit = bookingPhoneAudit({
    bookingPhone,
    rawMobile,
    leadMobilePhone: ctx.lead.mobile_phone,
  });

  // Resolve the campaign's Calendly BEFORE the slot check: a fixed-time event
  // supplies its own time, so we need to know that before deciding a missing
  // slot_id is a problem.
  const cal = await ctx.timer.time("context", () =>
    resolveCampaignCalendly(ctx.supabase, ctx.campaignId),
  );
  const plan = planBookingTool({
    live: process.env.ELEVENLABS_LIVE === "live",
    hasToken: Boolean(cal),
    hasEventType: Boolean(cal?.eventTypeUri),
  });

  // Calendly is connected but this campaign has no event chosen → booking is
  // intentionally off. Decline instead of faking a confirmation.
  if (plan === "disabled") {
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

  // LIVE call, owner never connected Calendly. The old code took the mock
  // branch here and told a real lead "Booked: Tuesday at 2" with nothing behind
  // it. Refuse honestly, and flag the campaign so someone connects Calendly.
  if (plan === "not_configured") {
    await logBookingNotConfigured(ctx.supabase, {
      campaignId: ctx.campaignId,
      callId: ctx.callId,
      tool: "book_appointment",
      reason: "owner_calendly_not_connected",
    });
    await logToolEvent(ctx, "tool_book_appointment", {
      slot_id: slotId,
      email,
      not_configured: true,
    });
    return {
      success: false,
      message: BOOKING_NOT_CONFIGURED_MESSAGE.book_appointment,
    };
  }

  // Fixed-time event (webinar): one known session, so the agent books with just
  // name + email and never calls get_available_times. Resolve the event's
  // soonest opening ourselves rather than making the model invent a slot_id it
  // was never given.
  if (!slotId && cal?.eventTypeUri && cal.fixedTimeBooking) {
    const eventTypeUri = cal.eventTypeUri;
    // The copy already holds the next week of openings, and a fixed-time
    // event's session is the first of them — but only a copy fresh enough to
    // book from (see soonestFromCopy). Otherwise scan Calendly live.
    const soonest =
      soonestFromCopy(
        cal.availabilitySlots,
        cal.availabilityFetchedAt,
        Date.now(),
      ) ??
      (await ctx.timer.time("calendly_availability", () =>
        soonestCalendlyOpening(eventTypeUri, cal.token),
      ));
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

  // Agreed-day guard. On 2026-09-03 (Pamper Me Skin Care) the lead said
  // "Tuesday", the agent's get_available_times list only held TODAY's slot
  // (Thursday 2 PM ET), and the agent booked it anyway — then told the lead
  // "Tuesday at 2". The server couldn't catch it because the tool never learned
  // which day the lead agreed to. Now the agent must pass `agreed_day`, and a
  // slot on a different day is refused. Only applies when the agent picked the
  // slot (never on the fixed-time path, where we resolved it ourselves).
  // "unrecognized" (or a missing agreed_day) FAILS OPEN: the ElevenLabs tool
  // definition may still be the old one without the parameter, and a vague
  // phrase must not stop real bookings — it's logged instead.
  const dayCheck =
    agentPickedSlot && !Number.isNaN(when.getTime())
      ? agreedDayMatchesSlot(agreedDay, slotId, Date.now(), ctx.lead.timezone)
      : null;
  if (dayCheck?.verdict === "mismatch") {
    await logToolEvent(ctx, "tool_book_appointment", {
      slot_id: slotId,
      email,
      agreed_day: agreedDay,
      slot_day: dayCheck.slotDay,
      day_mismatch: true,
    });
    return {
      success: false,
      message: `NOT booked. The lead agreed to ${agreedDay}, but that slot is ${label} (${dayCheck.slotDay}). Never book a day the lead didn't agree to. If ${agreedDay} is in your get_available_times list, pass THAT slot's slot_id. If it isn't, it's not open: tell them, then take the callback path (ask when to check back and call smiledial_schedule_callback).`,
    };
  }
  // Folded into every success-path audit log below so an unrecognized (or
  // absent) agreed_day is visible without blocking the booking.
  const agreedDayAudit = !dayCheck
    ? {}
    : dayCheck.verdict === "match"
      ? { agreed_day: agreedDay }
      : { agreed_day: agreedDay || null, agreed_day_unrecognized: true };

  // Live: book the slot directly on the campaign owner's Calendly.
  if (cal?.eventTypeUri) {
    const eventTypeUri = cal.eventTypeUri;
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

    // Keep a cell the person booking gave on the lead itself (best-effort, as
    // send_text does): an inbound call or text reply from that number then
    // finds this lead, and it survives a booking that fails below.
    let mobileSaveFailed = false;
    if (
      bookingPhone.source === "mobile" &&
      bookingPhone.phone !== ctx.lead.mobile_phone
    ) {
      const { error: mobileSaveError } = await ctx.supabase
        .from("leads")
        .update({ mobile_phone: bookingPhone.phone })
        .eq("id", ctx.lead.id);
      // The save doesn't change what Calendly gets — bookingPhone.phone was
      // already decided above — but phone_source: "mobile" is logged below as
      // if this save landed, so a silent failure here would misreport the
      // lead as holding a cell it never got.
      if (mobileSaveError) mobileSaveFailed = true;
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
        ...agreedDayAudit,
        ...phoneAudit,
        ...(mobileSaveFailed ? { mobile_save_failed: true } : {}),
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
    const eventConfig = await ctx.timer.time("calendly_config", () =>
      getEventTypeConfig(eventTypeUri, cal.token),
    );
    const location = buildInviteeLocation(eventConfig.locations);
    const questionsAndAnswers = buildQuestionsAndAnswers(
      eventConfig.customQuestions,
      {
        company: ctx.lead.company,
        name,
        email,
        // A REQUIRED question can't be skipped, so it falls back to the raw
        // business number (unvalidated) rather than pickBookingPhone's null —
        // otherwise an unusable business phone would leave this blank, and
        // buildQuestionsAndAnswers would answer with the COMPANY NAME, which
        // Calendly would reject.
        phone: requiredQuestionPhone(bookingPhone, ctx.lead),
      },
    );
    // Do-not-call lookup for the booking phone, on the lead OWNER's list (DNC
    // is per person). A failed lookup is "unknown", never "clear": an
    // unreadable list must not read as "not on DNC". limit(1), not
    // maybeSingle(), as in send_text: maybeSingle() errors on two rows.
    let dncLookup: DncLookup | null = null;
    if (bookingPhone.phone && ctx.lead.status !== "dnc") {
      const { data: dncHits, error: dncError } = await ctx.supabase
        .from("dnc_entries")
        .select("phone")
        .eq("phone", bookingPhone.phone)
        .eq("owner_id", ctx.lead.owner_id)
        .limit(1);
      dncLookup = dncError
        ? "unknown"
        : (dncHits?.length ?? 0) > 0
          ? "listed"
          : "clear";
    }
    // The host's OPTIONAL phone question, filled on purpose so the host's
    // reminder texts have a number, unless the do-not-call rule drops it (the
    // booking still goes through). createInvitee drops it too if Calendly
    // objects.
    const phoneOutcome = bookingPhoneOutcome({
      bookingPhone,
      optionalAnswer: buildOptionalPhoneAnswer(
        eventConfig.customQuestions,
        bookingPhone.phone,
      ),
      questions: eventConfig.customQuestions,
      leadIsDnc: ctx.lead.status === "dnc",
      dncLookup,
    });
    // UTM attribution so booked appointments are traceable to Smile & Dial in
    // Calendly's reporting (utm_source=smile_dial, utm_medium=voice, campaign
    // per bookingTracking). Surfaces on the invitee + the post-call webhook.
    const tracking = bookingTracking({
      campaignId: ctx.campaignId,
      campaignName: cal.campaignName,
      leadId: ctx.lead.id,
      bookingUtmCampaign: cal.bookingUtmCampaign,
    });
    const result = await ctx.timer.time("calendly_booking", () =>
      createInvitee(
        {
          eventTypeUri,
          startTime: when.toISOString(),
          email,
          name: name || undefined,
          timezone: ctx.lead.timezone || "America/New_York",
          location,
          tracking,
          questionsAndAnswers,
          optionalQuestionsAndAnswers: phoneOutcome.optionalAnswer
            ? [phoneOutcome.optionalAnswer]
            : undefined,
        },
        cal.token,
      ),
    );
    if (!result.ok) {
      await logToolEvent(ctx, "tool_book_appointment", {
        slot_id: slotId,
        email,
        live: true,
        error: result.error,
        ...phoneAudit,
        ...phoneOutcome.audit,
        ...(result.droppedOptionalAnswers ? { phone_dropped: true } : {}),
        ...(mobileSaveFailed ? { mobile_save_failed: true } : {}),
      });
      // Only a genuine availability clash should send the AI back to pick
      // another time. Every OTHER failure is a config problem on the host's
      // Calendly (a required question, a bad location, a revoked token) that
      // re-picking cannot fix — the old blanket "that time just became
      // unavailable" made the AI re-offer the SAME slot over and over and let a
      // full-day, 100%-failure outage pass as ordinary bad luck. Say something
      // true instead, and bank the email so the lead isn't lost.
      const slotGone = isSlotGoneError(result.error);
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
        // The booking happens DURING the call, so today's ET day is the dial
        // day whose spend produced it. Stored rather than derived from
        // created_at because a later reschedule creates the row on the day of
        // the reschedule, which would silently re-date the cohort and move the
        // credit to a day that paid for nothing. See the cohort design doc.
        dial_day: etDayString(),
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
      ...agreedDayAudit,
      ...phoneAudit,
      ...phoneOutcome.audit,
      ...(result.droppedOptionalAnswers ? { phone_dropped: true } : {}),
      ...(mobileSaveFailed ? { mobile_save_failed: true } : {}),
    });
    return {
      success: true,
      message: `Booked: ${label}, invite going to ${email}. ${AFTER_BOOKING_NEXT_STEP}`,
    };
  }

  // Mock — NON-LIVE only (planBookingTool routed a live call without Calendly
  // to the honest refusal above): record the intent and confirm so dev/test
  // conversations complete.
  await logToolEvent(ctx, "tool_book_appointment", {
    slot_id: slotId,
    email,
    name,
    ...agreedDayAudit,
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

  // Onto the lead OWNER's list, which is also the only list that stops this
  // lead being dialled again (DNC is per person, 20260906020000) — so the
  // owner here is load-bearing, not just attribution. Conflict on
  // (owner_id, phone) = already on their list, which is fine — the goal is
  // met either way.
  const { error } = await ctx.supabase.from("dnc_entries").upsert(
    {
      phone,
      owner_id: ctx.lead.owner_id,
      company_snapshot: ctx.lead.company,
      reason: "dnc_requested",
      // No user session in a webhook; attribute to the lead's owner.
      added_by_user_id: ctx.lead.owner_id,
      source_call_id: ctx.callId,
    },
    { onConflict: "owner_id,phone", ignoreDuplicates: true },
  );
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

/** Add an in-call OpenAI spend (the live research) to the call's
 *  cost_breakdown.openai and recompute the stored total. Read-merge-write on
 *  the current row: the post-call webhook, which lands later, carries any
 *  prior `openai` forward. Best-effort. */
async function addOpenAiCostToCall(
  ctx: CallContext,
  cost: number,
): Promise<void> {
  if (!(cost > 0)) return;
  const { data: row } = await ctx.supabase
    .from("calls")
    .select("cost_breakdown")
    .eq("id", ctx.callId)
    .maybeSingle();
  const prev = ((row?.cost_breakdown ?? {}) as Record<string, unknown>) ?? {};
  const next = withRecomputedTotal({
    ...prev,
    openai: Number((numField(prev, "openai") + cost).toFixed(4)),
  });
  await ctx.supabase
    .from("calls")
    .update({
      cost_breakdown:
        next as unknown as Database["public"]["Tables"]["calls"]["Update"]["cost_breakdown"],
    })
    .eq("id", ctx.callId);
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

  const { brief, usage } = await researchBusinessWithUsage({
    company: ctx.lead.company,
    city: ctx.lead.city,
    state: ctx.lead.state,
    website: ctx.lead.website,
    bookingSoftware: await resolveBookingSoftware(ctx),
    heardOnCall: str(body.heard_on_call) || null,
  });

  // Book the research spend: to the ledger (so the Costs page lists it under
  // "Other AI usage") AND onto this call's cost_breakdown.openai, so the
  // call's own cost includes the research it triggered. Best-effort — the
  // caller is on the phone.
  if (usage && usage.cost > 0) {
    await recordAiCharge(ctx.supabase, {
      ownerId: ctx.lead.owner_id,
      kind: "business_research",
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
      refTable: "calls",
      refId: ctx.callId,
      detail: { web_search_calls: usage.webSearchCalls, found: brief.found },
    });
    await addOpenAiCostToCall(ctx, usage.cost);
  }

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
