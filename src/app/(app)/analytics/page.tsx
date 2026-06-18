import { Info } from "lucide-react";
import { redirect } from "next/navigation";

import {
  bookingsByDay,
  buildInsights,
  buildLeadFunnel,
  callsByDay,
  computeKpis,
  fetchCallsForRange,
  outcomeDistribution,
  pctDelta,
  previousPeriod,
  rankCampaigns,
  resolveDatePreset,
  type FunnelStep,
  type Slicers,
} from "@/lib/analytics/stats";
import { createClient } from "@/lib/supabase/server";

import { ActivityOverTime } from "./activity-over-time";
import { AnalyticsDatePills } from "./analytics-date-pills";
import { AnalyticsEmpty } from "./analytics-empty";
import { AnalyticsFilters } from "./analytics-filters";
import { AnalyticsFunnel } from "./analytics-funnel";
import { AnalyticsInsight } from "./analytics-insight";
import { BestTimeHeatmap } from "./best-time-heatmap";
import { CampaignLeaderboard, OutcomeBreakdown } from "./charts";
import { KpiTile } from "./kpi-tile";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function fmtSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function fmtPct(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function isMockMode(): boolean {
  return (
    process.env.TWILIO_LIVE !== "live" &&
    process.env.ELEVENLABS_LIVE !== "live" &&
    process.env.OPENAI_LIVE !== "live"
  );
}

function fmtRangeLabel(from: string, to: string): string {
  try {
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    const fmt: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    if (from === to) return f.toLocaleDateString(undefined, fmt);
    return `${f.toLocaleDateString(undefined, fmt)} – ${t.toLocaleDateString(undefined, fmt)}`;
  } catch {
    return `${from} → ${to}`;
  }
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
    campaign?: string;
    user?: string;
    list?: string;
    compare?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const preset = str(params.preset) || "last30";
  const customFromInput = DATE_RE.test(str(params.from))
    ? str(params.from)
    : undefined;
  const customToInput = DATE_RE.test(str(params.to))
    ? str(params.to)
    : undefined;
  const { from, to } = resolveDatePreset(preset, {
    from: customFromInput,
    to: customToInput,
  });
  const campaignId = UUID_RE.test(str(params.campaign))
    ? str(params.campaign)
    : undefined;
  const ownerId = UUID_RE.test(str(params.user)) ? str(params.user) : undefined;
  const listId = UUID_RE.test(str(params.list)) ? str(params.list) : undefined;
  // Compare-to-prior-period is on by default — the hero metric needs a
  // baseline to feel meaningful. Pass ?compare=0 to turn off.
  const compare = str(params.compare) !== "0";

  const slicers: Slicers = { from, to, campaignId, ownerId, listId };

  const [rows, priorRows, { data: campaigns }, { data: lists }, { data: me }] =
    await Promise.all([
      fetchCallsForRange(supabase, slicers),
      compare
        ? fetchCallsForRange(supabase, {
            ...slicers,
            ...previousPeriod(slicers),
          })
        : Promise.resolve([]),
      supabase.from("campaigns").select("id, name").order("name"),
      supabase.from("lists").select("id, name").order("name"),
      supabase.from("profiles").select("role").eq("id", user.id).single(),
    ]);
  const isAdmin = me?.role === "admin";

  let owners: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name");
    owners = (people ?? []).map((p) => ({
      id: p.id,
      name: p.full_name || p.email || "—",
    }));
  }

  const kpis = computeKpis(rows);
  const prior = compare ? computeKpis(priorRows) : null;
  const dailyBookings = bookingsByDay(rows, slicers);
  // Daily call volume + spend — same pre-seeded day grid, so the trend
  // toggle (Appointments / Calls / Spend) shares one x-axis.
  const dailyActivity = callsByDay(rows, slicers);
  const dailyCalls = dailyActivity.map((b) => b.count);
  const dailySpend = dailyActivity.map((b) => b.spend);
  const leadFunnel = buildLeadFunnel(rows);
  const priorLeadFunnel = compare ? buildLeadFunnel(priorRows) : null;
  // Step-over-step conversion rates derived from the per-business funnel.
  const stepRate = (f: FunnelStep[], i: number): number => {
    const denom = f[i - 1]?.count ?? 0;
    return denom === 0 ? 0 : (f[i]?.count ?? 0) / denom;
  };
  const rates = {
    connect: stepRate(leadFunnel, 1),
    conversation: stepRate(leadFunnel, 2),
    dm: stepRate(leadFunnel, 3),
    goal: stepRate(leadFunnel, 4),
  };
  const priorRates = priorLeadFunnel
    ? {
        connect: stepRate(priorLeadFunnel, 1),
        conversation: stepRate(priorLeadFunnel, 2),
        dm: stepRate(priorLeadFunnel, 3),
        goal: stepRate(priorLeadFunnel, 4),
      }
    : null;
  const outcomeBuckets = outcomeDistribution(rows);
  const campaignNames = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );
  const ranking = rankCampaigns(rows, campaignNames);
  // Deterministic "AI read" of the period — one plain-English sentence
  // on the appointments trend + biggest funnel leak. No LLM call.
  const insight = buildInsights({ kpis, prior, funnel: leadFunnel, ranking });
  const hasData = kpis.totalCalls > 0;

  const mockMode = isMockMode();
  const rangeLabel = fmtRangeLabel(from, to);

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header row — title left, Filters popover right. The date pills
       *  sit below as their own row because date range is the primary
       *  axis of the page, not "yet another filter". */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          {/* Round 30 — title + range live on one line. The numeric
           *  context (call count + compare flag) keeps its second line
           *  because it's the secondary signal, not the page name. */}
          <div>
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              Analytics{" "}
              <span className="text-muted-foreground font-normal">
                · {rangeLabel}
              </span>
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {kpis.totalCalls.toLocaleString()}{" "}
              {kpis.totalCalls === 1 ? "call" : "calls"}
              {compare ? " · comparing to prior period" : ""}
            </p>
          </div>
          <AnalyticsFilters
            campaigns={campaigns ?? []}
            lists={lists ?? []}
            owners={owners}
            showOwner={isAdmin}
          />
        </div>

        <AnalyticsDatePills
          current={preset}
          initialFrom={customFromInput ?? from}
          initialTo={customToInput ?? to}
        />
      </div>

      {/* Page-level mock-data banner — clearer than a tiny badge tucked
       *  into one tile. Drops the moment any LIVE env var flips. */}
      {mockMode ? (
        <div
          data-testid="mock-data-banner"
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
        >
          <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <p className="text-foreground font-medium">
              You&apos;re viewing mock data
            </p>
            <p className="text-muted-foreground text-xs">
              Twilio, ElevenLabs, and OpenAI are all running in simulated mode.
              Costs, durations, and outcomes are seeded for design and QA — not
              real billable activity.
            </p>
          </div>
        </div>
      ) : null}

      {hasData ? (
        <>
          {/* AI read of the period — the page's single interpretive moment.
           *  Leads the body so the owner gets the "so what" before the
           *  raw tiles. */}
          <AnalyticsInsight insight={insight} />

          {/* Conversion funnel hero — the per-business funnel, with the
           *  step-over-step conversion rates pulled out beneath it. */}
          <AnalyticsFunnel steps={leadFunnel} />

          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiTile
              label="Connect rate"
              value={fmtPct(rates.connect)}
              hint="Businesses we reached"
              pctDelta={
                priorRates
                  ? pctDelta(rates.connect, priorRates.connect)
                  : undefined
              }
            />
            <KpiTile
              label="Conversation rate"
              value={fmtPct(rates.conversation)}
              hint="Of connected, talked > 1 min"
              pctDelta={
                priorRates
                  ? pctDelta(rates.conversation, priorRates.conversation)
                  : undefined
              }
            />
            <KpiTile
              label="DM-reach rate"
              value={fmtPct(rates.dm)}
              hint="Of conversations, reached the DM"
              pctDelta={
                priorRates ? pctDelta(rates.dm, priorRates.dm) : undefined
              }
            />
            <KpiTile
              label="Goal rate"
              value={fmtPct(rates.goal)}
              hint="Of DMs reached, goal met"
              pctDelta={
                priorRates ? pctDelta(rates.goal, priorRates.goal) : undefined
              }
            />
          </section>

          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both delay-150 duration-500">
            <ActivityOverTime
              startDate={from}
              series={[
                {
                  key: "appts",
                  label: "Goals met",
                  values: dailyBookings,
                  format: "count",
                  noun: "goal met",
                },
                {
                  key: "calls",
                  label: "Calls",
                  values: dailyCalls,
                  format: "count",
                  noun: "call",
                },
                {
                  key: "spend",
                  label: "Spend",
                  values: dailySpend,
                  format: "usd",
                  noun: "spend",
                },
              ]}
            />
          </div>

          {/* Layer 2 — Clarification: top campaigns + outcome mix side by side
           *  (the funnel moved up to the hero). */}
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-1 gap-4 delay-200 duration-500 lg:grid-cols-2">
            <section className="border-border bg-card rounded-xl border p-5">
              <h2 className="text-foreground text-sm font-semibold">
                Top campaigns
              </h2>
              <p className="text-muted-foreground mt-1 mb-3 text-xs">
                Sorted by Goal Met. Top 3 wear the medal.
              </p>
              <CampaignLeaderboard rows={ranking} />
            </section>

            <section className="border-border bg-card rounded-xl border p-5">
              <h2 className="text-foreground text-sm font-semibold">
                Outcome distribution
              </h2>
              <p className="text-muted-foreground mt-1 mb-3 text-xs">
                All call outcomes in this range.
              </p>
              <OutcomeBreakdown
                buckets={outcomeBuckets}
                total={kpis.totalCalls}
              />
            </section>
          </div>

          {/* Best time to call heatmap — workspace-wide connect-rate signal. */}
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-1 gap-4 delay-250 duration-500 lg:grid-cols-2">
            <BestTimeHeatmap />
          </div>

          {/* Inventory strip — six low-priority counts displayed as a grid
           *  of mini-tiles instead of a single run-on line. */}
          <section
            data-testid="inventory-strip"
            className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-2 delay-300 duration-500"
          >
            <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
              Also in this period:
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
              <InventoryTile
                label="Callbacks scheduled"
                value={kpis.callbacksScheduled.toLocaleString()}
              />
              <InventoryTile
                label="DNC additions"
                value={kpis.dncAdditions.toLocaleString()}
              />
              <InventoryTile
                label="Avg call"
                value={fmtSeconds(kpis.avgDurationSeconds)}
              />
              <InventoryTile
                label="Cost per goal"
                value={kpis.goalMet === 0 ? "—" : fmtUsd(kpis.costPerGoalMet)}
              />
              <InventoryTile
                label="Avg cost / call"
                value={fmtUsd(kpis.avgCostPerCall)}
              />
              <InventoryTile
                label="Total spend"
                value={fmtUsd(kpis.totalSpend)}
              />
            </div>
          </section>
        </>
      ) : (
        <AnalyticsEmpty />
      )}
    </div>
  );
}

function InventoryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border bg-card flex flex-col gap-0.5 rounded-lg border p-3">
      <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="text-foreground text-base font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}
