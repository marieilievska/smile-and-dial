import { Info } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  bookingsByDay,
  buildFunnel,
  computeKpis,
  fetchCallsForRange,
  outcomeDistribution,
  pctDelta,
  previousPeriod,
  rankCampaigns,
  resolveDatePreset,
  type Slicers,
} from "@/lib/analytics/stats";
import { createClient } from "@/lib/supabase/server";

import { AnalyticsDatePills } from "./analytics-date-pills";
import { AnalyticsFilters } from "./analytics-filters";
import { BookingsOverTime } from "./bookings-over-time";
import { CampaignLeaderboard, FunnelChart, OutcomeBreakdown } from "./charts";
import { HeroKpi } from "./hero-kpi";
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
  const funnel = buildFunnel(rows);
  const outcomeBuckets = outcomeDistribution(rows);
  const campaignNames = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );
  const ranking = rankCampaigns(rows, campaignNames);

  // Build cross-page drill-down URLs that preserve the slicer state.
  const drillQs = new URLSearchParams();
  if (from) drillQs.set("from", from);
  if (to) drillQs.set("to", to);
  if (campaignId) drillQs.set("campaign", campaignId);
  if (listId) drillQs.set("list", listId);
  if (ownerId) drillQs.set("user", ownerId);
  const goalMetCallsHref = `/calls?${new URLSearchParams({
    ...Object.fromEntries(drillQs),
    outcome: "goal_met",
  }).toString()}`;
  const costsHref = `/costs?${new URLSearchParams({
    ...Object.fromEntries(drillQs),
    view: "per_campaign",
    preset: "custom",
  }).toString()}`;
  const conversationsHref = `/calls?${new URLSearchParams({
    ...Object.fromEntries(drillQs),
  }).toString()}`;

  const mockMode = isMockMode();
  const rangeLabel = fmtRangeLabel(from, to);

  return (
    <div className="flex flex-col gap-6 p-8">
      {/* Header row — title left, Filters popover right. The date pills
       *  sit below as their own row because date range is the primary
       *  axis of the page, not "yet another filter". */}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-foreground animate-in fade-in slide-in-from-bottom-1 fill-mode-both text-2xl font-bold tracking-tight duration-500">
              Analytics
            </h1>
            <p className="text-muted-foreground animate-in fade-in fill-mode-both mt-1 text-sm delay-75 duration-500">
              {rangeLabel} · {kpis.totalCalls.toLocaleString()}{" "}
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
          className="border-border bg-muted/40 animate-in fade-in fill-mode-both flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm delay-100 duration-500"
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

      {/* Layer 1 — Executive summary: NSM hero + 3 supporting KPIs in a
       *  unified strip so the eye reads them as one band. */}
      <section className="flex flex-col gap-3">
        <Link href={goalMetCallsHref} className="block">
          <HeroKpi
            label="Appointments Booked"
            value={kpis.goalMet.toLocaleString()}
            priorValue={prior?.goalMet ?? null}
            deltaPct={prior ? pctDelta(kpis.goalMet, prior.goalMet) : undefined}
            sparkline={dailyBookings}
            helper="Calls where the AI agent successfully booked a meeting"
            cta="View calls"
          />
        </Link>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Link href={conversationsHref} className="block">
            <KpiTile
              label="Conversations"
              value={kpis.conversations.toLocaleString()}
              hint="Calls where we reached someone"
              pctDelta={
                prior
                  ? pctDelta(kpis.conversations, prior.conversations)
                  : undefined
              }
              cta="View"
            />
          </Link>
          <KpiTile
            label="Goal Met Rate"
            value={fmtPct(kpis.goalMetRate)}
            hint="Of conversations that booked"
            pctDelta={
              prior ? pctDelta(kpis.goalMetRate, prior.goalMetRate) : undefined
            }
          />
          <Link href={costsHref} className="block">
            <KpiTile
              label="Cost per Appointment"
              value={kpis.goalMet === 0 ? "—" : fmtUsd(kpis.costPerGoalMet)}
              hint="All-in: Twilio + 11Labs + OpenAI"
              pctDelta={
                prior && kpis.goalMet > 0 && prior.goalMet > 0
                  ? pctDelta(kpis.costPerGoalMet, prior.costPerGoalMet)
                  : undefined
              }
              badge={mockMode ? { label: "Mock data", tone: "warn" } : null}
              cta="View costs"
            />
          </Link>
        </div>
      </section>

      <BookingsOverTime daily={dailyBookings} startDate={from} />

      {/* Layer 2 — Clarification */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both rounded-xl border p-5 delay-150 duration-500">
          <h2 className="text-foreground text-sm font-semibold">
            Conversion funnel
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Dialed → Connected → Conversation → DMs reached → Goal Met
          </p>
          <FunnelChart steps={funnel} />
        </section>

        <section className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both rounded-xl border p-5 delay-150 duration-500">
          <h2 className="text-foreground text-sm font-semibold">
            Top campaigns
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Sorted by Goal Met. Top 3 wear the medal.
          </p>
          <CampaignLeaderboard rows={ranking} />
        </section>

        <section className="border-border bg-card animate-in fade-in slide-in-from-bottom-1 fill-mode-both col-span-1 rounded-xl border p-5 delay-200 duration-500 lg:col-span-2">
          <h2 className="text-foreground text-sm font-semibold">
            Outcome distribution
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            All call outcomes in this range.
          </p>
          <OutcomeBreakdown buckets={outcomeBuckets} total={kpis.totalCalls} />
        </section>
      </div>

      {/* Inventory strip — six low-priority counts displayed as a grid of
       *  mini-tiles instead of a single run-on line. */}
      <section data-testid="inventory-strip" className="flex flex-col gap-2">
        <p className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
          Also in this period:
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
          <InventoryTile
            label="DMs reached"
            value={kpis.dmsReached.toLocaleString()}
          />
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
          <InventoryTile label="Total spend" value={fmtUsd(kpis.totalSpend)} />
        </div>
      </section>
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
