import { Target } from "lucide-react";
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
import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";

import { DeleteGoalDialog } from "./delete-goal-dialog";
import { GoalFormDialog } from "./goal-form-dialog";
import { GoalStatusActions } from "./goal-status-actions";

const GOAL_STATUS_LABEL: Record<string, string> = {
  goal_met: "Goal met",
  attended: "Attended",
  no_show: "No-show",
  sale: "Sale",
  closed: "Closed",
};

type PipelineLead = {
  id: string;
  company: string | null;
  business_phone: string | null;
  business_email: string | null;
  status: GoalStatus;
  last_call_at: string | null;
  campaign_id: string;
  campaign_name: string;
  goal_id: string;
  goal_name: string;
};

export default async function GoalsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: goals } = await supabase
    .from("goals")
    .select("id, name, description, is_default, created_at")
    .order("created_at", { ascending: true });

  // Pipeline: leads currently in a goal status (anything past "called and
  // it went well"), grouped by the campaign that drove the most recent
  // goal_met call.
  const { data: leadsInPipeline } = await supabase
    .from("leads")
    .select("id, company, business_phone, business_email, status, last_call_at")
    .in("status", GOAL_STATUSES)
    .is("deleted_at", null)
    .order("last_call_at", { ascending: false });

  // For each pipeline lead, find the most recent goal_met call to identify
  // which campaign produced this lead. One query, then join in code.
  const leadIds = (leadsInPipeline ?? []).map((l) => l.id);
  type GoalMetCall = {
    lead_id: string;
    campaign_id: string;
    created_at: string;
    campaign: { id: string; name: string; goal_id: string } | null;
  };
  let goalMetCalls: GoalMetCall[] = [];
  if (leadIds.length > 0) {
    const { data } = await supabase
      .from("calls")
      .select(
        "lead_id, campaign_id, created_at, campaign:campaigns(id, name, goal_id)",
      )
      .in("lead_id", leadIds)
      .eq("goal_met", true)
      .order("created_at", { ascending: false });
    goalMetCalls = (data ?? []) as unknown as GoalMetCall[];
  }
  // Keep the FIRST hit per lead — `data` is desc by created_at, so first = newest.
  const campaignByLead = new Map<
    string,
    { campaign_id: string; campaign_name: string; goal_id: string }
  >();
  for (const c of goalMetCalls) {
    if (campaignByLead.has(c.lead_id)) continue;
    if (!c.campaign) continue;
    campaignByLead.set(c.lead_id, {
      campaign_id: c.campaign.id,
      campaign_name: c.campaign.name,
      goal_id: c.campaign.goal_id,
    });
  }
  const goalById = new Map((goals ?? []).map((g) => [g.id, g.name]));

  const pipeline: PipelineLead[] = (leadsInPipeline ?? [])
    .map((l) => {
      const m = campaignByLead.get(l.id);
      if (!m) return null;
      return {
        id: l.id,
        company: l.company,
        business_phone: l.business_phone,
        business_email: l.business_email,
        status: l.status as GoalStatus,
        last_call_at: l.last_call_at,
        campaign_id: m.campaign_id,
        campaign_name: m.campaign_name,
        goal_id: m.goal_id,
        goal_name: goalById.get(m.goal_id) ?? "—",
      };
    })
    .filter((l): l is PipelineLead => l !== null);

  // Group leads by campaign for the per-campaign sections.
  const grouped = new Map<
    string,
    { campaignName: string; goalName: string; leads: PipelineLead[] }
  >();
  for (const lead of pipeline) {
    const existing = grouped.get(lead.campaign_id);
    if (existing) {
      existing.leads.push(lead);
    } else {
      grouped.set(lead.campaign_id, {
        campaignName: lead.campaign_name,
        goalName: lead.goal_name,
        leads: [lead],
      });
    }
  }
  const sections = [...grouped.entries()].sort(([, a], [, b]) =>
    a.campaignName.localeCompare(b.campaignName),
  );

  return (
    <div className="flex flex-col gap-8 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Goals
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Track Goal Met leads through their real-world outcomes (attended,
            no-show, sale, closed).
          </p>
        </div>
        <GoalFormDialog mode="create" />
      </div>

      {/* Goal definitions (CRUD) */}
      <section className="flex flex-col gap-2">
        <h2 className="text-foreground text-sm font-semibold tracking-wide uppercase">
          Goal definitions
        </h2>
        {goals && goals.length > 0 ? (
          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {goals.map((goal) => (
                  <TableRow key={goal.id}>
                    <TableCell className="font-medium">{goal.name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {goal.description || "—"}
                    </TableCell>
                    <TableCell>
                      {goal.is_default ? (
                        <Badge variant="secondary">Default</Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(goal.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <GoalFormDialog mode="edit" goal={goal} />
                        <DeleteGoalDialog goal={goal} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
            <Target className="text-muted-foreground size-6" />
            <p className="text-foreground text-sm font-medium">No goals yet</p>
            <p className="text-muted-foreground text-sm">
              Create your first goal to start building campaigns.
            </p>
          </div>
        )}
      </section>

      {/* Pipeline sections */}
      <section className="flex flex-col gap-4">
        <h2 className="text-foreground text-sm font-semibold tracking-wide uppercase">
          Pipeline
        </h2>
        {sections.length > 0 ? (
          sections.map(([campaignId, group]) => (
            <div
              key={campaignId}
              className="border-border overflow-hidden rounded-lg border"
            >
              <div className="border-border bg-muted/30 flex items-center justify-between gap-3 border-b px-4 py-3">
                <div>
                  <p className="text-foreground text-sm font-semibold">
                    {group.campaignName}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Goal: {group.goalName}
                  </p>
                </div>
                <Badge variant="secondary">
                  {group.leads.length}{" "}
                  {group.leads.length === 1 ? "lead" : "leads"}
                </Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Company</TableHead>
                    <TableHead>Contact</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last call</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.leads.map((lead) => (
                    <TableRow key={lead.id}>
                      <TableCell className="font-medium">
                        {lead.company || "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        <span className="block font-mono text-xs">
                          {lead.business_phone || "—"}
                        </span>
                        <span className="block text-xs">
                          {lead.business_email || ""}
                        </span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">
                          {GOAL_STATUS_LABEL[lead.status] ?? lead.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {lead.last_call_at
                          ? new Date(lead.last_call_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <GoalStatusActions
                            leadId={lead.id}
                            currentStatus={lead.status}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ))
        ) : (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <Target className="text-muted-foreground size-6" />
            <p className="text-foreground text-sm font-medium">
              No leads in the pipeline yet
            </p>
            <p className="text-muted-foreground text-sm">
              Leads land here once a call&apos;s outcome is Goal Met.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
