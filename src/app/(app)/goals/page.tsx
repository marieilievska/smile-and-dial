import { Target } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";
import { createClient } from "@/lib/supabase/server";

import { PipelineBoard } from "./pipeline-board";
import { PipelineStatStrip, type PipelineStats } from "./pipeline-stat-strip";
import { PipelineTable } from "./pipeline-table";
import { PipelineToolbar } from "./pipeline-toolbar";
import type { PipelineLead } from "./pipeline-types";

const STATUS_VALUES = new Set<string>([
  ...GOAL_STATUSES,
  "open", // every status except Closed
  "all", // every status
]);
const UUID_RE = /^[0-9a-f-]{36}$/i;

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    goal?: string;
    campaign?: string;
    view?: string;
  }>;
}) {
  const params = await searchParams;
  const statusFilter = STATUS_VALUES.has(str(params.status))
    ? str(params.status)
    : "open";
  const goalFilter = UUID_RE.test(str(params.goal)) ? str(params.goal) : "";
  const campaignFilter = UUID_RE.test(str(params.campaign))
    ? str(params.campaign)
    : "";
  const view: "table" | "board" =
    str(params.view) === "board" ? "board" : "table";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // 1) Pull every lead in a goal-pipeline status (RLS scopes it).
  const { data: leadsRaw } = await supabase
    .from("leads")
    .select("id, company, business_phone, business_email, status, last_call_at")
    .in("status", GOAL_STATUSES)
    .is("deleted_at", null)
    .order("last_call_at", { ascending: false });

  const leadIds = (leadsRaw ?? []).map((l) => l.id);

  // 2) For each pipeline lead, find the most recent goal_met call.
  //    That tells us which campaign drove the conversion AND when the
  //    lead was promoted (the "Goal met" timestamp on the table view).
  type GoalMetCall = {
    id: string;
    lead_id: string;
    campaign_id: string;
    created_at: string;
    campaign: {
      id: string;
      name: string;
      goal_id: string;
      goal: { id: string; name: string } | null;
    } | null;
  };
  let goalMetCalls: GoalMetCall[] = [];
  if (leadIds.length > 0) {
    const { data } = await supabase
      .from("calls")
      .select(
        "id, lead_id, campaign_id, created_at, campaign:campaigns(id, name, goal_id, goal:goals(id, name))",
      )
      .in("lead_id", leadIds)
      .eq("goal_met", true)
      .order("created_at", { ascending: false });
    goalMetCalls = (data ?? []) as unknown as GoalMetCall[];
  }
  // Keep the newest hit per lead — `data` is desc by created_at.
  const sourceByLead = new Map<
    string,
    {
      callId: string;
      campaign_id: string;
      campaign_name: string;
      goal_id: string;
      goal_name: string;
      goalMetAt: string;
    }
  >();
  for (const c of goalMetCalls) {
    if (sourceByLead.has(c.lead_id)) continue;
    if (!c.campaign) continue;
    sourceByLead.set(c.lead_id, {
      callId: c.id,
      campaign_id: c.campaign.id,
      campaign_name: c.campaign.name,
      goal_id: c.campaign.goal_id,
      goal_name: c.campaign.goal?.name ?? "—",
      goalMetAt: c.created_at,
    });
  }

  // 3) Hydrate the PipelineLead rows — drop any lead we couldn't link
  //    back to a goal_met call (shouldn't happen in normal flow but
  //    guards against orphaned legacy data).
  const allPipelineLeads: PipelineLead[] = (leadsRaw ?? [])
    .map((l): PipelineLead | null => {
      const src = sourceByLead.get(l.id);
      if (!src) return null;
      return {
        id: l.id,
        company: l.company,
        business_phone: l.business_phone,
        business_email: l.business_email,
        status: l.status as GoalStatus,
        goalMetAt: src.goalMetAt,
        campaign_id: src.campaign_id,
        campaign_name: src.campaign_name,
        goal_id: src.goal_id,
        goal_name: src.goal_name,
        originating_call_id: src.callId,
      };
    })
    .filter((l): l is PipelineLead => l !== null);

  // 4) Apply filters in memory — the pipeline list is small (rarely
  //    >100 rows for a single tenant) so this is fine and keeps the
  //    query simple.
  const filtered = allPipelineLeads.filter((l) => {
    if (statusFilter === "all") {
      // no status restriction
    } else if (statusFilter === "open") {
      if (l.status === "closed") return false;
    } else if (l.status !== statusFilter) {
      return false;
    }
    if (goalFilter && l.goal_id !== goalFilter) return false;
    if (campaignFilter && l.campaign_id !== campaignFilter) return false;
    return true;
  });

  // 5) Tab counts — independent of filters so the badges always tell
  //    the same story even when the user narrows the view.
  const tabCounts: Record<string, number> = {
    open: allPipelineLeads.filter((l) => l.status !== "closed").length,
    all: allPipelineLeads.length,
  };
  for (const s of GOAL_STATUSES) {
    tabCounts[s] = allPipelineLeads.filter((l) => l.status === s).length;
  }

  // 6) Stat-strip numbers. Use a single `now` so all the comparisons
  //    are against the same instant — and so the lint rule doesn't
  //    flag the page for calling Date.now() during render (this is an
  //    async server component, but the rule treats it like any other
  //    React render).
  const now = new Date();
  const oneWeekAgoMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const stats: PipelineStats = {
    inPipeline: allPipelineLeads.filter((l) => l.status !== "closed").length,
    awaitingAttended: allPipelineLeads.filter((l) => l.status === "goal_met")
      .length,
    noShows: allPipelineLeads.filter((l) => l.status === "no_show").length,
    salesThisWeek: allPipelineLeads.filter(
      (l) =>
        l.status === "sale" &&
        l.goalMetAt &&
        new Date(l.goalMetAt).getTime() >= oneWeekAgoMs,
    ).length,
  };

  // Goal + campaign dropdown options for the filter popover. Goals
  // come from the goals table directly; campaigns come from the data
  // we already hydrated so we don't show stale or unrelated ones.
  const { data: goals } = await supabase
    .from("goals")
    .select("id, name")
    .order("name");
  const campaignMap = new Map<string, string>();
  for (const l of allPipelineLeads) {
    campaignMap.set(l.campaign_id, l.campaign_name);
  }
  const campaignOptions = [...campaignMap.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Pipeline
        </h1>
        <p className="text-muted-foreground text-sm">
          Leads the AI promoted past a Goal Met call. Move them through attended
          → sale → closed as the real-world outcome lands.
        </p>
      </div>

      <PipelineStatStrip stats={stats} />

      <PipelineToolbar
        goals={goals ?? []}
        campaigns={campaignOptions}
        currentStatus={statusFilter}
        currentView={view}
        counts={tabCounts}
      />

      {filtered.length === 0 ? (
        <EmptyState filtered={allPipelineLeads.length > 0} />
      ) : view === "board" ? (
        <PipelineBoard leads={filtered} />
      ) : (
        <PipelineTable leads={filtered} />
      )}
    </div>
  );
}

/** Two-variant empty state. `filtered=true` means there ARE leads in
 *  the pipeline overall, just none matching the current
 *  status/goal/campaign filters — offer a clear button instead of
 *  the generic "no leads yet" pitch. */
function EmptyState({ filtered }: { filtered: boolean }) {
  if (filtered) {
    return (
      <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <Target className="text-muted-foreground size-8" />
        <p className="text-foreground text-sm font-medium">
          No leads match your filters
        </p>
        <p className="text-muted-foreground text-sm">
          Try a different status tab or clear the filter popover.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/goals">Clear filters</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <Target className="text-muted-foreground size-8" />
      <p className="text-foreground text-sm font-medium">
        No leads in the pipeline yet
      </p>
      <p className="text-muted-foreground max-w-md text-sm">
        Leads land here once a call&apos;s outcome is Goal Met. Until then the
        pipeline is empty — head over to /calls to see what&apos;s happening.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/calls">Browse recent calls</Link>
      </Button>
    </div>
  );
}
