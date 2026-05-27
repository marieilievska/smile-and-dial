import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

import { BookingsOverTime } from "./bookings-over-time";
import { CampaignLeaderboard, FunnelChart, OutcomeBreakdown } from "./charts";
import { HeroKpi } from "./hero-kpi";
import { KpiTile } from "./kpi-tile";

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom" },
];

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
  const { from, to } = resolveDatePreset(preset, {
    from: DATE_RE.test(str(params.from)) ? str(params.from) : undefined,
    to: DATE_RE.test(str(params.to)) ? str(params.to) : undefined,
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

  const mockMode = isMockMode();

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Analytics
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Appointments and pipeline performance · {from} → {to} ·{" "}
          {kpis.totalCalls.toLocaleString()} calls
          {compare ? " · comparing to prior period" : ""}
        </p>
      </div>

      <form
        method="get"
        action="/analytics"
        className="flex flex-wrap items-end gap-2"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="ana-preset">Date range</Label>
          <Select name="preset" defaultValue={preset}>
            <SelectTrigger id="ana-preset" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {preset === "custom" ? (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ana-from">From</Label>
              <Input
                id="ana-from"
                name="from"
                type="date"
                defaultValue={from}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="ana-to">To</Label>
              <Input
                id="ana-to"
                name="to"
                type="date"
                defaultValue={to}
                className="w-44"
              />
            </div>
          </>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="ana-campaign">Campaign</Label>
          <Select name="campaign" defaultValue={campaignId ?? "__any__"}>
            <SelectTrigger id="ana-campaign" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {(campaigns ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="ana-list">List</Label>
          <Select name="list" defaultValue={listId ?? "__any__"}>
            <SelectTrigger id="ana-list" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__any__">Any</SelectItem>
              {(lists ?? []).map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isAdmin ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor="ana-user">User</Label>
            <Select name="user" defaultValue={ownerId ?? "__any__"}>
              <SelectTrigger id="ana-user" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__any__">Any</SelectItem>
                {owners.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="ana-compare">Compare</Label>
          <Select name="compare" defaultValue={compare ? "1" : "0"}>
            <SelectTrigger id="ana-compare" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">vs prior period</SelectItem>
              <SelectItem value="0">No comparison</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      {/* Layer 1 — Executive summary: NSM + 3 supporting KPIs */}
      <Link href={goalMetCallsHref} className="block">
        <HeroKpi
          label="Appointments Booked"
          value={kpis.goalMet.toLocaleString()}
          priorValue={prior?.goalMet ?? null}
          deltaPct={prior ? pctDelta(kpis.goalMet, prior.goalMet) : undefined}
          sparkline={dailyBookings}
          helper="Calls where the AI agent successfully booked a meeting"
        />
      </Link>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiTile
          label="Conversations"
          value={kpis.conversations.toLocaleString()}
          hint="Calls where we reached someone"
          pctDelta={
            prior
              ? pctDelta(kpis.conversations, prior.conversations)
              : undefined
          }
        />
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
          />
        </Link>
      </div>

      <BookingsOverTime daily={dailyBookings} />

      {/* Layer 2 — Clarification */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="border-border bg-card rounded-lg border p-4">
          <h2 className="text-foreground text-sm font-semibold">
            Conversion funnel
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Dialed → Connected → Conversation → DMs reached → Goal Met
          </p>
          <FunnelChart steps={funnel} />
        </section>

        <section className="border-border bg-card rounded-lg border p-4">
          <h2 className="text-foreground text-sm font-semibold">
            Top campaigns
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Sorted by Goal Met. Click a row to see the underlying calls.
          </p>
          <CampaignLeaderboard rows={ranking} />
        </section>

        <section className="border-border bg-card col-span-1 rounded-lg border p-4 lg:col-span-2">
          <h2 className="text-foreground text-sm font-semibold">
            Outcome distribution
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            All call outcomes in this range.
          </p>
          <OutcomeBreakdown buckets={outcomeBuckets} total={kpis.totalCalls} />
        </section>
      </div>

      {/* Inventory strip — replaces the 5 lower-priority equal-weight tiles */}
      <p
        data-testid="inventory-strip"
        className="text-muted-foreground text-sm"
      >
        <span className="text-foreground font-medium">
          Also in this period:
        </span>{" "}
        {kpis.dmsReached.toLocaleString()} DMs reached ·{" "}
        {kpis.callbacksScheduled.toLocaleString()} callbacks scheduled ·{" "}
        {kpis.dncAdditions.toLocaleString()} DNC additions ·{" "}
        {fmtSeconds(kpis.avgDurationSeconds)} avg call ·{" "}
        {fmtUsd(kpis.avgCostPerCall)} avg cost per call ·{" "}
        {fmtUsd(kpis.totalSpend)} total spend
        {mockMode ? (
          <span className="text-muted-foreground/80"> (mock data)</span>
        ) : null}
      </p>
    </div>
  );
}
