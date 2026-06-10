import { CalendarClock, CheckCircle2, ExternalLink, Mic } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatPhone } from "@/lib/format-phone";
import { callbackStatusLabel } from "@/lib/labels";
import { callbackStatusBadgeVariant } from "@/lib/outcome-style";
import { createClient } from "@/lib/supabase/server";

import { CallbackRow } from "./callback-row";
import { CallbackRowActions } from "./callback-row-actions";
import { CallbacksBulkBar } from "./callbacks-bulk-bar";
import {
  CallbackRowCheckbox,
  CallbackSelectAllCheckbox,
  CallbacksSelectionProvider,
} from "./callbacks-selection";
import { CallbacksFilters } from "./callbacks-filters";
import { CallbacksStatStrip } from "./callbacks-stat-strip";
import {
  CallbacksStatusTabs,
  type CallbackCounts,
} from "./callbacks-status-tabs";
import {
  CALLBACK_SORT_COLUMNS,
  callbacksHref,
  parseSort,
  str,
  type SearchParams,
} from "./callbacks-url";
import { formatScheduledWhen } from "./format-when";
import { SmartPagination } from "../leads/smart-pagination";
import { SortableHeader } from "./sortable-header";
import { fetchCallbackStats } from "./stats-query";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;
const STATUS_VALUES = new Set([
  "pending",
  "completed",
  "missed",
  "cancelled",
  "all",
]);
const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const DEFAULT_PAGE_SIZE = 25;

export default async function CallbacksPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const statusFilter = STATUS_VALUES.has(str(params.status))
    ? str(params.status)
    : "pending";
  const campaignFilter = UUID_RE.test(str(params.campaign))
    ? str(params.campaign)
    : "";
  const fromFilter = DATE_RE.test(str(params.from)) ? str(params.from) : "";
  const toFilter = DATE_RE.test(str(params.to)) ? str(params.to) : "";
  const voicemailFilter = ["none", "some", "repeat"].includes(
    str(params.voicemail),
  )
    ? str(params.voicemail)
    : "";
  const rangeFilter = ["today", "week", "overdue"].includes(str(params.range))
    ? str(params.range)
    : "";

  const { sort, dir } = parseSort(params);
  const page = Math.max(1, Number(str(params.page)) || 1);
  const perRaw = Number(str(params.per));
  const pageSize = ALLOWED_PAGE_SIZES.has(perRaw) ? perRaw : DEFAULT_PAGE_SIZE;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Admin gate for the delete affordances (row + bulk).
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = me?.role === "admin";

  // Campaign list for the filter popover — RLS scopes for members.
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("name");

  // Counts for each status tab — five tiny head-only queries so the
  // tab badges reflect total volume per state. The "all" count is
  // the sum of the four other counts.
  const now = new Date();
  const [pendingCount, completedCount, missedCount, cancelledCount] =
    await Promise.all([
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending"),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "completed"),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "missed"),
      supabase
        .from("callbacks")
        .select("id", { count: "exact", head: true })
        .eq("status", "cancelled"),
    ]);
  const tabCounts: CallbackCounts = {
    pending: pendingCount.count ?? 0,
    completed: completedCount.count ?? 0,
    missed: missedCount.count ?? 0,
    cancelled: cancelledCount.count ?? 0,
    all:
      (pendingCount.count ?? 0) +
      (completedCount.count ?? 0) +
      (missedCount.count ?? 0) +
      (cancelledCount.count ?? 0),
  };

  const stats = await fetchCallbackStats(supabase);

  // Build the filtered query. Sort uses the DB column from CALLBACK_
  // SORT_COLUMNS; foreign-key sorts (lead.company) are supported by
  // PostgREST via the `referencedTable` argument.
  let query = supabase
    .from("callbacks")
    .select(
      "id, scheduled_at, status, voicemail_attempts, created_by, created_at, " +
        "lead:leads(id, company, business_phone, timezone), " +
        "campaign:campaigns(id, name), " +
        "originating_call_id, result_call_id",
      { count: "exact" },
    );

  if (statusFilter !== "all") query = query.eq("status", statusFilter);
  if (campaignFilter) query = query.eq("campaign_id", campaignFilter);

  // Stat-strip shortcuts.
  if (rangeFilter === "today") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(now);
    endOfToday.setHours(23, 59, 59, 999);
    query = query
      .gte("scheduled_at", startOfToday.toISOString())
      .lte("scheduled_at", endOfToday.toISOString());
  } else if (rangeFilter === "week") {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const weekFromNow = new Date(startOfToday);
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    query = query
      .gte("scheduled_at", startOfToday.toISOString())
      .lt("scheduled_at", weekFromNow.toISOString());
  } else if (rangeFilter === "overdue") {
    query = query.lt("scheduled_at", now.toISOString());
  }

  // Explicit date range overrides the stat-strip shortcuts.
  if (fromFilter) query = query.gte("scheduled_at", fromFilter);
  if (toFilter) query = query.lte("scheduled_at", `${toFilter}T23:59:59`);

  if (voicemailFilter === "none") query = query.eq("voicemail_attempts", 0);
  if (voicemailFilter === "some") query = query.gte("voicemail_attempts", 1);
  if (voicemailFilter === "repeat") query = query.gte("voicemail_attempts", 2);

  // Apply sort. `lead.company` uses PostgREST referencedTable syntax.
  const sortCol = CALLBACK_SORT_COLUMNS[sort] ?? "scheduled_at";
  if (sortCol === "lead.company") {
    query = query.order("company", {
      ascending: dir === "asc",
      referencedTable: "lead",
    });
  } else {
    query = query.order(sortCol, { ascending: dir === "asc" });
  }
  query = query.order("id", { ascending: true });

  const offset = (page - 1) * pageSize;
  query = query.range(offset, offset + pageSize - 1);

  type Row = {
    id: string;
    scheduled_at: string;
    status: string;
    voicemail_attempts: number;
    created_by: string | null;
    created_at: string;
    lead: {
      id: string;
      company: string | null;
      business_phone: string | null;
      timezone: string | null;
    } | null;
    campaign: { id: string; name: string } | null;
    originating_call_id: string | null;
    result_call_id: string | null;
  };
  const { data: rows, count } = await query;
  const callbacks = (rows ?? []) as unknown as Row[];
  const total = count ?? 0;
  const hasAnyFilter =
    campaignFilter !== "" ||
    fromFilter !== "" ||
    toFilter !== "" ||
    voicemailFilter !== "" ||
    rangeFilter !== "";

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-1.5 delay-75 duration-500">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Callbacks
          </h1>
          {/* Live "due within the hour" pulse — the autopilot is about
              to dial these automatically, so the page reads as a live
              operation, not a static schedule. Hidden when nothing is
              imminent to avoid a permanent decoration. */}
          {stats.dueWithinHour > 0 ? (
            <Link
              href="/callbacks?status=pending&range=today"
              data-testid="callbacks-due-soon"
              className="border-border bg-card text-foreground hover:bg-muted/60 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
            >
              <span className="relative flex size-2 items-center justify-center">
                <span
                  className="absolute inline-flex size-2 animate-ping rounded-full opacity-70"
                  style={{ backgroundColor: "var(--primary)" }}
                />
                <span
                  className="relative inline-flex size-1.5 rounded-full"
                  style={{ backgroundColor: "var(--primary)" }}
                />
              </span>
              {stats.dueWithinHour.toLocaleString()} due within the hour
            </Link>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          Scheduled redials. Pending callbacks auto-dial at their scheduled time
          when the dialer cron is active.
        </p>
      </div>

      {/* CB2 — at-a-glance stats: Due today / Due this week /
          Overdue / Repeat voicemails. */}
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both delay-100 duration-500">
        <CallbacksStatStrip stats={stats} />
      </div>

      <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-3 delay-150 duration-500">
        {/* CB3 — status tabs + CB1 filter popover share a single row. */}
        <div className="flex flex-wrap items-center gap-2">
          <CallbacksStatusTabs current={statusFilter} counts={tabCounts} />
          <div className="flex-1" />
          <CallbacksFilters campaigns={campaigns ?? []} />
        </div>
      </div>

      {callbacks.length > 0 ? (
        <CallbacksSelectionProvider allIds={callbacks.map((cb) => cb.id)}>
          <div className="animate-in fade-in slide-in-from-bottom-2 fill-mode-both flex flex-col gap-5 delay-200 duration-500">
            <div className="border-border overflow-x-auto rounded-lg border">
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    {isAdmin ? (
                      <TableHead className="w-10">
                        <CallbackSelectAllCheckbox />
                      </TableHead>
                    ) : null}
                    <SortableHeader
                      label="Lead"
                      sortKey="company"
                      currentSort={sort}
                      currentDir={dir}
                      params={params}
                      className="w-[300px]"
                    />
                    <SortableHeader
                      label="Scheduled"
                      sortKey="scheduled_at"
                      currentSort={sort}
                      currentDir={dir}
                      params={params}
                      className="w-[220px]"
                    />
                    <TableHead className="w-[180px]">Campaign</TableHead>
                    <SortableHeader
                      label="Status"
                      sortKey="status"
                      currentSort={sort}
                      currentDir={dir}
                      params={params}
                      className="w-[130px]"
                    />
                    <TableHead className="w-[120px]">Original call</TableHead>
                    {/* Sticky-right actions cell — mirrors /calls. */}
                    <TableHead
                      className="bg-background sticky right-0 z-10 w-[360px] shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)]"
                      aria-label="Row actions"
                    />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {callbacks.map((cb) => {
                    const when = formatScheduledWhen(
                      cb.scheduled_at,
                      now,
                      cb.lead?.timezone ?? undefined,
                    );
                    const isPending = cb.status === "pending";
                    // Two-tone urgency rail: overdue reads as an alarm
                    // (destructive red), urgent (≤1h out) reads as
                    // "about to happen" (coral). Everything else stays
                    // transparent so the rail itself becomes a heat
                    // scale you can scan top-to-bottom.
                    const railColor =
                      isPending && when.urgency === "overdue"
                        ? "border-l-[color:var(--destructive)]"
                        : isPending && when.urgency === "urgent"
                          ? "border-l-[color:var(--primary)]"
                          : "border-l-transparent";
                    // The autopilot is about to dial overdue/urgent
                    // pending callbacks automatically — surface that so
                    // the row reads as live AI work, not a stale to-do.
                    const showAutopilot =
                      isPending &&
                      (when.urgency === "overdue" || when.urgency === "urgent");
                    return (
                      <CallbackRow
                        key={cb.id}
                        callId={
                          cb.originating_call_id ?? cb.result_call_id ?? null
                        }
                        leadId={cb.lead?.id ?? null}
                      >
                        {isAdmin ? (
                          <TableCell className="w-10">
                            <CallbackRowCheckbox callbackId={cb.id} />
                          </TableCell>
                        ) : null}
                        <TableCell
                          className={`w-[300px] border-l-[3px] ${railColor}`}
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <div className="flex min-w-0 items-center gap-2">
                              {cb.lead?.id ? (
                                <Link
                                  href={`/leads/${cb.lead.id}`}
                                  className="text-foreground hover:text-primary truncate text-sm font-medium underline-offset-2 hover:underline"
                                >
                                  {cb.lead?.company || "Unknown lead"}
                                </Link>
                              ) : (
                                <span className="text-foreground truncate text-sm font-medium">
                                  {cb.lead?.company || "Unknown lead"}
                                </span>
                              )}
                              {cb.voicemail_attempts > 0 ? (
                                <span
                                  className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                                    cb.voicemail_attempts >= 2
                                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                                      : "border-border text-muted-foreground"
                                  }`}
                                  title={
                                    cb.voicemail_attempts >= 2
                                      ? `Voicemail ${cb.voicemail_attempts}× — the AI keeps reaching voicemail; a human may need to step in`
                                      : "1 voicemail attempt"
                                  }
                                >
                                  <Mic className="size-2.5" />×
                                  {cb.voicemail_attempts}
                                </span>
                              ) : null}
                            </div>
                            {cb.lead?.business_phone ? (
                              <span className="text-muted-foreground truncate font-mono text-[11px]">
                                {formatPhone(cb.lead.business_phone)}
                              </span>
                            ) : null}
                          </div>
                        </TableCell>

                        <TableCell className="w-[220px]">
                          <div className="flex flex-col gap-0.5">
                            <span
                              className={`text-sm font-medium ${
                                when.urgency === "overdue"
                                  ? "text-destructive"
                                  : when.urgency === "urgent"
                                    ? "text-primary"
                                    : "text-foreground"
                              }`}
                            >
                              {when.primary}
                            </span>
                            <span className="text-muted-foreground text-[11px]">
                              {/* Absolute date + clock IN THE LEAD'S timezone
                                  with a short tz label (e.g. "Mar 5, 3:00 PM
                                  EDT") so an operator always knows whose 3 PM
                                  this is — the relative "In 2h"/"Overdue" line
                                  above stays as-is. Falls back to the viewer's
                                  local zone (and its label) when the lead has
                                  no timezone set. */}
                              {new Date(cb.scheduled_at).toLocaleString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "numeric",
                                  minute: "2-digit",
                                  timeZone: cb.lead?.timezone ?? undefined,
                                  timeZoneName: "short",
                                },
                              )}
                            </span>
                            {showAutopilot ? (
                              <span className="text-primary mt-0.5 inline-flex w-fit items-center gap-1.5 text-[10px] font-medium">
                                <span className="relative flex size-1.5 items-center justify-center">
                                  <span
                                    className="absolute inline-flex size-1.5 animate-ping rounded-full opacity-70"
                                    style={{
                                      backgroundColor: "var(--primary)",
                                    }}
                                  />
                                  <span
                                    className="relative inline-flex size-1 rounded-full"
                                    style={{
                                      backgroundColor: "var(--primary)",
                                    }}
                                  />
                                </span>
                                Autopilot dialing soon
                              </span>
                            ) : null}
                          </div>
                        </TableCell>

                        <TableCell className="text-muted-foreground w-[180px] truncate">
                          {cb.campaign?.name ?? "—"}
                        </TableCell>

                        <TableCell className="w-[130px]">
                          <Badge
                            variant={callbackStatusBadgeVariant(cb.status)}
                            dot
                          >
                            {callbackStatusLabel(cb.status)}
                          </Badge>
                        </TableCell>

                        <TableCell className="w-[120px]">
                          {cb.originating_call_id ? (
                            <Link
                              href={`/calls?call=${cb.originating_call_id}`}
                              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                            >
                              <ExternalLink className="size-3" />
                              View
                            </Link>
                          ) : (
                            <span className="text-muted-foreground text-xs">
                              —
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="bg-background sticky right-0 z-10 w-[360px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                          <CallbackRowActions
                            callbackId={cb.id}
                            leadId={cb.lead?.id ?? null}
                            currentScheduledAt={cb.scheduled_at}
                            isPending={isPending}
                            isAdmin={isAdmin}
                          />
                        </TableCell>
                      </CallbackRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {isAdmin ? <CallbacksBulkBar /> : null}

            <SmartPagination
              page={page}
              pageSize={pageSize}
              total={total}
              basePath="/callbacks"
            />
          </div>
        </CallbacksSelectionProvider>
      ) : hasAnyFilter ? (
        <FilteredEmptyState
          clearHref={callbacksHref(params, {
            campaign: undefined,
            from: undefined,
            to: undefined,
            voicemail: undefined,
            range: undefined,
          })}
        />
      ) : (
        <NoCallbacksEmptyState statusFilter={statusFilter} />
      )}
    </div>
  );
}

/** Shown when filters narrow the result set to nothing. Mirrors the
 *  pattern on /leads and /calls — explain that filters are active and
 *  offer a one-click clear. */
function FilteredEmptyState({ clearHref }: { clearHref: string }) {
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <CalendarClock className="text-muted-foreground size-8" />
      <p className="text-foreground text-sm font-medium">
        No callbacks match your filters
      </p>
      <p className="text-muted-foreground text-sm">
        Try clearing some filters or pick a different status.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href={clearHref}>Clear filters</Link>
      </Button>
    </div>
  );
}

/** Shown when there are simply no callbacks of the chosen status.
 *  Includes a one-line nudge toward where callbacks come from
 *  (created by the AI agent during a call, or manually from the call
 *  detail modal) and a link out to /calls so the user can go there. */
function NoCallbacksEmptyState({ statusFilter }: { statusFilter: string }) {
  // Pending with zero rows isn't a dead end — it's a win. The autopilot
  // simply has no redials queued, so reassure the operator rather than
  // showing a neutral "nothing here" state.
  if (statusFilter === "pending") {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/[0.04] py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10">
          <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" />
        </div>
        <p className="text-foreground text-sm font-medium">
          You&apos;re all caught up
        </p>
        <p className="text-muted-foreground max-w-md text-sm">
          No callbacks are waiting. The autopilot schedules a redial here
          automatically whenever a lead asks to be called back.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/calls">Browse recent calls</Link>
        </Button>
      </div>
    );
  }

  const headline =
    statusFilter === "all"
      ? "No callbacks yet"
      : `No ${statusFilter} callbacks`;
  return (
    <div className="border-border flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
      <CalendarClock className="text-muted-foreground size-8" />
      <p className="text-foreground text-sm font-medium">{headline}</p>
      <p className="text-muted-foreground max-w-md text-sm">
        Callbacks are created by the AI agent during a call (when the lead asks
        to be called back) or manually from the call detail modal.
      </p>
      <Button asChild variant="outline" size="sm">
        <Link href="/calls">Browse recent calls</Link>
      </Button>
    </div>
  );
}
