import { notFound, redirect } from "next/navigation";

import { type CustomFieldType } from "@/lib/custom-fields/actions";
import { IMPORTABLE_FIELDS } from "@/lib/leads/import-fields";
import { createClient } from "@/lib/supabase/server";

import { LeadActivityFeed, type FeedItem } from "./activity-feed";
import { LeadPageClient } from "./lead-page-client";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

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

  const meta = {
    status: lead.status,
    lastOutcome: lead.last_outcome,
    listName: lead.list?.name ?? "—",
    isInbound: lead.list?.is_inbound_default ?? false,
    retryCounter: lead.retry_counter ?? 0,
    restingUntil: lead.resting_until,
    nextCallAt: lead.next_call_at,
    aiSummary: lead.ai_summary,
  };

  return (
    <LeadPageClient
      leadId={lead.id}
      leadCompany={lead.company}
      fieldValues={fieldValues}
      customFields={customFields}
      customValues={customValues}
      meta={meta}
      availableCampaigns={availableCampaigns}
      activityFeed={<LeadActivityFeed items={feedItems} />}
    />
  );
}
