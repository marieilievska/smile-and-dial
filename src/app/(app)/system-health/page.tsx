import { Info, ListChecks } from "lucide-react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";

import { AutoRefresh } from "./auto-refresh";
import { SeverityTabs } from "./severity-tabs";
import {
  SystemEventsTable,
  type Severity,
  type SystemEvent,
} from "./system-events-table";
import { SystemHealthFilters } from "./system-health-filters";
import { SystemHealthStatStrip } from "./system-health-stat-strip";
import {
  countBySeverity,
  fetchSystemHealthStats,
  SEVERITY_BY_KIND_LOOKUP,
} from "./stats-query";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SEVERITY_FILTERS = ["any", "info", "warn", "error"] as const;
const RESULT_CAP = 200;

function str(v: string | string[] | undefined): string {
  return typeof v === "string" ? v : "";
}

function severityFor(kind: string): Severity {
  return SEVERITY_BY_KIND_LOOKUP[kind] ?? "info";
}

export default async function SystemHealthPage({
  searchParams,
}: {
  searchParams: Promise<{
    severity?: string;
    kind?: string;
    from?: string;
    to?: string;
    auto?: string;
  }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") redirect("/leads");

  const severity = (SEVERITY_FILTERS as readonly string[]).includes(
    str(params.severity),
  )
    ? str(params.severity)
    : "any";
  const kindFilter = str(params.kind).trim();
  const fromFilter = DATE_RE.test(str(params.from)) ? str(params.from) : "";
  const toFilter = DATE_RE.test(str(params.to)) ? str(params.to) : "";
  const auto = str(params.auto) === "1";

  // Fetch the events page (cap 200) + the headline stats in parallel.
  let query = supabase
    .from("system_events")
    .select("id, kind, actor_user_id, ref_table, ref_id, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(RESULT_CAP);
  if (kindFilter) query = query.eq("kind", kindFilter);
  if (fromFilter) query = query.gte("created_at", `${fromFilter}T00:00:00`);
  if (toFilter) query = query.lte("created_at", `${toFilter}T23:59:59`);

  const [{ data: rawEvents }, headlineStats] = await Promise.all([
    query,
    fetchSystemHealthStats(supabase),
  ]);
  let events = rawEvents ?? [];

  // Severity is derived, not indexed, so we post-filter after the DB
  // page (kind / date) has been applied.
  if (severity !== "any") {
    events = events.filter((e) => severityFor(e.kind) === severity);
  }

  // Pull actor names for whichever events have one.
  const actorIds = Array.from(
    new Set(
      events.map((e) => e.actor_user_id).filter((id): id is string => !!id),
    ),
  );
  const actorName = new Map<string, string>();
  if (actorIds.length > 0) {
    const { data: actors } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", actorIds);
    for (const a of actors ?? []) {
      actorName.set(a.id, a.full_name || a.email || a.id.slice(0, 6));
    }
  }

  // Decorate the events with severity + actor name for the client
  // component. Doing this on the server keeps the table dumb.
  const decorated: SystemEvent[] = events.map((e) => ({
    id: e.id,
    kind: e.kind,
    severity: severityFor(e.kind),
    actor_user_id: e.actor_user_id,
    actor_name: e.actor_user_id
      ? (actorName.get(e.actor_user_id) ?? null)
      : null,
    ref_table: e.ref_table,
    ref_id: e.ref_id,
    payload: e.payload,
    created_at: e.created_at,
  }));

  // Counts for the severity tab badges — sourced from the un-severity-
  // filtered events list so the badges reflect "how many of each
  // severity exist under the current kind/date filters", not "how many
  // of this severity match my current severity filter" (which would
  // always be 0 for the off-tabs).
  const tabCountSource = (rawEvents ?? []).map((e) => ({ kind: e.kind }));
  const counts = countBySeverity(tabCountSource);

  // Distinct kinds in the DB-paged window for the filter dropdown.
  const knownKinds = Array.from(
    new Set((rawEvents ?? []).map((e) => e.kind)),
  ).sort();

  // The 200-cap warning: we hit it only when the DB-page filled up
  // *and* the user hasn't narrowed enough to make the cap irrelevant.
  const cappedResults = (rawEvents?.length ?? 0) >= RESULT_CAP;

  function buildSeverityHref(nextSeverity: string): string {
    const url = new URLSearchParams();
    if (nextSeverity && nextSeverity !== "any") {
      url.set("severity", nextSeverity);
    }
    if (kindFilter) url.set("kind", kindFilter);
    if (fromFilter) url.set("from", fromFilter);
    if (toFilter) url.set("to", toFilter);
    if (auto) url.set("auto", "1");
    const qs = url.toString();
    return qs ? `/system-health?${qs}` : "/system-health";
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      {/* Header — title + count + auto-refresh controls. Auto-refresh
       *  graduates from a buried text link to a button pair in the
       *  header so an admin investigating an outage can see + drive
       *  it without scrolling. */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            System Health
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Last {RESULT_CAP} events ·{" "}
            <span className="text-foreground font-medium tabular-nums">
              {decorated.length.toLocaleString()}
            </span>{" "}
            match current filters
          </p>
        </div>
        <AutoRefresh enabled={auto} />
      </div>

      <SystemHealthStatStrip
        stats={headlineStats}
        now={new Date().toISOString()}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SeverityTabs
          current={severity}
          counts={counts}
          buildHref={buildSeverityHref}
        />
        <SystemHealthFilters knownKinds={knownKinds} />
      </div>

      {cappedResults ? (
        <div
          data-testid="system-events-cap-banner"
          className="border-border bg-muted/40 flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm"
        >
          <Info className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-0.5">
            <p className="text-foreground font-medium">
              Showing the last {RESULT_CAP} events that matched
            </p>
            <p className="text-muted-foreground text-xs">
              More events match your current filters. Narrow the date range or
              pick a specific kind to see the full set.
            </p>
          </div>
        </div>
      ) : null}

      {decorated.length > 0 ? (
        <SystemEventsTable events={decorated} now={new Date().toISOString()} />
      ) : (
        <div
          data-testid="system-events-empty"
          className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center"
        >
          <ListChecks className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            No system events match these filters
          </p>
          <p className="text-muted-foreground max-w-sm text-sm">
            Events are written by the dialer, the spend-cap and connect-rate
            monitors, manual outcome overrides, and merge / cancel flows. Try
            widening the date range or switching the severity tab.
          </p>
        </div>
      )}
    </div>
  );
}
