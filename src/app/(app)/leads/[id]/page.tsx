import { notFound, redirect } from "next/navigation";

import { type CustomFieldType } from "@/lib/custom-fields/actions";
import { IMPORTABLE_FIELDS } from "@/lib/leads/import-fields";
import { createClient } from "@/lib/supabase/server";

import { LeadActivityFeed, type FeedItem } from "./activity-feed";
import { LeadPageClient } from "./lead-page-client";
import { fetchLeadSiblings, str } from "../leads-query";
import { leadDetailHref, leadsHref, type SearchParams } from "../leads-url";

const UUID_RE = /^[0-9a-f-]{36}$/i;
const ALLOWED_PER = new Set([25, 50, 100]);

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const listContext = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Single round-trip fan-out: lead + custom-field defs + custom values
  // + active attached campaigns + feed sources.
  const [
    { data: lead },
    { data: defs },
    { data: customValueRows },
    { data: callRows },
    { data: emailRows },
    { data: eventRows },
    { data: activeCallRows },
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("*, list:lists(name, is_inbound_default)")
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("custom_field_defs")
      .select("id, name, type, options, sort_order")
      .order("sort_order", { ascending: true }),
    supabase
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .eq("lead_id", id),
    supabase
      .from("calls")
      .select("id, created_at, direction, outcome, duration_seconds, summary")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("emails")
      .select("id, created_at, direction, subject")
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("system_events")
      .select("id, created_at, kind, payload")
      .eq("ref_table", "leads")
      .eq("ref_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
    // Is the dialer on a call for this lead right this second? Drives the
    // live "On call now" pulse in the hero — same signal the leads list
    // surfaces, but here we also grab started_at so the hero can tick a
    // live elapsed timer.
    supabase
      .from("calls")
      .select("id, started_at, status")
      .eq("lead_id", id)
      .in("status", ["queued", "dialing", "ringing", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  if (!lead) notFound();

  // Active campaigns this lead's list is attached to — same query the
  // legacy modal used so Call Now can pick a campaign.
  const { data: campaignRows } = await supabase
    .from("list_campaign_attachments")
    .select("campaign:campaigns(id, name, status)")
    .eq("list_id", lead.list_id)
    .is("detached_at", null);
  type CampaignJoin = {
    campaign: { id: string; name: string; status: string } | null;
  };
  const availableCampaigns = ((campaignRows ?? []) as unknown as CampaignJoin[])
    .map((r) => r.campaign)
    .filter(
      (c): c is { id: string; name: string; status: string } =>
        Boolean(c) && c!.status === "active",
    )
    .map((c) => ({ id: c.id, name: c.name }));

  // Round 27 — the user's "active campaign" preference. The CallNow
  // dialog pre-selects it when it's a valid pick for this lead's list,
  // skipping the campaign picker step.
  const { data: profileWithActive } = await supabase
    .from("profiles")
    .select("active_campaign_id")
    .eq("id", user.id)
    .single();
  const activeCampaignId =
    profileWithActive?.active_campaign_id &&
    availableCampaigns.some(
      (c) => c.id === profileWithActive.active_campaign_id,
    )
      ? profileWithActive.active_campaign_id
      : undefined;

  // Flatten the lead row's importable fields into the {key: string-value}
  // map the client editor expects.
  const row = lead as Record<string, unknown>;
  const fieldValues: Record<string, string> = {};
  for (const f of IMPORTABLE_FIELDS) {
    const value = row[f.key];
    fieldValues[f.key] = value == null ? "" : String(value);
  }

  const customFields = (defs ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    type: d.type as CustomFieldType,
    options: Array.isArray(d.options)
      ? d.options.filter((o): o is string => typeof o === "string")
      : [],
  }));
  const customValues = Object.fromEntries(
    (customValueRows ?? []).map((v) => [v.custom_field_id, v.value]),
  );

  // Merge call / email / event rows into one chronological feed.
  const feedItems: FeedItem[] = [];
  for (const c of callRows ?? []) {
    feedItems.push({
      kind: "call",
      id: c.id,
      at: c.created_at,
      direction: c.direction as "inbound" | "outbound",
      outcome: c.outcome,
      duration: c.duration_seconds,
      summary: c.summary,
    });
  }
  for (const e of emailRows ?? []) {
    feedItems.push({
      kind: "email",
      id: e.id,
      at: e.created_at,
      direction: e.direction as "sent" | "received",
      subject: e.subject,
    });
  }
  for (const ev of eventRows ?? []) {
    feedItems.push({
      kind: "event",
      id: ev.id,
      at: ev.created_at,
      eventKind: ev.kind,
      payload: ev.payload as Record<string, unknown> | null,
    });
  }
  feedItems.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  const activeCall = (activeCallRows ?? [])[0] ?? null;
  const meta = {
    status: lead.status,
    lastOutcome: lead.last_outcome,
    listName: lead.list?.name ?? "—",
    isInbound: lead.list?.is_inbound_default ?? false,
    retryCounter: lead.retry_counter ?? 0,
    restingUntil: lead.resting_until,
    nextCallAt: lead.next_call_at,
    lastCallAt: lead.last_call_at ?? null,
    businessPhone: lead.business_phone ?? null,
    city: lead.city ?? null,
    state: lead.state ?? null,
    aiSummary: lead.ai_summary,
    onCall: Boolean(activeCall),
    onCallStartedAt: activeCall?.started_at ?? null,
  };

  // Lightweight projection of the feed for the "since-you-last-looked"
  // chip. Just timestamps + a short one-line description; keeps the
  // server/client payload small.
  const feedItemsForChip = feedItems.map((item) => ({
    at: item.at,
    description: describeFeedItem(item),
  }));

  // Did we arrive from the Leads list? The row links always set sort + page,
  // so their presence marks a list-originated visit. When so, walk the SAME
  // filtered/sorted view to offer prev/next + a Back link to the exact page.
  // Opened directly (notification, global search, a call) → plain Back, no
  // prev/next.
  const fromList = Boolean(str(listContext.sort) || str(listContext.page));
  let nav: {
    backHref: string;
    prevHref: string | null;
    nextHref: string | null;
    position: number;
    total: number;
    capped: boolean;
  } | null = null;
  if (fromList) {
    const perRaw = Number(str(listContext.per));
    const per = ALLOWED_PER.has(perRaw) ? perRaw : 25;
    const siblings = await fetchLeadSiblings(supabase, listContext, id);
    // Page each neighbour lives on, so Back lands on the right page after you
    // walk across a page boundary.
    const pageOf = (i: number) => String(Math.floor(i / per) + 1);
    nav = {
      backHref: leadsHref(listContext, {}),
      prevHref:
        siblings.prevId != null
          ? leadDetailHref(siblings.prevId, listContext, {
              page: pageOf(siblings.index - 1),
            })
          : null,
      nextHref:
        siblings.nextId != null
          ? leadDetailHref(siblings.nextId, listContext, {
              page: pageOf(siblings.index + 1),
            })
          : null,
      position: siblings.index >= 0 ? siblings.index + 1 : 0,
      total: siblings.total,
      capped: siblings.capped,
    };
  }

  return (
    <LeadPageClient
      leadId={lead.id}
      leadCompany={lead.company}
      fieldValues={fieldValues}
      customFields={customFields}
      customValues={customValues}
      meta={meta}
      availableCampaigns={availableCampaigns}
      activeCampaignId={activeCampaignId}
      activityFeed={<LeadActivityFeed items={feedItems} leadId={lead.id} />}
      feedItemsForChip={feedItemsForChip}
      nav={nav}
    />
  );
}

/** One-liner summary of a feed item for the since-last-viewed chip.
 *  Mirrors the activity-feed's headline strings but flattened so we
 *  can pass plain strings into a client component without dragging
 *  the FeedLine component along. */
function describeFeedItem(item: FeedItem): string {
  if (item.kind === "call") {
    const direction = item.direction === "inbound" ? "Inbound call" : "Call";
    if (item.outcome) {
      const humanized =
        item.outcome.charAt(0).toUpperCase() +
        item.outcome.slice(1).replace(/_/g, " ");
      return `${direction} · ${humanized}`;
    }
    return direction;
  }
  if (item.kind === "email") {
    return item.direction === "received" ? "Email received" : "Email sent";
  }
  // event kinds — small set the user cares about.
  switch (item.eventKind) {
    case "call_now":
      return "Manual Call Now placed";
    case "outcome_override":
      return "Outcome overridden";
    case "callback_changed":
      return "Callback rescheduled";
    case "goal_transition":
      return "Pipeline status changed";
    case "calendly_scheduled":
      return "Calendly appointment booked";
    case "close_email_received":
      return "Email reply received";
    default:
      return (
        item.eventKind.charAt(0).toUpperCase() +
        item.eventKind.slice(1).replace(/_/g, " ")
      );
  }
}
