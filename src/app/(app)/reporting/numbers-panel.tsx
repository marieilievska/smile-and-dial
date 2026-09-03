import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import { regionForAreaCode } from "@/lib/dialer/nanp-states";
import { fetchAllRows } from "@/lib/supabase/fetch-all-rows";
import { createClient } from "@/lib/supabase/server";
import { etDateDaysAgo, etMidnightUtcIso } from "@/lib/time/eastern";

// Shared with the Twilio numbers settings page — a pure presentational
// sparkline, so both surfaces read the same shape and can't drift.
import {
  ConnectRateTrend,
  type DailyStat,
} from "../settings/twilio-numbers/connect-rate-trend";

/**
 * The "Numbers" tab: how each phone number is actually performing, and whether
 * local presence is earning its keep.
 *
 * The local-presence scoreboard at the top is the point of the tab. Buying a
 * number per state is only worth doing if a caller ID that looks local actually
 * connects better, and until `calls.local_match` existed that question could
 * only be answered by hand-joining the database. Read it before spending.
 */

/** A call is "connected" when a PERSON picked up — the app-wide
 *  CONNECTED_OUTCOMES list (outcomes.ts), the same one the Today, Calls,
 *  Reporting and Analytics connect rates use. The SQL behind the trend
 *  sparkline / 24h figure (refresh_twilio_number_daily_stats,
 *  monitor_twilio_connect_rates) mirrors that list; keep them in step. The old
 *  local "everything except voicemail/no_answer/busy/failed/invalid_number"
 *  rule counted an AI receptionist bot answering as a connection. */

type Row = { calls: number; connected: number };

function rate(r: Row): number | null {
  return r.calls > 0 ? r.connected / r.calls : null;
}

function pct(v: number | null): string {
  return v === null ? "—" : `${(v * 100).toFixed(1)}%`;
}

const MATCH_LABEL: Record<string, string> = {
  exact: "Same area code",
  state: "Same state / province",
  none: "Not local",
};

const MATCH_HELP: Record<string, string> = {
  exact: "The caller ID shares the lead's own area code.",
  state: "Different area code, same state or province.",
  none: "Out of state — no local presence at all.",
};

export async function NumbersPanel({ days = 30 }: { days?: number }) {
  const supabase = await createClient();
  const now = new Date();
  // Whole Eastern days on created_at — the app-wide "calls" window/column.
  const since = etMidnightUtcIso(etDateDaysAgo(days, now));

  // Outbound calls in the window, with the tier recorded at placement.
  // Paginate: PostgREST hard-caps every response at 1,000 rows, so a plain
  // select would quietly undercount once volume builds.
  type CallRow = {
    outcome: string | null;
    local_match: string | null;
    dest_country: string | null;
    twilio_number_id: string | null;
  };
  const calls: CallRow[] = [];
  for (let from = 0; from < 100_000; from += 1000) {
    const { data } = await supabase
      .from("calls")
      .select("outcome, local_match, dest_country, twilio_number_id")
      .eq("direction", "outbound")
      .gte("created_at", since)
      .range(from, from + 999);
    const page = (data ?? []) as CallRow[];
    calls.push(...page);
    if (page.length < 1000) break;
  }

  const byMatch = new Map<string, Row>();
  const byCountry = new Map<string, Row>();
  const byNumber = new Map<string, Row>();
  for (const c of calls) {
    // ai_error = OUR quota/platform failure, not a real call — exclude it from
    // both the connected count AND the denominator so an EL credit outage
    // doesn't distort a number's connect rate.
    if (c.outcome === "ai_error") continue;
    const connected = c.outcome !== null && CONNECTED_OUTCOMES.has(c.outcome);
    const bump = (m: Map<string, Row>, k: string) => {
      const r = m.get(k) ?? { calls: 0, connected: 0 };
      r.calls++;
      if (connected) r.connected++;
      m.set(k, r);
    };
    // Only calls placed since local_match started being recorded can answer the
    // local-presence question; older rows are null and are excluded rather than
    // lumped in as "not local", which would understate the baseline.
    if (c.local_match) bump(byMatch, c.local_match);
    if (c.dest_country) bump(byCountry, c.dest_country);
    if (c.twilio_number_id) bump(byNumber, c.twilio_number_id);
  }

  const { data: numberRows } = await supabase
    .from("twilio_numbers")
    .select(
      "id, phone_number, area_code, pool_status, rested_until, flagged_for_rotation, released_at, attached_campaign_id, last_connect_rate_24h, last_calls_count_24h",
    )
    .is("released_at", null)
    .order("area_code");
  const numbers = numberRows ?? [];

  const { data: campaignRows } = await supabase
    .from("campaigns")
    .select("id, name");
  const campaignName = new Map((campaignRows ?? []).map((c) => [c.id, c.name]));

  // 14-day history for the sparkline, oldest first.
  const historySince = etDateDaysAgo(14);
  // Paged: 14 days × N numbers passes PostgREST's 1,000-row cap at ~72
  // numbers, and the rows dropped were the newest — exactly the ones shown.
  const statRows = await fetchAllRows((from, to) =>
    supabase
      .from("twilio_number_daily_stats")
      .select("twilio_number_id, day, calls, connected, connect_rate")
      .gte("day", historySince)
      .order("day", { ascending: true })
      .order("twilio_number_id", { ascending: true })
      .range(from, to),
  );
  const historyByNumber = new Map<string, DailyStat[]>();
  for (const s of statRows) {
    const list = historyByNumber.get(s.twilio_number_id) ?? [];
    list.push({
      day: s.day,
      calls: s.calls,
      connected: s.connected,
      rate: s.connect_rate === null ? null : Number(s.connect_rate),
    });
    historyByNumber.set(s.twilio_number_id, list);
  }

  const matched = ["exact", "state"].reduce(
    (acc, k) => {
      const r = byMatch.get(k);
      if (r) {
        acc.calls += r.calls;
        acc.connected += r.connected;
      }
      return acc;
    },
    { calls: 0, connected: 0 } as Row,
  );
  const notLocal = byMatch.get("none") ?? { calls: 0, connected: 0 };
  const lift =
    rate(matched) !== null && rate(notLocal) !== null && rate(notLocal)! > 0
      ? rate(matched)! / rate(notLocal)!
      : null;

  const totalTiered = [...byMatch.values()].reduce((s, r) => s + r.calls, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* ---- Does local presence actually work? ---- */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            Is local presence working?
          </h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Connect rate by how local the caller ID was to the lead, over the
            last {days} days. This is the number that decides whether buying
            more local numbers is worth it.
          </p>
        </div>

        {totalTiered === 0 ? (
          <p className="text-muted-foreground border-border rounded-xl border border-dashed px-4 py-6 text-sm">
            No calls yet carry a local-presence tier. Every call placed from
            2026-07-29 onward records one, so this fills in as the dialer runs.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {["exact", "state", "none"].map((key) => {
                const r = byMatch.get(key) ?? { calls: 0, connected: 0 };
                return (
                  <div
                    key={key}
                    className="border-border flex flex-col gap-1 rounded-xl border p-4"
                  >
                    <span className="text-muted-foreground text-xs font-medium">
                      {MATCH_LABEL[key]}
                    </span>
                    <span className="text-foreground text-2xl font-semibold tabular-nums">
                      {pct(rate(r))}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {r.connected} of {r.calls} call{r.calls === 1 ? "" : "s"}
                    </span>
                    <span className="text-muted-foreground/80 mt-1 text-[11px] leading-snug">
                      {MATCH_HELP[key]}
                    </span>
                  </div>
                );
              })}
            </div>
            {lift !== null && matched.calls > 0 ? (
              <p className="text-muted-foreground text-sm">
                A local caller ID is connecting{" "}
                <span className="text-foreground font-semibold">
                  {lift.toFixed(2)}×
                </span>{" "}
                as often as an out-of-state one ({matched.calls} local vs{" "}
                {notLocal.calls} not).{" "}
                {matched.calls < 100 ? (
                  <span className="text-warning">
                    Small sample so far — treat as directional until it passes a
                    few hundred local calls.
                  </span>
                ) : null}
              </p>
            ) : null}
          </>
        )}
      </section>

      {/* ---- US vs Canada ---- */}
      {byCountry.size > 0 ? (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-foreground text-lg font-semibold">
              Where we&apos;re dialing
            </h2>
            <p className="text-muted-foreground mt-0.5 text-sm">
              Canadian leads are dialed after US ones, and answer very
              differently — worth watching separately so a bad mix never gets
              mistaken for a bad number.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {["US", "CA"].map((k) => {
              const r = byCountry.get(k);
              if (!r) return null;
              return (
                <div
                  key={k}
                  className="border-border flex flex-col gap-1 rounded-xl border p-4"
                >
                  <span className="text-muted-foreground text-xs font-medium">
                    {k === "US" ? "United States" : "Canada"}
                  </span>
                  <span className="text-foreground text-2xl font-semibold tabular-nums">
                    {pct(rate(r))}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {r.connected} of {r.calls} call{r.calls === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* ---- Per-number ---- */}
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-foreground text-lg font-semibold">
            Every number
          </h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            A number whose connect rate is sliding is going bad. Check what it
            has been calling before retiring it — a number that drew a hard lead
            mix looks identical to a burned one.
          </p>
        </div>
        <div className="border-border overflow-x-auto rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Region</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Calls ({days}d)</TableHead>
                <TableHead className="text-right">Connect</TableHead>
                <TableHead>Trend (14d)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {numbers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-muted-foreground py-8 text-center text-sm"
                  >
                    No numbers in the pool yet.
                  </TableCell>
                </TableRow>
              ) : (
                numbers.map((n) => {
                  const r = byNumber.get(n.id) ?? { calls: 0, connected: 0 };
                  const resting =
                    n.rested_until !== null &&
                    new Date(n.rested_until).getTime() > now.getTime();
                  const status = n.flagged_for_rotation
                    ? { label: "Flagged", variant: "destructive" as const }
                    : resting
                      ? { label: "Resting", variant: "secondary" as const }
                      : n.pool_status === "retired"
                        ? { label: "Retired", variant: "outline" as const }
                        : { label: "Active", variant: "default" as const };
                  return (
                    <TableRow key={n.id}>
                      <TableCell className="font-medium tabular-nums">
                        {n.phone_number}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {n.area_code ?? "—"}
                        {regionForAreaCode(n.area_code)
                          ? ` · ${regionForAreaCode(n.area_code)}`
                          : ""}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {n.attached_campaign_id
                          ? (campaignName.get(n.attached_campaign_id) ??
                            "Unknown")
                          : "Unattached"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={status.variant}>{status.label}</Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {r.calls}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {pct(rate(r))}
                      </TableCell>
                      <TableCell>
                        <ConnectRateTrend
                          days={historyByNumber.get(n.id) ?? []}
                          liveRate={n.last_connect_rate_24h}
                          liveCalls={n.last_calls_count_24h}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
