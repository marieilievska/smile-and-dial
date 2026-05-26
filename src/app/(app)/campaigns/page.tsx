import { Megaphone } from "lucide-react";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { CampaignRowActions } from "./campaign-row-actions";
import {
  CampaignSettingsDialog,
  type CampaignData,
  type TwilioOption,
} from "./campaign-settings-dialog";
import { CreateCampaignDialog } from "./create-campaign-dialog";
import { DeleteCampaignDialog } from "./delete-campaign-dialog";

type Option = { id: string; name: string };

function humanize(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusVariant(
  status: string,
): "success" | "destructive" | "secondary" {
  if (status === "active") return "success";
  if (status === "ended") return "destructive";
  return "secondary";
}

export default async function CampaignsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [
    { data: rawCampaigns },
    { data: agentsRaw },
    { data: goalsRaw },
    { data: rawNumbers },
    { data: kbsRaw },
    { data: rawLists },
    { data: rawAttachments },
  ] = await Promise.all([
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

  const campaigns = (rawCampaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    agent_id: c.agent_id,
    goal_id: c.goal_id,
    twilio_number_id: c.twilio_number_id,
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

  return (
    <div className="p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Campaigns
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Calling campaigns — each ties leads to an agent and a goal.
          </p>
        </div>
        <CreateCampaignDialog
          agents={agentOptions}
          goals={goalOptions}
          eligibleLists={eligibleListsFor(null)}
        />
      </div>

      {campaigns.length > 0 ? (
        <div className="border-border mt-6 overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-64" />
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
                return (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">
                      {campaign.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(campaign.status)} dot>
                        {humanize(campaign.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {campaign.agent_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {campaign.goal_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(campaign.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <CampaignRowActions
                          campaign={{
                            id: campaign.id,
                            name: campaign.name,
                            status: campaign.status,
                          }}
                        />
                        <CampaignSettingsDialog
                          mode="edit"
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
                        <DeleteCampaignDialog
                          campaign={{
                            id: campaign.id,
                            name: campaign.name,
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border mt-6 flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Megaphone className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No campaigns yet
          </p>
          <p className="text-muted-foreground text-sm">
            Build your first campaign to start dialing leads.
          </p>
        </div>
      )}
    </div>
  );
}
