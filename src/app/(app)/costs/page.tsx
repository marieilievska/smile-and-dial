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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchCostRows,
  pickBreakdown,
  resolveDatePreset,
  rollupByCampaign,
  rollupByGoalMet,
  rollupByTime,
  rollupByUser,
  rollupByVendor,
  type Slicers,
} from "@/lib/analytics/costs";
import { createClient } from "@/lib/supabase/server";

const VIEWS = [
  { value: "per_call", label: "Per call" },
  { value: "per_campaign", label: "Per campaign" },
  { value: "per_goal", label: "Per goal met" },
  { value: "per_user", label: "Per user" },
  { value: "per_time", label: "Per day" },
  { value: "per_vendor", label: "Per vendor" },
];

const PRESETS = [
  { value: "today", label: "Today" },
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

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
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

  const view = VIEWS.some((v) => v.value === str(params.view))
    ? str(params.view)
    : "per_campaign";
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
  const slicers: Slicers = { from, to, campaignId, ownerId, listId };

  const [rows, { data: campaigns }, { data: lists }, { data: me }] =
    await Promise.all([
      fetchCostRows(supabase, slicers),
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
  const ownerName = new Map(owners.map((o) => [o.id, o.name] as const));
  const campaignName = new Map(
    (campaigns ?? []).map((c) => [c.id, c.name] as const),
  );

  // Headline summary across whatever the slicers selected.
  const summary = rollupByVendor(rows);
  const totalCalls = rows.length;

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Costs
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {from} → {to} · {totalCalls.toLocaleString()} calls ·{" "}
          {usd(summary.total)} total spend
        </p>
      </div>

      <form
        method="get"
        action="/costs"
        className="flex flex-wrap items-end gap-2"
      >
        <input type="hidden" name="view" value={view} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="c-preset">Date range</Label>
          <Select name="preset" defaultValue={preset}>
            <SelectTrigger id="c-preset" className="w-44">
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
              <Label htmlFor="c-from">From</Label>
              <Input
                id="c-from"
                name="from"
                type="date"
                defaultValue={from}
                className="w-44"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="c-to">To</Label>
              <Input
                id="c-to"
                name="to"
                type="date"
                defaultValue={to}
                className="w-44"
              />
            </div>
          </>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor="c-campaign">Campaign</Label>
          <Select name="campaign" defaultValue={campaignId ?? "__any__"}>
            <SelectTrigger id="c-campaign" className="w-52">
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
          <Label htmlFor="c-list">List</Label>
          <Select name="list" defaultValue={listId ?? "__any__"}>
            <SelectTrigger id="c-list" className="w-52">
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
            <Label htmlFor="c-user">User</Label>
            <Select name="user" defaultValue={ownerId ?? "__any__"}>
              <SelectTrigger id="c-user" className="w-52">
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

        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <div
        className="border-border bg-card flex flex-wrap gap-1 rounded-lg border p-1"
        data-testid="costs-view-tabs"
      >
        {VIEWS.map((v) => {
          const url = new URLSearchParams();
          url.set("view", v.value);
          url.set("preset", preset);
          if (preset === "custom") {
            url.set("from", from);
            url.set("to", to);
          }
          if (campaignId) url.set("campaign", campaignId);
          if (listId) url.set("list", listId);
          if (ownerId) url.set("user", ownerId);
          const active = view === v.value;
          return (
            <Button
              key={v.value}
              asChild
              variant={active ? "default" : "ghost"}
              size="sm"
              aria-current={active ? "page" : undefined}
            >
              <Link href={`/costs?${url.toString()}`}>{v.label}</Link>
            </Button>
          );
        })}
      </div>

      {view === "per_call" ? (
        <PerCallView rows={rows.slice(0, 100)} campaignName={campaignName} />
      ) : null}
      {view === "per_campaign" ? (
        <PerCampaignView rows={rows} campaignName={campaignName} />
      ) : null}
      {view === "per_goal" ? (
        <PerGoalView rows={rows} campaignName={campaignName} />
      ) : null}
      {view === "per_user" ? (
        <PerUserView rows={rows} ownerName={ownerName} supabase={supabase} />
      ) : null}
      {view === "per_time" ? (
        <PerTimeView rows={rows} slicers={slicers} />
      ) : null}
      {view === "per_vendor" ? <PerVendorView summary={summary} /> : null}
    </div>
  );
}

function PerCallView({
  rows,
  campaignName,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  campaignName: Map<string, string>;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No calls in this range.</p>
    );
  }
  return (
    <div
      className="border-border overflow-hidden rounded-lg border"
      data-testid="per-call-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Campaign</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Twilio</TableHead>
            <TableHead className="text-right">11Labs</TableHead>
            <TableHead className="text-right">OpenAI</TableHead>
            <TableHead className="text-right">Lookup</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const b = pickBreakdown(r.cost_breakdown);
            return (
              <TableRow key={r.id}>
                <TableCell className="text-muted-foreground text-xs">
                  {r.started_at
                    ? new Date(r.started_at).toLocaleString()
                    : new Date(r.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {campaignName.get(r.campaign_id) ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.duration_seconds ?? 0}s
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(b.twilio)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(b.elevenlabs)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(b.openai)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {usd(b.lookup)}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {usd(b.total)}
                </TableCell>
                <TableCell>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/calls?call=${r.id}`}>Open</Link>
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PerCampaignView({
  rows,
  campaignName,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  campaignName: Map<string, string>;
}) {
  const data = rollupByCampaign(rows);
  if (data.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No campaigns active in this range.
      </p>
    );
  }
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
            <TableHead className="text-right">Total spend</TableHead>
            <TableHead className="text-right">Avg / call</TableHead>
            <TableHead className="text-right">Cost / Goal Met</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => (
            <TableRow key={d.campaignId}>
              <TableCell className="font-medium">
                {campaignName.get(d.campaignId) ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {d.calls.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {d.goalMet.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd(d.spend.total)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd(d.avgPerCall)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {d.goalMet === 0 ? "—" : usd(d.costPerGoalMet)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
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
      <p className="text-muted-foreground text-sm">
        No Goal Met calls in this range yet.
      </p>
    );
  }
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
          {data.map((d) => (
            <TableRow key={d.campaignId}>
              <TableCell className="font-medium">
                {campaignName.get(d.campaignId) ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {d.goalMet}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd(d.spend)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd(d.costPerGoalMet)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
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
      <p className="text-muted-foreground text-sm">
        No spend by user in this range.
      </p>
    );
  }
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
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((d) => (
            <TableRow key={d.ownerId}>
              <TableCell className="font-medium">
                {ownerName.get(d.ownerId) ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {d.calls.toLocaleString()}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {usd(d.spend)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function PerTimeView({
  rows,
  slicers,
}: {
  rows: Awaited<ReturnType<typeof fetchCostRows>>;
  slicers: Slicers;
}) {
  const data = rollupByTime(rows, slicers);
  const max = Math.max(1, ...data.map((d) => d.spend));
  return (
    <div
      className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4"
      data-testid="per-time-chart"
    >
      <ul className="flex flex-col gap-2 text-sm">
        {data.map((d) => {
          const pct = (d.spend / max) * 100;
          return (
            <li key={d.day} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-foreground">{d.day}</span>
                <span className="text-muted-foreground tabular-nums">
                  {d.calls} calls · {usd(d.spend)}
                </span>
              </div>
              <div className="bg-muted h-2 w-full overflow-hidden rounded">
                <div
                  className="bg-primary h-full"
                  style={{ width: `${Math.max(d.spend > 0 ? 2 : 0, pct)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PerVendorView({
  summary,
}: {
  summary: ReturnType<typeof rollupByVendor>;
}) {
  const items: { label: string; key: keyof typeof summary; value: number }[] = [
    { label: "Twilio", key: "twilio", value: summary.twilio },
    { label: "ElevenLabs", key: "elevenlabs", value: summary.elevenlabs },
    { label: "OpenAI", key: "openai", value: summary.openai },
    { label: "Twilio Lookup", key: "lookup", value: summary.lookup },
  ];
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div
      className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4"
      data-testid="per-vendor-chart"
    >
      <p className="text-foreground text-sm font-semibold">
        Total across vendors: {usd(summary.total)}
      </p>
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((i) => {
          const pct = (i.value / max) * 100;
          const share =
            summary.total > 0
              ? `${((i.value / summary.total) * 100).toFixed(0)}%`
              : "—";
          return (
            <li key={i.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-foreground">{i.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {usd(i.value)} ({share})
                </span>
              </div>
              <div className="bg-muted h-3 w-full overflow-hidden rounded">
                <div
                  className="bg-primary h-full"
                  style={{ width: `${Math.max(i.value > 0 ? 2 : 0, pct)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
