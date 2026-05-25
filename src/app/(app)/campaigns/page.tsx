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

import {
  CampaignSettingsDialog,
  type CampaignData,
} from "./campaign-settings-dialog";
import { DeleteCampaignDialog } from "./delete-campaign-dialog";

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

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const [{ data: rawCampaigns }, { data: agents }, { data: goals }] =
    await Promise.all([
      supabase
        .from("campaigns")
        .select(
          "id, name, description, status, agent_id, goal_id, daily_spend_cap, monthly_spend_cap, created_at, agent:agents(name), goal:goals(name)",
        )
        .order("created_at", { ascending: false }),
      supabase.from("agents").select("id, name").order("name"),
      supabase.from("goals").select("id, name").order("name"),
    ]);

  const campaigns = (rawCampaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    agent_id: c.agent_id,
    goal_id: c.goal_id,
    daily_spend_cap: c.daily_spend_cap,
    monthly_spend_cap: c.monthly_spend_cap,
    created_at: c.created_at,
    agent_name: c.agent?.name ?? "—",
    goal_name: c.goal?.name ?? "—",
  }));

  const agentOptions = (agents ?? []).map((a) => ({
    id: a.id,
    name: a.name,
  }));
  const goalOptions = (goals ?? []).map((g) => ({ id: g.id, name: g.name }));

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
        <CampaignSettingsDialog
          mode="create"
          agents={agentOptions}
          goals={goalOptions}
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
                <TableHead className="w-40" />
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
                  daily_spend_cap: campaign.daily_spend_cap,
                  monthly_spend_cap: campaign.monthly_spend_cap,
                };
                return (
                  <TableRow key={campaign.id}>
                    <TableCell className="font-medium">
                      {campaign.name}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(campaign.status)}>
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
                      <div className="flex justify-end gap-1">
                        <CampaignSettingsDialog
                          mode="edit"
                          campaign={data}
                          agents={agentOptions}
                          goals={goalOptions}
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
