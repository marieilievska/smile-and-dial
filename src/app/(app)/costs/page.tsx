import { AlertTriangle, Download, Info } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchCostRows,
  fetchLookupChargeTotal,
  resolveDatePreset,
  rollupByCampaign,
  rollupByGoalMet,
  rollupByList,
  rollupByTime,
  rollupByUser,
  rollupByVendor,
  type Slicers,
} from "@/lib/analytics/costs";
import { createClient } from "@/lib/supabase/server";

import { BudgetProgress } from "./budget-progress";
import { CostsDatePills } from "./costs-date-pills";
import { CostsHero } from "./costs-hero";
import { CostsKpiStrip } from "./costs-kpi-strip";
import { CostsTopCampaigns } from "./costs-top-campaigns";
import { CostsVendorBreakdown } from "./costs-vendor-breakdown";
import { CostsViewTabs } from "./costs-view-tabs";
import { fmtRangeLabel } from "./format-time";
import { PerCallTable } from "./per-call-table";
import { PerTimeChart } from "./per-time-chart";
import { fetchCampaignCaps, fetchCostsHeadlineStats } from "./stats-query";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const ALLOWED_VIEWS = new Set([
  "per_call",
  "per_campaign",
  "per_list",
  "per_goal",
  "per_user",
  "per_time",
]);

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function usd(value: number): string {
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

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    preset?: string;
    from?: string;
    to?: string;
    campaign?: string;
    user?: string;
    list?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const view = ALLOWED_VIEWS.has(str(params.view))
    ? str(params.view)
    : "per_campaign";
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
  const slicers: Slicers = { from, to, campaignId, ownerId, listId };

  // Previous equal-length window, ending the day before `from`, so we
  // can show a vs-previous-period delta on total spend.
  const addDaysIso = (day: string, delta: number): string => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  };
  const rangeLenDays =
    Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  const prevTo = addDaysIso(from, -1);
  const prevFrom = addDaysIso(prevTo, -(rangeLenDays - 1));
  const prevSlicers: Slicers = { ...slicers, from: prevFrom, to: prevTo };

  const [
    rows,
    { data: campaigns },
    { data: lists },
    headlineStats,
    prevRows,
    campaignCaps,
    { data: activeNumbers },
    importLookupCost,
    prevImportLookupCost,
  ] = await Promise.all([
    fetchCostRows(supabase, slicers),
    supabase.from("campaigns").select("id, name").order("name"),
    supabase.from("lists").select("id, name").order("name"),
    fetchCostsHeadlineStats(supabase),
    fetchCostRows(supabase, prevSlicers),
    fetchCampaignCaps(supabase),
    // Active (un-released) phone numbers carry a flat monthly rental that's
    // billed separately from per-call spend — surfaced on its own line.
    supabase
      .from("twilio_numbers")
      .select("monthly_cost")
      .is("released_at", null),
    // Twilio Lookup spend from lead imports (billed outside calls).
    fetchLookupChargeTotal(supabase, { from, to, ownerId }),
    fetchLookupChargeTotal(supabase, {
      from: prevFrom,
      to: prevTo,
      ownerId,
    }),
  ]);

  const numberCount = activeNumbers?.length ?? 0;
  const monthlyNumberCost = (activeNumbers ?? []).reduce(
    (sum, n) =>
      sum + (Number((n as { monthly_cost: number }).monthly_cost) || 0),
    0,
  );
  // Number rental is a monthly fee. Fold it into the period total scaled to
  // how many months the window spans (round(days/30)): a ~30-day window picks
  // up one month's rental, ~60 days two, and short windows (< ~2 weeks) none.
  const rentalMonths = Math.round(rangeLenDays / 30);
  const numberRentalInPeriod = monthlyNumberCost * rentalMonths;

  // Owners are only needed by the Per-user rollup. Admin gate the
  // lookup the same way as before so members can't enumerate owners.
  let ownerName = new Map<string, string>();
  if (view === "per_user") {
    const { data: me } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (me?.role === "admin") {
      const { data: people } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .order("full_name");
      ownerName = new Map(
        (people ?? []).map(
          (p) => [p.id, p.full_name || p.email || "—"] as const,
        ),
      );
    }
  }
  const campaignName = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );
  const listName = new Map((lists ?? []).map((l) => [l.id, l.name] as const));

  const summary = rollupByVendor(rows);
  const totalCalls = rows.length;
  const totalGoalMet = rows.filter((r) => r.goal_met).length;
  const dailyBuckets = rollupByTime(rows, slicers);
  const dailySpend = dailyBuckets.map((b) => b.spend);
  const mockMode = isMockMode();
  const rangeLabel = fmtRangeLabel(from, to);

  // Period total INCLUDING the number rental and import-lookup spend for this
  // window — what the headline and "Total spend" tile report. Per-call rollups
  // (per-campaign, per-list, …) stay call-only since neither is attributable
  // per call.
  const periodTotal = summary.total + numberRentalInPeriod + importLookupCost;

  // vs-previous-period delta on total spend. null when there was no
  // spend in the prior window to compare against (avoids a fake ▲). The
  // rental is constant across equal-length windows; import-lookup spend is
  // compared window-to-window.
  const prevTotal = rollupByVendor(prevRows).total;
  const prevPeriodTotal =
    prevTotal + numberRentalInPeriod + prevImportLookupCost;
  const spendDelta =
    prevPeriodTotal > 0
      ? (periodTotal - prevPeriodTotal) / prevPeriodTotal
      : null;

  // Efficiency KPIs (call-only spend) and the top-campaigns-by-spend list.
  const perCall = totalCalls === 0 ? 0 : summary.total / totalCalls;
  const perGoal = totalGoalMet === 0 ? null : summary.total / totalGoalMet;
  const campaignRollup = rollupByCampaign(rows);
  const topCampaigns = campaignRollup
    .slice()
    .sort((a, b) => b.spend.total - a.spend.total)
    .slice(0, 5)
    .map((c) => ({
      campaignId: c.campaignId,
      name: campaignName.get(c.campaignId) ?? "—",
      spend: c.spend.total,
      goalMet: c.goalMet,
      costPerGoalMet: c.costPerGoalMet,
    }));

  // Nearest campaign to its spend cap — a workspace-level risk signal
  // surfaced regardless of which view is active. Only flagged once a
  // cap crosses 75% so the callout means "act soon", not noise.
  let nearestCap: { name: string; pct: number; label: string } | null = null;
  for (const c of campaignCaps.values()) {
    const hasDay = c.dailySpendCap != null && c.dailySpendCap > 0;
    const hasMonth = c.monthlySpendCap != null && c.monthlySpendCap > 0;
    if (!hasDay && !hasMonth) continue;
    const dayPct = hasDay
      ? (c.daySpend / (c.dailySpendCap as number)) * 100
      : 0;
    const monthPct = hasMonth
      ? (c.monthSpend / (c.monthlySpendCap as number)) * 100
      : 0;
    const useMonth = hasMonth && (monthPct >= dayPct || !hasDay);
    const pct = useMonth ? monthPct : dayPct;
    if (!nearestCap || pct > nearestCap.pct) {
      nearestCap = { name: c.name, pct, label: useMonth ? "monthly" : "daily" };
    }
  }
  const capAlert = nearestCap && nearestCap.pct >= 75 ? nearestCap : null;

  // Build URL for tab navigation that preserves slicers.
  function buildViewHref(nextView: string): string {
    const url = new URLSearchParams();
    url.set("view", nextView);
    url.set("preset", preset);
    if (preset === "custom") {
      if (from) url.set("from", from);
      if (to) url.set("to", to);
    }
    if (campaignId) url.set("campaign", campaignId);
    if (listId) url.set("list", listId);
    if (ownerId) url.set("user", ownerId);
    return `/costs?${url.toString()}`;
  }

  // Build the export URL with the same slicers in flight.
  const exportParams = new URLSearchParams();
  exportParams.set("preset", preset);
  if (preset === "custom") {
    if (from) exportParams.set("from", from);
    if (to) exportParams.set("to", to);
  }
  if (campaignId) exportParams.set("campaign", campaignId);
  if (listId) exportParams.set("list", listId);
  if (ownerId) exportParams.set("user", ownerId);
  const exportHref = `/costs/export?${exportParams.toString()}`;

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* Header — title left, MTD / Today context badges + Export
       *  right. Mirrors the analytics header pattern. */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-foreground text-2xl font-bold tracking-tight">
              Costs{" "}
              <span className="text-muted-foreground font-normal">
                · {rangeLabel}
              </span>
            </h1>
            <p className="text-muted-foreground mt-0.5 text-sm">
              {totalCalls.toLocaleString()}{" "}
              {totalCalls === 1 ? "call" : "calls"} ·{" "}
              <span className="text-foreground font-medium">
                {usd(periodTotal)}
              </span>{" "}
              total
            </p>
          </div>
          <Button asChild variant="outline">
            <a href={exportHref} download>
              <Download className="size-4" />
              Export CSV
            </a>
          </Button>
        </div>

        <CostsDatePills
          current={preset}
          initialFrom={customFromInput ?? from}
          initialTo={customToInput ?? to}
        />
      </div>

      {mockMode ? (
        <div
          data-testid="mock-data-banner"
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
        >
          <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <p className="text-foreground font-medium">
              You&apos;re viewing mock cost data
            </p>
            <p className="text-muted-foreground text-xs">
              Twilio, ElevenLabs, and OpenAI are all running in simulated mode.
              Cents-per-row, totals, and caps are seeded for design and QA — not
              real billable activity.
            </p>
          </div>
        </div>
      ) : null}

      <CostsHero
        total={periodTotal}
        spendDelta={spendDelta}
        projectedMonthSpend={
          headlineStats.projectedMonthSpend + monthlyNumberCost
        }
        todaySpend={headlineStats.todaySpend}
        daily={dailySpend}
      />

      <CostsKpiStrip
        perGoal={perGoal}
        perCall={perCall}
        goalMet={totalGoalMet}
        totalCalls={totalCalls}
      />

      {capAlert ? (
        <div
          data-testid="costs-cap-alert"
          className={`flex items-center gap-2.5 rounded-lg border px-4 py-2.5 text-sm ${
            capAlert.pct >= 90
              ? "border-destructive/30 bg-destructive/5 text-destructive"
              : "text-primary border-primary/30 bg-primary/5"
          }`}
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span>
            <span className="font-semibold">{capAlert.name}</span> is at{" "}
            <span className="font-semibold tabular-nums">
              {capAlert.pct.toFixed(0)}%
            </span>{" "}
            of its {capAlert.label} spend cap.{" "}
            <Link
              href="/costs?view=per_campaign"
              className="underline underline-offset-4"
            >
              Review campaigns
            </Link>
          </span>
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <CostsVendorBreakdown
          summary={summary}
          extraLookupCost={importLookupCost}
          monthlyNumberCost={monthlyNumberCost}
          numberCount={numberCount}
        />
        <CostsTopCampaigns items={topCampaigns} />
      </div>

      <CostsViewTabs current={view} buildHref={buildViewHref} />

      {view === "per_call" ? (
        <PerCallTable
          rows={rows.slice(0, 100)}
          campaignName={campaignName}
          now={new Date().toISOString()}
        />
      ) : null}
      {view === "per_campaign" ? (
        <PerCampaignView
          rows={rows}
          campaignName={campaignName}
          campaignCaps={campaignCaps}
          totalSpend={summary.total}
        />
      ) : null}
      {view === "per_list" ? (
        <PerListView
          rows={rows}
          listName={listName}
          supabase={supabase}
          totalSpend={summary.total}
        />
      ) : null}
      {view === "per_goal" ? (
        <PerGoalView rows={rows} campaignName={campaignName} />
      ) : null}
      {view === "per_user" ? (
        <PerUserView rows={rows} ownerName={ownerName} supabase={supabase} />
      ) : null}
      {view === "per_time" ? <PerTimeChart data={dailyBuckets} /> : null}
    </div>
  );
}

function EmptyState({ headline, hint }: { headline: string; hint: string }) {
  return (
    <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
      <p className="text-foreground text-sm font-medium">{headline}</p>
      <p className="text-muted-foreground max-w-xs text-sm">{hint}</p>
    </div>
  );
}

function PerCampaignView({
  rows,
  campaignName,
  campaignCaps,
  totalSpend,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  campaignName: Map<string, string>;
  campaignCaps: Awaited<ReturnType<typeof fetchCampaignCaps>>;
  totalSpend: number;
}) {
  const data = rollupByCampaign(rows);
  if (data.length === 0) {
    return (
      <EmptyState
        headline="No campaigns active in this range"
        hint="Widen the date range or remove the campaign filter."
      />
    );
  }
  const maxSpend = Math.max(0.01, ...data.map((d) => d.spend.total));
  const totalCalls = data.reduce((a, b) => a + b.calls, 0);
  const totalGoalMet = data.reduce((a, b) => a + b.goalMet, 0);
  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-campaign-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campaign</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Goal Met</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Avg / call</TableHead>
            <TableHead className="text-right">Cost / Goal Met</TableHead>
            <TableHead className="text-right">Cap</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => {
            const name = campaignName.get(d.campaignId) ?? "—";
            const barPct = (d.spend.total / maxSpend) * 100;
            const goalTone =
              d.goalMet === 0
                ? "text-muted-foreground"
                : "text-foreground font-medium";
            return (
              <TableRow key={d.campaignId} className="group">
                <TableCell>
                  <Link
                    href={`/calls?campaign=${d.campaignId}`}
                    className="text-foreground hover:text-foreground/80 font-medium underline-offset-4 hover:underline"
                  >
                    {name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {d.calls.toLocaleString()}
                </TableCell>
                <TableCell className={`text-right tabular-nums ${goalTone}`}>
                  {d.goalMet.toLocaleString()}
                </TableCell>
                <TableCell className="text-foreground text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="font-medium tabular-nums">
                      {usd(d.spend.total)}
                    </span>
                    <div className="bg-muted h-1 w-24 overflow-hidden rounded">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(2, barPct)}%`,
                          background: "var(--primary)",
                        }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {usd(d.avgPerCall)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {d.goalMet === 0 ? "—" : usd(d.costPerGoalMet)}
                </TableCell>
                <TableCell className="text-right">
                  <BudgetProgress cap={campaignCaps.get(d.campaignId)} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Total
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalCalls.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalGoalMet.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {usd(totalSpend)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {totalCalls === 0 ? "—" : usd(totalSpend / totalCalls)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {totalGoalMet === 0 ? "—" : usd(totalSpend / totalGoalMet)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right">
              —
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function PerGoalView({
  rows,
  campaignName,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  campaignName: Map<string, string>;
}) {
  const data = rollupByGoalMet(rows);
  if (data.length === 0) {
    return (
      <EmptyState
        headline="No Goal Met calls in this range yet"
        hint="Widen the date range, or check whether the campaigns are configured with a goal."
      />
    );
  }
  const maxSpend = Math.max(0.01, ...data.map((d) => d.spend));
  const totalGoals = data.reduce((a, b) => a + b.goalMet, 0);
  const totalSpend = data.reduce((a, b) => a + b.spend, 0);
  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-goal-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Campaign</TableHead>
            <TableHead className="text-right">Goal Met</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Cost / Goal Met</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => {
            const barPct = (d.spend / maxSpend) * 100;
            return (
              <TableRow key={d.campaignId}>
                <TableCell>
                  <Link
                    href={`/calls?campaign=${d.campaignId}&goal=met`}
                    className="text-foreground hover:text-foreground/80 font-medium underline-offset-4 hover:underline"
                  >
                    {campaignName.get(d.campaignId) ?? "—"}
                  </Link>
                </TableCell>
                <TableCell className="text-foreground text-right tabular-nums">
                  {d.goalMet}
                </TableCell>
                <TableCell className="text-foreground text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="font-medium tabular-nums">
                      {usd(d.spend)}
                    </span>
                    <div className="bg-muted h-1 w-24 overflow-hidden rounded">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(2, barPct)}%`,
                          background: "var(--primary)",
                        }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {usd(d.costPerGoalMet)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Total
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalGoals.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {usd(totalSpend)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {totalGoals === 0 ? "—" : usd(totalSpend / totalGoals)}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

async function PerUserView({
  rows,
  ownerName,
  supabase,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  ownerName: Map<string, string>;
  supabase: Awaited<ReturnType<typeof createClient>>;
}) {
  const data = await rollupByUser(supabase, rows);
  if (data.length === 0) {
    return (
      <EmptyState
        headline="No spend by user in this range"
        hint="Either nobody made calls, or the user filter is too narrow."
      />
    );
  }
  const maxSpend = Math.max(0.01, ...data.map((d) => d.spend));
  const totalCalls = data.reduce((a, b) => a + b.calls, 0);
  const totalSpend = data.reduce((a, b) => a + b.spend, 0);
  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-user-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Share</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => {
            const barPct = (d.spend / maxSpend) * 100;
            const share = totalSpend === 0 ? 0 : d.spend / totalSpend;
            return (
              <TableRow key={d.ownerId}>
                <TableCell className="text-foreground font-medium">
                  {ownerName.get(d.ownerId) ?? "—"}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {d.calls.toLocaleString()}
                </TableCell>
                <TableCell className="text-foreground text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="font-medium tabular-nums">
                      {usd(d.spend)}
                    </span>
                    <div className="bg-muted h-1 w-24 overflow-hidden rounded">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(2, barPct)}%`,
                          background: "var(--primary)",
                        }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {(share * 100).toFixed(0)}%
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Total
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalCalls.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {usd(totalSpend)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right">
              —
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

async function PerListView({
  rows,
  listName,
  supabase,
  totalSpend,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  listName: Map<string, string>;
  supabase: Awaited<ReturnType<typeof createClient>>;
  totalSpend: number;
}) {
  const data = await rollupByList(supabase, rows);
  if (data.length === 0) {
    return (
      <EmptyState
        headline="No spend by list in this range"
        hint="Either no calls happened on a list's leads, or the date range is too narrow."
      />
    );
  }
  const maxSpend = Math.max(0.01, ...data.map((d) => d.spend));
  const totalCalls = data.reduce((a, b) => a + b.calls, 0);
  const totalGoalMet = data.reduce((a, b) => a + b.goalMet, 0);
  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-list-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>List</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Goal Met</TableHead>
            <TableHead className="text-right">Spend</TableHead>
            <TableHead className="text-right">Share</TableHead>
            <TableHead className="text-right">Cost / Goal Met</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => {
            const name = listName.get(d.listId) ?? "—";
            const share = totalSpend === 0 ? 0 : d.spend / totalSpend;
            const barPct = (d.spend / maxSpend) * 100;
            const goalTone =
              d.goalMet === 0
                ? "text-muted-foreground"
                : "text-foreground font-medium";
            return (
              <TableRow key={d.listId}>
                <TableCell>
                  <Link
                    href={`/leads?list=${d.listId}`}
                    className="text-foreground hover:text-foreground/80 font-medium underline-offset-4 hover:underline"
                  >
                    {name}
                  </Link>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {d.calls.toLocaleString()}
                </TableCell>
                <TableCell className={`text-right tabular-nums ${goalTone}`}>
                  {d.goalMet.toLocaleString()}
                </TableCell>
                <TableCell className="text-foreground text-right">
                  <div className="flex flex-col items-end gap-1">
                    <span className="font-medium tabular-nums">
                      ${d.spend.toFixed(2)}
                    </span>
                    <div className="bg-muted h-1 w-24 overflow-hidden rounded">
                      <div
                        className="h-full"
                        style={{
                          width: `${Math.max(2, barPct)}%`,
                          background: "var(--primary)",
                        }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {(share * 100).toFixed(0)}%
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {d.goalMet === 0
                    ? "—"
                    : `$${(d.spend / d.goalMet).toFixed(2)}`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Total
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalCalls.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              {totalGoalMet.toLocaleString()}
            </TableCell>
            <TableCell className="text-foreground text-right font-semibold tabular-nums">
              ${totalSpend.toFixed(2)}
            </TableCell>
            <TableCell className="text-muted-foreground text-right">
              —
            </TableCell>
            <TableCell className="text-muted-foreground text-right tabular-nums">
              {totalGoalMet === 0
                ? "—"
                : `$${(totalSpend / totalGoalMet).toFixed(2)}`}
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
