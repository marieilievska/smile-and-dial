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
  buildFunnel,
  callsByDay,
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

import {
  CallsOverTime,
  CampaignLeaderboard,
  FunnelChart,
  OutcomeBreakdown,
} from "./charts";
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
  return `${(value * 100).toFixed(0)}%`;
}

function fmtUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
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
  const compare = str(params.compare) === "1";

  const slicers: Slicers = { from, to, campaignId, ownerId, listId };

  // Pull rows for the current and (optionally) prior periods in parallel.
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
  const funnel = buildFunnel(rows);
  const outcomeBuckets = outcomeDistribution(rows);
  const timeSeries = callsByDay(rows, slicers);
  const campaignNames = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );
  const ranking = rankCampaigns(rows, campaignNames);

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Analytics
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {from} → {to} · {kpis.totalCalls.toLocaleString()} calls
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
            <SelectTrigger id="ana-compare" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">No comparison</SelectItem>
              <SelectItem value="1">vs prior period</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <KpiTile
          label="Total calls"
          value={kpis.totalCalls.toLocaleString()}
          pctDelta={
            prior ? pctDelta(kpis.totalCalls, prior.totalCalls) : undefined
          }
        />
        <KpiTile
          label="Conversations"
          value={kpis.conversations.toLocaleString()}
          hint=">60s talk time outcomes"
          pctDelta={
            prior
              ? pctDelta(kpis.conversations, prior.conversations)
              : undefined
          }
        />
        <KpiTile
          label="DMs reached"
          value={kpis.dmsReached.toLocaleString()}
          pctDelta={
            prior ? pctDelta(kpis.dmsReached, prior.dmsReached) : undefined
          }
        />
        <KpiTile
          label="Connect rate"
          value={fmtPct(kpis.connectRate)}
          pctDelta={
            prior ? pctDelta(kpis.connectRate, prior.connectRate) : undefined
          }
        />
        <KpiTile
          label="Goal Met"
          value={kpis.goalMet.toLocaleString()}
          pctDelta={prior ? pctDelta(kpis.goalMet, prior.goalMet) : undefined}
        />
        <KpiTile
          label="Goal Met rate"
          value={fmtPct(kpis.goalMetRate)}
          hint="of conversations"
          pctDelta={
            prior ? pctDelta(kpis.goalMetRate, prior.goalMetRate) : undefined
          }
        />
        <KpiTile
          label="Avg call duration"
          value={fmtSeconds(kpis.avgDurationSeconds)}
          pctDelta={
            prior
              ? pctDelta(kpis.avgDurationSeconds, prior.avgDurationSeconds)
              : undefined
          }
        />
        <KpiTile
          label="Avg cost / call"
          value={fmtUsd(kpis.avgCostPerCall)}
          pctDelta={
            prior
              ? pctDelta(kpis.avgCostPerCall, prior.avgCostPerCall)
              : undefined
          }
        />
        <KpiTile
          label="Cost / Goal Met"
          value={fmtUsd(kpis.costPerGoalMet)}
          pctDelta={
            prior
              ? pctDelta(kpis.costPerGoalMet, prior.costPerGoalMet)
              : undefined
          }
        />
        <KpiTile
          label="Callbacks scheduled"
          value={kpis.callbacksScheduled.toLocaleString()}
          pctDelta={
            prior
              ? pctDelta(kpis.callbacksScheduled, prior.callbacksScheduled)
              : undefined
          }
        />
        <KpiTile
          label="DNC additions"
          value={kpis.dncAdditions.toLocaleString()}
          pctDelta={
            prior ? pctDelta(kpis.dncAdditions, prior.dncAdditions) : undefined
          }
        />
        <KpiTile
          label="Total spend"
          value={fmtUsd(kpis.totalSpend)}
          pctDelta={
            prior ? pctDelta(kpis.totalSpend, prior.totalSpend) : undefined
          }
        />
      </div>

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
            Outcome distribution
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            All call outcomes in this range.
          </p>
          <OutcomeBreakdown buckets={outcomeBuckets} total={kpis.totalCalls} />
        </section>

        <section className="border-border bg-card col-span-1 rounded-lg border p-4 lg:col-span-2">
          <h2 className="text-foreground text-sm font-semibold">
            Calls over time
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Daily call volume across the selected range.
          </p>
          <CallsOverTime buckets={timeSeries} />
        </section>

        <section className="border-border bg-card col-span-1 rounded-lg border p-4 lg:col-span-2">
          <h2 className="text-foreground text-sm font-semibold">
            Best performing campaigns
          </h2>
          <p className="text-muted-foreground mt-1 mb-3 text-xs">
            Sorted by Goal Met. Cost per Goal Met shown where available.
          </p>
          <CampaignLeaderboard rows={ranking} />
        </section>
      </div>
    </div>
  );
}
