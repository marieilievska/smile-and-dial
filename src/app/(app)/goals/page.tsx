import { Target } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { GOAL_STATUSES, type GoalStatus } from "@/lib/goals/goal-statuses";
import { createClient } from "@/lib/supabase/server";

import { PipelineBoard } from "./pipeline-board";
import { PipelineFunnelBar } from "./pipeline-funnel-bar";
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
  // Default to the board — it's the SDR's natural mental model for a
  // pipeline. ?view=table opts in to the dense flat view.
  const view: "table" | "board" =
    str(params.view) === "table" ? "table" : "board";

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

  const hasPipeline = allPipelineLeads.length > 0;

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-1.5 delay-75 duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Pipeline
        </h1>
        <p className="text-muted-foreground text-sm">
          Leads the AI promoted past a Goal Met call. Move them through attended
          → sale → closed as the real-world outcome lands.
        </p>
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-4 delay-100 duration-500">
        <PipelineStatStrip stats={stats} />
        {/* Glanceable funnel across the five stages — only when there's
            actually a pipeline to summarize. */}
        {hasPipeline ? <PipelineFunnelBar counts={tabCounts} /> : null}
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both delay-150 duration-500">
        <PipelineToolbar
          goals={goals ?? []}
          campaigns={campaignOptions}
          currentStatus={statusFilter}
          currentView={view}
          counts={tabCounts}
        />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both delay-200 duration-500">
        {filtered.length === 0 ? (
          <EmptyState filtered={hasPipeline} />
        ) : view === "board" ? (
          <PipelineBoard leads={filtered} />
        ) : (
          <PipelineTable leads={filtered} />
        )}
      </div>
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
      <div className="border-border flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
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
    <div className="border-border flex flex-col items-center gap-3 rounded-2xl border border-dashed py-16 text-center">
      <div className="bg-primary/10 flex size-12 items-center justify-center rounded-full">
        <Target className="text-primary size-6" />
      </div>
      <p className="text-foreground text-sm font-medium">
        Your first win will land here
      </p>
      <p className="text-muted-foreground max-w-md text-sm">
        Whenever the AI closes a goal on a call, that lead drops into the
        pipeline automatically — then you move it through attended → sale →
        closed as the real-world outcome lands.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/calls">Browse recent calls</Link>
      </Button>
    </div>
  );
}
