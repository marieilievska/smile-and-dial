import { Clock, Megaphone, Phone } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
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

import { CampaignNameTrigger } from "./campaign-name-trigger";
import { CampaignRowActions } from "./campaign-row-actions";
import {
  type CampaignData,
  type TwilioOption,
} from "./campaign-settings-dialog";
import {
  CampaignsStatusTabs,
  type CampaignCounts,
} from "./campaigns-status-tabs";
import { CampaignsStatStrip } from "./campaigns-stat-strip";
import { CreateCampaignDialog } from "./create-campaign-dialog";
import { DeleteCampaignDialog } from "./delete-campaign-dialog";
import { formatCallingHours, isInsideCallingHours } from "./format-hours";
import { fetchCampaignStats, fetchPerCampaignSpend } from "./stats-query";

type Option = { id: string; name: string };

const STATUS_VALUES = new Set(["active", "paused", "draft", "ended", "all"]);

function humanize(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** Campaign lifecycle palette.
 *  - active  → success (green, dialing right now)
 *  - paused  → warning (yellow, intentionally stopped; needs attention)
 *  - draft   → secondary (grey, not running yet)
 *  - ended   → destructive (red, permanently off; audit only) */
function statusVariant(
  status: string,
): "success" | "warning" | "destructive" | "secondary" {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  if (status === "ended") return "destructive";
  return "secondary";
}

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const params = await searchParams;
  const statusFilter = STATUS_VALUES.has(str(params.status))
    ? str(params.status)
    : "active";

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
    { data: rawAttachments },
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
        "id, name, description, status, agent_id, goal_id, twilio_number_id, calling_hours_start, calling_hours_end, calls_per_hour_cap, calls_per_day_cap, concurrency_cap_per_user, transfer_destination_phone, daily_spend_cap, monthly_spend_cap, created_at, agent:agents(name), goal:goals(name)",
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
    supabase
      .from("list_campaign_attachments")
      .select("list_id, campaign_id")
      .is("detached_at", null),
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
  function numbersForCampaign(twilioNumberId: string | null): TwilioOption[] {
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
    transfer_destination_phone: c.transfer_destination_phone,
    daily_spend_cap: c.daily_spend_cap,
    monthly_spend_cap: c.monthly_spend_cap,
    created_at: c.created_at,
    agent_name: c.agent?.name ?? "—",
    goal_name: c.goal?.name ?? "—",
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

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Campaigns
          </h1>
          <p className="text-muted-foreground text-sm">
            Each campaign ties leads to an agent, a goal, a Twilio number, and
            calling caps. Pause anytime; ended is permanent.
          </p>
        </div>
        <CreateCampaignDialog
          agents={agentOptions}
          goals={goalOptions}
          eligibleLists={eligibleListsFor(null)}
        />
      </div>

      <CampaignsStatStrip stats={stats} />

      <div className="flex flex-wrap items-center gap-2">
        <CampaignsStatusTabs current={statusFilter} counts={tabCounts} />
      </div>

      {campaigns.length > 0 ? (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%] min-w-[240px]">
                  Campaign
                </TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
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
              {campaigns.map((campaign) => {
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
                  transfer_destination_phone:
                    campaign.transfer_destination_phone,
                  daily_spend_cap: campaign.daily_spend_cap,
                  monthly_spend_cap: campaign.monthly_spend_cap,
                };
                const listCount = (campaignToListIds.get(campaign.id) ?? [])
                  .length;
                const today = perCampaignSpend.get(campaign.id);
                const callsToday = today?.callsToday ?? 0;
                const spendToday = today?.spendToday ?? 0;
                const dailyCap = campaign.daily_spend_cap;
                const insideHours = isInsideCallingHours(
                  campaign.calling_hours_start,
                  campaign.calling_hours_end,
                  now,
                );
                const isActive = campaign.status === "active";
                return (
                  <TableRow key={campaign.id} className="group">
                    {/* Primary cell — campaign name is a Settings
                        trigger. Description (when present) folds onto
                        the second line as muted small text. */}
                    <TableCell className="w-[28%] min-w-[240px]">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <CampaignNameTrigger
                          name={campaign.name}
                          campaign={data}
                          agents={agentOptions}
                          goals={goalOptions}
                          twilioNumbers={numbersForCampaign(
                            campaign.twilio_number_id,
                          )}
                          kbsByAgent={kbsByAgent}
                          eligibleLists={eligibleListsFor(campaign.id)}
                          currentListIds={
                            campaignToListIds.get(campaign.id) ?? []
                          }
                        />
                        {campaign.twilio_phone || campaign.description ? (
                          <span className="text-muted-foreground truncate text-[11px]">
                            {campaign.twilio_phone ? (
                              <span className="font-mono">
                                {campaign.twilio_phone}
                              </span>
                            ) : null}
                            {campaign.twilio_phone && campaign.description
                              ? " · "
                              : ""}
                            {campaign.description ?? ""}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="w-[110px]">
                      <Badge variant={statusVariant(campaign.status)} dot>
                        {humanize(campaign.status)}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-muted-foreground w-[150px] truncate">
                      {campaign.agent_name}
                    </TableCell>

                    <TableCell className="text-muted-foreground w-[130px] truncate">
                      {campaign.goal_name}
                    </TableCell>

                    <TableCell className="w-[80px]">
                      {listCount === 0 ? (
                        <span
                          className="inline-flex items-center rounded-full bg-[color:var(--coral)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[color:var(--coral)]"
                          title="No lists attached — this campaign won't dial."
                        >
                          0 lists
                        </span>
                      ) : (
                        <span className="text-foreground text-xs tabular-nums">
                          {listCount} list{listCount === 1 ? "" : "s"}
                        </span>
                      )}
                    </TableCell>

                    <TableCell className="w-[120px]">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-foreground inline-flex items-center gap-1 text-xs">
                          <Clock className="size-3 shrink-0" />
                          {formatCallingHours(
                            campaign.calling_hours_start,
                            campaign.calling_hours_end,
                          )}
                        </span>
                        {isActive && !insideHours ? (
                          <span
                            className="text-warning text-[10px]"
                            title="Current time is outside calling hours; the dialer won't start new calls."
                          >
                            Outside hours
                          </span>
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell className="w-[110px]">
                      <span className="text-foreground inline-flex items-center gap-1 text-xs tabular-nums">
                        <Phone className="size-3 shrink-0" />
                        {callsToday.toLocaleString()}
                      </span>
                    </TableCell>

                    <TableCell className="w-[160px]">
                      <SpendCapBar spend={spendToday} cap={dailyCap} />
                    </TableCell>

                    <TableCell className="bg-background sticky right-0 z-10 w-[280px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                      <div className="ml-auto flex items-center justify-end gap-1">
                        <CampaignRowActions
                          campaign={{
                            id: campaign.id,
                            name: campaign.name,
                            status: campaign.status,
                          }}
                        />
                        <div className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <DeleteCampaignDialog
                            campaign={{
                              id: campaign.id,
                              name: campaign.name,
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
      ) : (
        <EmptyState filtered={allCampaigns.length > 0} />
      )}
    </div>
  );
}

/** Inline spend-cap bar in the Spend today column. Renders the
 *  current spend with a thin progress bar against the daily cap.
 *  Coral when nearing the cap (>80%), red when over. Falls back to
 *  the dollar number alone when no cap is set. */
function SpendCapBar({ spend, cap }: { spend: number; cap: number | null }) {
  const dollars = `$${spend.toFixed(2)}`;
  if (!cap || cap <= 0) {
    return (
      <span className="text-foreground font-mono text-xs tabular-nums">
        {dollars}
      </span>
    );
  }
  const pct = Math.min(100, Math.round((spend / cap) * 100));
  const tone =
    pct >= 100
      ? "bg-destructive"
      : pct >= 80
        ? "bg-[color:var(--coral)]"
        : "bg-foreground/70";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-foreground font-mono text-xs tabular-nums">
        {dollars}{" "}
        <span className="text-muted-foreground">/ ${cap.toFixed(0)}</span>
      </span>
      <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
        <div
          className={`h-full ${tone} transition-[width] duration-300`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
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
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <Megaphone className="text-muted-foreground size-8" />
      <p className="text-foreground text-sm font-medium">No campaigns yet</p>
      <p className="text-muted-foreground max-w-md text-sm">
        Click <span className="font-medium">New campaign</span> above to build
        your first one — you&apos;ll pick an agent, a goal, a Twilio number, and
        the lists to call.
      </p>
    </div>
  );
}
