import { Megaphone, Phone } from "lucide-react";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { CampaignBoard, type CampaignCardItem } from "./campaign-board";
import { AutopilotToggle } from "./autopilot-toggle";
import {
  attentionRail,
  CampaignStatusBadge,
  DialingNowChip,
  HoursLabel,
  ListsBadge,
  ManualOnlyChip,
  OutsideHoursChip,
  SpendCapBar,
} from "./campaign-cells";
import { CampaignNameTrigger } from "./campaign-name-trigger";
import { CampaignRowActions } from "./campaign-row-actions";
import {
  CampaignSettingsDialog,
  type CampaignData,
} from "./campaign-settings-dialog";
import { CampaignViewToggle } from "./campaign-view-toggle";
import {
  CampaignsStatusTabs,
  type CampaignCounts,
} from "./campaigns-status-tabs";
import { CampaignsStatStrip } from "./campaigns-stat-strip";
import { DeleteCampaignDialog } from "./delete-campaign-dialog";
import { isCampaignInsideHours } from "./format-hours";
import { fetchCampaignStats, fetchPerCampaignSpend } from "./stats-query";

type Option = { id: string; name: string };

const STATUS_VALUES = new Set(["active", "paused", "draft", "ended", "all"]);

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; view?: string }>;
}) {
  const params = await searchParams;
  const statusFilter = STATUS_VALUES.has(str(params.status))
    ? str(params.status)
    : "active";
  // Board is the default lens — it reads like a live operations board.
  // ?view=table opts into the dense sortable columns.
  const view: "table" | "board" =
    str(params.view) === "table" ? "table" : "board";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const now = new Date();
  const [
    { data: rawCampaigns },
    { data: agentsRaw },
    { data: goalsRaw },
    { data: rawNumbers },
    { data: kbsRaw },
    { data: rawLists },
    { data: rawCalendlyEvents },
    { data: rawEmailTemplates },
    { data: rawAttachments },
    { data: rawSmartLists },
    stats,
    perCampaignSpend,
  ] = await Promise.all([
    // Note: phone numbers are looked up via the separate `rawNumbers`
    // query below, then folded into the row via twilio_number_id.
    // Joining twilio_numbers into the campaigns select breaks the
    // query — PostgREST doesn't have the FK relationship configured.
    supabase
      .from("campaigns")
      .select(
        "id, name, description, status, agent_id, goal_id, twilio_number_id, calling_hours_start, calling_hours_end, calls_per_hour_cap, calls_per_day_cap, concurrency_cap_per_user, dial_interval_seconds, transfer_destination_phone, daily_spend_cap, monthly_spend_cap, autopilot_enabled, smart_scheduling, calendly_event_id, email_template_id, audience_search, smart_list_id, inbound_greeting, created_at, agent:agents(name), goal:goals(name)",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("agents")
      .select("id, name, knowledge_base_ids")
      .order("name"),
    supabase.from("goals").select("id, name").order("name"),
    supabase
      .from("twilio_numbers")
      .select("id, phone_number, friendly_name, attached_campaign_id")
      .is("released_at", null)
      .order("phone_number"),
    supabase.from("knowledge_bases").select("id, name"),
    supabase.from("lists").select("id, name").order("name"),
    // The signed-in user's synced Calendly events — options for the
    // per-campaign "Booking" event selector.
    supabase
      .from("calendly_event_types")
      .select("id, name")
      .eq("owner_id", user.id)
      .eq("active", true)
      .order("name"),
    // The signed-in user's email templates — options for the per-campaign
    // send_email template selector.
    supabase
      .from("email_templates")
      .select("id, name")
      .eq("owner_id", user.id)
      .order("name"),
    supabase
      .from("list_campaign_attachments")
      .select("list_id, campaign_id")
      .is("detached_at", null),
    supabase.from("smart_lists").select("id, name").order("name"),
    fetchCampaignStats(supabase),
    fetchPerCampaignSpend(supabase),
  ]);

  const agentOptions: Option[] = (agentsRaw ?? []).map((a) => ({
    id: a.id,
    name: a.name,
  }));
  const goalOptions: Option[] = (goalsRaw ?? []).map((g) => ({
    id: g.id,
    name: g.name,
  }));
  const smartListOptions: Option[] = (rawSmartLists ?? []).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  const kbName = new Map<string, string>();
  (kbsRaw ?? []).forEach((k) => kbName.set(k.id, k.name));
  const kbsByAgent: Record<string, Option[]> = {};
  (agentsRaw ?? []).forEach((a) => {
    const ids = (a.knowledge_base_ids ?? []) as string[];
    kbsByAgent[a.id] = ids
      .map((id) => (kbName.has(id) ? { id, name: kbName.get(id)! } : null))
      .filter((x): x is Option => x !== null);
  });

  const allLists: Option[] = (rawLists ?? []).map((l) => ({
    id: l.id,
    name: l.name,
  }));
  const attachments = rawAttachments ?? [];
  const campaignToListIds = new Map<string, string[]>();
  attachments.forEach((row) => {
    const existing = campaignToListIds.get(row.campaign_id) ?? [];
    campaignToListIds.set(row.campaign_id, [...existing, row.list_id]);
  });
  const attachedListIds = new Set(attachments.map((a) => a.list_id));

  // Distinct lead timezones per attached list, so each campaign's "are we
  // calling now?" chip is evaluated in its leads' timezones (the dialer gates
  // per lead the same way) instead of the server's UTC clock.
  const listTimezones = new Map<string, Set<string>>();
  if (attachedListIds.size > 0) {
    const { data: tzRows } = await supabase
      .from("leads")
      .select("list_id, timezone")
      .is("deleted_at", null)
      .not("timezone", "is", null)
      .in("list_id", [...attachedListIds])
      .limit(50000);
    for (const r of tzRows ?? []) {
      const row = r as { list_id: string | null; timezone: string | null };
      if (!row.list_id || !row.timezone) continue;
      const set = listTimezones.get(row.list_id) ?? new Set<string>();
      set.add(row.timezone);
      listTimezones.set(row.list_id, set);
    }
  }
  function timezonesForCampaign(campaignId: string): string[] {
    const zones = new Set<string>();
    for (const listId of campaignToListIds.get(campaignId) ?? []) {
      for (const tz of listTimezones.get(listId) ?? []) zones.add(tz);
    }
    return [...zones];
  }

  function eligibleListsFor(campaignId: string | null): Option[] {
    const result = allLists.filter((l) => !attachedListIds.has(l.id));
    if (campaignId) {
      const own = campaignToListIds.get(campaignId) ?? [];
      const ownLists = allLists.filter(
        (l) => own.includes(l.id) && !result.find((r) => r.id === l.id),
      );
      result.push(...ownLists);
    }
    return result;
  }

  const allNumbers = rawNumbers ?? [];
  const unattachedNumbers = allNumbers.filter((n) => !n.attached_campaign_id);
  function numbersForCampaign(twilioNumberId: string | null) {
    const list = unattachedNumbers.map((n) => ({
      id: n.id,
      phone_number: n.phone_number,
      friendly_name: n.friendly_name,
    }));
    if (twilioNumberId) {
      const current = allNumbers.find((n) => n.id === twilioNumberId);
      if (current && !list.find((n) => n.id === current.id)) {
        list.push({
          id: current.id,
          phone_number: current.phone_number,
          friendly_name: current.friendly_name,
        });
      }
    }
    return list;
  }

  // Look up phone number per campaign via the rawNumbers query.
  const phoneByNumberId = new Map<string, string>();
  for (const n of allNumbers) {
    phoneByNumberId.set(n.id, n.phone_number);
  }
  const allCampaigns = (rawCampaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    agent_id: c.agent_id,
    goal_id: c.goal_id,
    twilio_number_id: c.twilio_number_id,
    twilio_phone: c.twilio_number_id
      ? (phoneByNumberId.get(c.twilio_number_id) ?? null)
      : null,
    calling_hours_start: c.calling_hours_start,
    calling_hours_end: c.calling_hours_end,
    calls_per_hour_cap: c.calls_per_hour_cap,
    calls_per_day_cap: c.calls_per_day_cap,
    concurrency_cap_per_user: c.concurrency_cap_per_user,
    dial_interval_seconds: c.dial_interval_seconds,
    transfer_destination_phone: c.transfer_destination_phone,
    daily_spend_cap: c.daily_spend_cap,
    monthly_spend_cap: c.monthly_spend_cap,
    autopilot_enabled: c.autopilot_enabled ?? true,
    smart_scheduling:
      (c as { smart_scheduling?: boolean }).smart_scheduling ?? false,
    calendly_event_id: c.calendly_event_id ?? null,
    email_template_id: c.email_template_id ?? null,
    audience_search: c.audience_search ?? null,
    smart_list_id: c.smart_list_id ?? null,
    inbound_greeting: c.inbound_greeting ?? null,
    created_at: c.created_at,
    agent_name: c.agent?.name ?? "—",
    goal_name: c.goal?.name ?? "—",
  }));

  const calendlyEventOptions: Option[] = (rawCalendlyEvents ?? []).map((e) => ({
    id: e.id,
    name: e.name,
  }));
  const emailTemplateOptions: Option[] = (rawEmailTemplates ?? []).map((t) => ({
    id: t.id,
    name: t.name,
  }));

  // Tab counts off all campaigns, not the current filter — same pattern
  // as Callbacks / Goals so the badges always tell the same story.
  const tabCounts: CampaignCounts = {
    active: 0,
    paused: 0,
    draft: 0,
    ended: 0,
    all: allCampaigns.length,
  };
  for (const c of allCampaigns) {
    if (tabCounts[c.status] != null) tabCounts[c.status]++;
  }

  const campaigns = allCampaigns.filter((c) =>
    statusFilter === "all" ? true : c.status === statusFilter,
  );

  // Build the view model once — the table and the board both render
  // from this, so the live signals stay identical across views.
  const viewModels: CampaignCardItem[] = campaigns.map((campaign) => {
    const data: CampaignData = {
      id: campaign.id,
      name: campaign.name,
      description: campaign.description,
      agent_id: campaign.agent_id,
      goal_id: campaign.goal_id,
      twilio_number_id: campaign.twilio_number_id,
      calling_hours_start: campaign.calling_hours_start,
      calling_hours_end: campaign.calling_hours_end,
      calls_per_hour_cap: campaign.calls_per_hour_cap,
      calls_per_day_cap: campaign.calls_per_day_cap,
      concurrency_cap_per_user: campaign.concurrency_cap_per_user,
      dial_interval_seconds: campaign.dial_interval_seconds,
      transfer_destination_phone: campaign.transfer_destination_phone,
      daily_spend_cap: campaign.daily_spend_cap,
      monthly_spend_cap: campaign.monthly_spend_cap,
      autopilot_enabled: campaign.autopilot_enabled,
      smart_scheduling: campaign.smart_scheduling,
      calendly_event_id: campaign.calendly_event_id,
      email_template_id: campaign.email_template_id,
      audience_search: campaign.audience_search,
      smart_list_id: campaign.smart_list_id,
      inbound_greeting: campaign.inbound_greeting,
    };
    const today = perCampaignSpend.get(campaign.id);
    return {
      data,
      status: campaign.status,
      agentName: campaign.agent_name,
      goalName: campaign.goal_name,
      twilioPhone: campaign.twilio_phone,
      description: campaign.description,
      listCount: (campaignToListIds.get(campaign.id) ?? []).length,
      callsToday: today?.callsToday ?? 0,
      spendToday: today?.spendToday ?? 0,
      dailyCap: campaign.daily_spend_cap,
      insideHours: isCampaignInsideHours(
        campaign.calling_hours_start,
        campaign.calling_hours_end,
        timezonesForCampaign(campaign.id),
        now,
      ),
      isActive: campaign.status === "active",
      autopilotEnabled: campaign.autopilot_enabled,
      callingHoursStart: campaign.calling_hours_start,
      callingHoursEnd: campaign.calling_hours_end,
      twilioNumbers: numbersForCampaign(campaign.twilio_number_id),
      eligibleLists: eligibleListsFor(campaign.id),
      currentListIds: campaignToListIds.get(campaign.id) ?? [],
    };
  });

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex items-start justify-between gap-4 delay-75 duration-500">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Campaigns
          </h1>
          <p className="text-muted-foreground text-sm">
            Each campaign ties leads to an agent, a goal, a Twilio number, and
            calling caps. Pause anytime; ended is permanent.
          </p>
        </div>
        <CampaignSettingsDialog
          mode="create"
          agents={agentOptions}
          goals={goalOptions}
          twilioNumbers={numbersForCampaign(null)}
          kbsByAgent={kbsByAgent}
          eligibleLists={eligibleListsFor(null)}
          currentListIds={[]}
          smartLists={smartListOptions}
          calendlyEvents={calendlyEventOptions}
          emailTemplates={emailTemplateOptions}
        />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both delay-100 duration-500">
        <CampaignsStatStrip stats={stats} />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-wrap items-center gap-2 delay-150 duration-500">
        <CampaignsStatusTabs current={statusFilter} counts={tabCounts} />
        <div className="flex-1" />
        <CampaignViewToggle current={view} />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both delay-200 duration-500">
        {campaigns.length === 0 ? (
          <EmptyState filtered={allCampaigns.length > 0} />
        ) : view === "board" ? (
          <CampaignBoard
            campaigns={viewModels}
            agents={agentOptions}
            goals={goalOptions}
            kbsByAgent={kbsByAgent}
            smartLists={smartListOptions}
            calendlyEvents={calendlyEventOptions}
            emailTemplates={emailTemplateOptions}
          />
        ) : (
          <div className="border-border overflow-x-auto rounded-2xl border shadow-sm">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[28%] min-w-[240px]">
                    Campaign
                  </TableHead>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead className="w-[150px]">Agent</TableHead>
                  <TableHead className="w-[130px]">Goal</TableHead>
                  <TableHead className="w-[80px]">Lists</TableHead>
                  <TableHead className="w-[120px]">Hours</TableHead>
                  <TableHead className="w-[110px]">Calls today</TableHead>
                  <TableHead className="w-[160px]">Spend today</TableHead>
                  <TableHead
                    className="bg-background sticky right-0 z-10 w-[280px] shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)]"
                    aria-label="Row actions"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewModels.map((c) => {
                  const rail = attentionRail({
                    isActive: c.isActive,
                    insideHours: c.insideHours,
                    listCount: c.listCount,
                  });
                  return (
                    <TableRow key={c.data.id} className="group">
                      {/* Primary cell — campaign name is a Settings
                          trigger. Phone + description fold onto the
                          second line. Left rail flags rows needing a
                          look. */}
                      <TableCell
                        className={`w-[28%] min-w-[240px] border-l-[3px] ${rail}`}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <CampaignNameTrigger
                            name={c.data.name}
                            campaign={c.data}
                            agents={agentOptions}
                            goals={goalOptions}
                            twilioNumbers={c.twilioNumbers}
                            kbsByAgent={kbsByAgent}
                            eligibleLists={c.eligibleLists}
                            currentListIds={c.currentListIds}
                            smartLists={smartListOptions}
                            calendlyEvents={calendlyEventOptions}
                            emailTemplates={emailTemplateOptions}
                          />
                          {c.twilioPhone || c.description ? (
                            <span className="text-muted-foreground truncate text-[11px]">
                              {c.twilioPhone ? (
                                <span className="font-mono">
                                  {c.twilioPhone}
                                </span>
                              ) : null}
                              {c.twilioPhone && c.description ? " · " : ""}
                              {c.description ?? ""}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="w-[120px]">
                        <div className="flex flex-col items-start gap-1">
                          <CampaignStatusBadge status={c.status} />
                          {c.isActive && c.autopilotEnabled && c.insideHours ? (
                            <DialingNowChip />
                          ) : null}
                          {c.isActive && !c.autopilotEnabled ? (
                            <ManualOnlyChip />
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="text-muted-foreground w-[150px] truncate">
                        {c.agentName}
                      </TableCell>

                      <TableCell className="text-muted-foreground w-[130px] truncate">
                        {c.goalName}
                      </TableCell>

                      <TableCell className="w-[80px]">
                        <ListsBadge count={c.listCount} />
                      </TableCell>

                      <TableCell className="w-[120px]">
                        <div className="flex flex-col gap-0.5">
                          <HoursLabel
                            start={c.callingHoursStart}
                            end={c.callingHoursEnd}
                          />
                          {c.isActive &&
                          c.autopilotEnabled &&
                          !c.insideHours ? (
                            <OutsideHoursChip />
                          ) : null}
                        </div>
                      </TableCell>

                      <TableCell className="w-[110px]">
                        <span className="text-foreground inline-flex items-center gap-1 text-xs tabular-nums">
                          <Phone className="size-3 shrink-0" />
                          {c.callsToday.toLocaleString()}
                        </span>
                      </TableCell>

                      <TableCell className="w-[160px]">
                        <SpendCapBar spend={c.spendToday} cap={c.dailyCap} />
                      </TableCell>

                      <TableCell className="bg-background sticky right-0 z-10 w-[280px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                        <div className="ml-auto flex items-center justify-end gap-1">
                          {c.status === "active" ? (
                            <AutopilotToggle
                              campaignId={c.data.id}
                              enabled={c.autopilotEnabled}
                            />
                          ) : null}
                          <CampaignRowActions
                            campaign={{
                              id: c.data.id,
                              name: c.data.name,
                              status: c.status,
                            }}
                          />
                          <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <DeleteCampaignDialog
                              campaign={{
                                id: c.data.id,
                                name: c.data.name,
                              }}
                            />
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="border-border flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
        <Megaphone className="text-muted-foreground size-8" />
        <p className="text-foreground text-sm font-medium">
          No campaigns match this status
        </p>
        <p className="text-muted-foreground text-sm">
          Try a different tab — Active is the default.
        </p>
        <Button asChild variant="outline" size="sm">
          <a href="/campaigns?status=all">Show all campaigns</a>
        </Button>
      </div>
    );
  }
  // No-campaigns variant. Doesn't render its own New campaign dialog
  // (the header already has one); keeping a single instance per page
  // avoids strict-mode collisions in Playwright + cuts client bundle.
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
      <div className="bg-primary/10 flex size-12 items-center justify-center rounded-full">
        <Megaphone className="text-primary size-6" />
      </div>
      <p className="text-foreground text-sm font-medium">
        Put your AI callers to work
      </p>
      <p className="text-muted-foreground max-w-md text-sm">
        A campaign is what sets the AI dialing — point it at an agent, a goal,
        and the lists to call, and it works the phones for you within the hours
        and caps you set. Click{" "}
        <span className="font-medium">New campaign</span> above to launch your
        first one.
      </p>
    </div>
  );
}
