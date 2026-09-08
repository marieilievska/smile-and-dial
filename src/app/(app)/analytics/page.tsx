import { Info } from "lucide-react";
import { redirect } from "next/navigation";

import {
  bookingsByDayFromSummary,
  buildInsights,
  callsByDayFromSummary,
  fetchAnalyticsSummary,
  funnelFromSummary,
  kpisFromSummary,
  previousPeriod,
  rankCampaignsFromSummary,
  resolveDatePreset,
  type AnalyticsSummary,
  type Slicers,
} from "@/lib/analytics/stats";
import { buildEconomicsFunnel } from "@/lib/analytics/list-economics";
import {
  fetchListPerformance,
  totalsFor,
} from "@/lib/analytics/list-performance";
import { formatUsd as fmtUsd } from "@/lib/format-usd";
import { createClient } from "@/lib/supabase/server";

import { ActivityOverTime } from "./activity-over-time";
import { AnalyticsDatePills } from "./analytics-date-pills";
import { AnalyticsEmpty } from "./analytics-empty";
import { AnalyticsFilters } from "./analytics-filters";
import { AnalyticsInsight } from "./analytics-insight";
import { BestTimeHeatmap } from "./best-time-heatmap";
import { CampaignLeaderboard, OutcomeBreakdown } from "./charts";
import { FunnelSection } from "./funnel-section";
import { ListEconomicsTable } from "./list-economics-table";
import { dateRangeLabel } from "@/lib/time/eastern";
import { isSuperAdmin } from "@/lib/auth/roles";

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

function isMockMode(): boolean {
  return (
    process.env.TWILIO_LIVE !== "live" &&
    process.env.ELEVENLABS_LIVE !== "live" &&
    process.env.OPENAI_LIVE !== "live"
  );
}

function fmtRangeLabel(from: string, to: string): string {
  return dateRangeLabel(from, to);
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
    listperiod?: string;
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
  // The lead-list section is the one thing on this page that opts out of the
  // date pills, and it does so BY DEFAULT: lists are imported at different
  // moments and worked to different depths, so a shared 30-day window would
  // score a list you finished dialling six weeks ago as a failure. Pass
  // ?listperiod=range to judge the lists through the selected range instead.
  const listPeriod = str(params.listperiod) === "range" ? "range" : "all";
  // The page's own query string, so a drill-down from a list row keeps every
  // other filter rather than resetting the page.
  const baseParams = new URLSearchParams(
    Object.entries(params).flatMap(([k, v]) =>
      typeof v === "string" && v ? [[k, v] as [string, string]] : [],
    ),
  ).toString();
  // Compare-to-prior-period is on by default — the hero metric needs a
  // baseline to feel meaningful. Pass ?compare=0 to turn off.
  const compare = str(params.compare) !== "0";

  const slicers: Slicers = { from, to, campaignId, ownerId, listId };

  const [
    summary,
    priorSummary,
    listRows,
    funnelListRows,
    { data: campaigns },
    { data: lists },
    { data: me },
  ] = await Promise.all([
    // One aggregate per window instead of paging every call out of the
    // database and counting it here. This used to be ~9 sequential 1,000-row
    // requests per window, twice over — most of the page's render.
    fetchAnalyticsSummary(supabase, slicers),
    compare
      ? fetchAnalyticsSummary(supabase, {
          ...slicers,
          ...previousPeriod(slicers),
        })
      : Promise.resolve(null as AnalyticsSummary | null),
    // Counted in SQL, not here: one row per list rather than per call, so
    // PostgREST's 1,000-row cap is nowhere near — which is the point, since
    // grouping 84k leads in JavaScript would silently undercount.
    fetchListPerformance(supabase, {
      from: listPeriod === "range" ? from : null,
      to: listPeriod === "range" ? to : null,
      campaignId,
      ownerId,
    }),
    // The funnel reads ONE window: the date pills. The list table's All-time
    // toggle is a property of LISTS, which are imported at different moments —
    // letting it reach the funnel is what let the old pair read different
    // periods while looking like one story. Identical args when the toggle is
    // already "range", so skip the second round trip in that case.
    listPeriod === "range"
      ? Promise.resolve(null)
      : fetchListPerformance(supabase, { from, to, campaignId, ownerId }),
    supabase.from("campaigns").select("id, name").order("name"),
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
  ]);
  const funnelRows = funnelListRows ?? listRows;
  // The Owner filter and the Owner column only make sense for the tier that
  // actually sees other people's calls — super admin (RLS `is_admin()`).
  const seesEveryone = isSuperAdmin(me?.role);

  let owners: { id: string; name: string }[] = [];
  if (seesEveryone) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name");
    owners = (people ?? []).map((p) => ({
      id: p.id,
      name: p.full_name || p.email || "—",
    }));
  }

  const kpis = kpisFromSummary(summary);
  const prior = priorSummary ? kpisFromSummary(priorSummary) : null;
  const dailyBookings = bookingsByDayFromSummary(summary, slicers);
  // Daily call volume + spend — same pre-seeded day grid, so the trend
  // toggle (Appointments / Calls / Spend) shares one x-axis.
  const dailyActivity = callsByDayFromSummary(summary, slicers);
  const dailyCalls = dailyActivity.map((b) => b.count);
  const dailySpend = dailyActivity.map((b) => b.spend);
  const leadFunnel = funnelFromSummary(summary);
  // The two halves of the chain, from the two aggregates that own them. They
  // share no quantity: analytics_summary supplies every call-level count, the
  // goal counts and the spend; list_performance supplies only the registration
  // outcomes. Moving one of them to the other source would silently change the
  // window it reads.
  const regTotals = totalsFor(funnelRows);
  const chain = buildEconomicsFunnel(
    {
      called: summary.totals.funnel_called,
      calls: summary.totals.total_calls,
      connected: summary.totals.funnel_connected,
      conversations: summary.totals.funnel_conversation,
      dms: summary.totals.funnel_dm,
      goals: summary.totals.lead_goal,
      goalsWithDm: summary.totals.lead_goal_dm,
      spend: Number(summary.totals.spend),
      regs: regTotals.regs,
      attended: regTotals.attended,
      no_show: regTotals.no_show,
      pending: regTotals.pending,
      sales: regTotals.sales,
    },
    priorSummary
      ? {
          called: priorSummary.totals.funnel_called,
          connected: priorSummary.totals.funnel_connected,
          conversations: priorSummary.totals.funnel_conversation,
          dms: priorSummary.totals.funnel_dm,
        }
      : null,
  );
  const outcomeBuckets = summary.outcomes;
  const campaignNames = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );
  const ranking = rankCampaignsFromSummary(summary, campaignNames);
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
            showOwner={seesEveryone}
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
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-xl border px-4 py-3 text-sm"
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

          {/* The whole chain, dialled business to sale, with conversion, cost
           *  and trend on every step. One funnel: the page used to carry two
           *  that read different windows and named different bottlenecks on
           *  the same screen. The three rate tiles that sat under the old one
           *  are gone too — their rates ARE these steps, and their trend now
           *  sits on the number it describes. */}
          <FunnelSection steps={chain} rangeLabel={rangeLabel} />

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
            <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
              <h2 className="text-foreground text-sm font-semibold">
                Top campaigns
              </h2>
              <p className="text-muted-foreground mt-1 mb-3 text-xs">
                Sorted by Goal Met. Top 3 wear the medal.
              </p>
              <CampaignLeaderboard rows={ranking} />
            </section>

            <section className="border-border bg-card rounded-2xl border p-5 shadow-sm">
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

          {/* Which lead list was worth the money, and whether it is still
           *  worth dialling — one table, because that was always one question.
           *
           *  This was two sections stacked until the funnel panel landed:
           *  fourteen columns of performance, then ten of reachability,
           *  repeating List / Leads / Worked and scrolling twenty-four
           *  columns sideways to show two rows of data. The funnel panel at
           *  the top of the page now carries the chain — calls, connects,
           *  decision-makers, goals, sales — with conversion and cost at every
           *  step, which is what those count columns were reaching for and
           *  could not show. Nothing was lost:
           *  the counts moved UP into the funnel, and Mobiles / Bad no. /
           *  Suppressed / Resting moved INTO the Remaining hover — on
           *  production they read —, 0, 36 and 400, four near-zero columns
           *  charging real page width for numbers nobody sorts by.
           *
           *  What is left is the part a funnel cannot answer — how these
           *  lists differ from one another — plus two things neither old
           *  table had: $/att, and how many days of dialling a list has left.
           *
           *  Still fed by the same listRows the funnel is, so the two
           *  panels cannot disagree about how many registrations there were
           *  or what was spent getting them. */}
          <ListEconomicsTable
            rows={listRows}
            period={listPeriod}
            rangeLabel={rangeLabel}
            baseParams={baseParams}
          />

          {/* Best time to call heatmap — workspace-wide connect-rate signal. */}
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both grid grid-cols-1 gap-4 delay-250 duration-500 lg:grid-cols-2">
            <BestTimeHeatmap />
          </div>

          {/* Inventory strip — four low-priority counts displayed as a grid
           *  of mini-tiles instead of a single run-on line. Cost per goal and
           *  Total spend used to sit here too; both are on the chain above
           *  now, where they arrive with the step they price attached. */}
          <section
            data-testid="inventory-strip"
            className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-2 delay-300 duration-500"
          >
            <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
              Also in this period:
            </p>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
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
                label="Avg cost / call"
                value={fmtUsd(kpis.avgCostPerCall)}
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
    <div className="border-border bg-card flex flex-col gap-0.5 rounded-xl border p-3 shadow-sm">
      <p className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
        {label}
      </p>
      <p className="text-foreground text-base font-semibold tabular-nums">
        {value}
      </p>
    </div>
  );
}
