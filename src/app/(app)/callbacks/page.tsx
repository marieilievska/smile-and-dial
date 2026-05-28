import { CalendarClock, ExternalLink, Mic } from "lucide-react";
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
import { callbackStatusLabel } from "@/lib/labels";
import { createClient } from "@/lib/supabase/server";

import { CallbackRow } from "./callback-row";
import { CallbackRowActions } from "./callback-row-actions";
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

/** Pending → coral (active work). Completed → success green.
 *  Missed → destructive red (we missed the appointment). Cancelled →
 *  secondary muted (audit trail, not actionable). */
function statusVariant(
  status: string,
): "coral" | "success" | "destructive" | "secondary" {
  switch (status) {
    case "pending":
      return "coral";
    case "completed":
      return "success";
    case "missed":
      return "destructive";
    case "cancelled":
    default:
      return "secondary";
  }
}

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
        "lead:leads(id, company, business_phone), " +
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
      <div className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Callbacks
        </h1>
        <p className="text-muted-foreground text-sm">
          Scheduled redials. Pending callbacks auto-dial at their scheduled time
          when the dialer cron is active.
        </p>
      </div>

      {/* CB2 — at-a-glance stats: Due today / Due this week /
          Overdue / Repeat voicemails. */}
      <CallbacksStatStrip stats={stats} />

      <div className="flex flex-col gap-3">
        {/* CB3 — status tabs + CB1 filter popover share a single row. */}
        <div className="flex flex-wrap items-center gap-2">
          <CallbacksStatusTabs current={statusFilter} counts={tabCounts} />
          <div className="flex-1" />
          <CallbacksFilters campaigns={campaigns ?? []} />
        </div>
      </div>

      {callbacks.length > 0 ? (
        <>
          <div className="border-border overflow-x-auto rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <SortableHeader
                    label="Lead"
                    sortKey="company"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                    className="w-[34%] min-w-[260px]"
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
                    className="bg-background sticky right-0 z-10 w-[300px] shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)]"
                    aria-label="Row actions"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {callbacks.map((cb) => {
                  const when = formatScheduledWhen(cb.scheduled_at, now);
                  const isPending = cb.status === "pending";
                  const showUrgencyRail =
                    isPending &&
                    (when.urgency === "overdue" || when.urgency === "urgent");
                  return (
                    <CallbackRow key={cb.id} leadId={cb.lead?.id ?? null}>
                      <TableCell
                        className={`w-[34%] min-w-[260px] ${
                          showUrgencyRail
                            ? "border-l-[3px] border-l-[color:var(--coral)]"
                            : "border-l-[3px] border-l-transparent"
                        }`}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex min-w-0 items-center gap-2">
                            {cb.lead?.id ? (
                              <Link
                                href={`/leads/${cb.lead.id}`}
                                className="text-foreground truncate text-sm font-medium underline-offset-2 hover:text-[color:var(--coral)] hover:underline"
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
                                className="border-border text-muted-foreground inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                                title={`${cb.voicemail_attempts} voicemail attempt${cb.voicemail_attempts > 1 ? "s" : ""}`}
                              >
                                <Mic className="size-2.5" />×
                                {cb.voicemail_attempts}
                              </span>
                            ) : null}
                          </div>
                          {cb.lead?.business_phone ? (
                            <span className="text-muted-foreground truncate font-mono text-[11px]">
                              {cb.lead.business_phone}
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
                                  ? "text-[color:var(--coral)]"
                                  : "text-foreground"
                            }`}
                          >
                            {when.primary}
                          </span>
                          <span className="text-muted-foreground text-[11px]">
                            {new Date(cb.scheduled_at).toLocaleString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              },
                            )}
                          </span>
                        </div>
                      </TableCell>

                      <TableCell className="text-muted-foreground w-[180px] truncate">
                        {cb.campaign?.name ?? "—"}
                      </TableCell>

                      <TableCell className="w-[130px]">
                        <Badge variant={statusVariant(cb.status)} dot>
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

                      <TableCell className="bg-background sticky right-0 z-10 w-[300px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                        {isPending ? (
                          <CallbackRowActions
                            callbackId={cb.id}
                            leadId={cb.lead?.id ?? null}
                            currentScheduledAt={cb.scheduled_at}
                          />
                        ) : null}
                      </TableCell>
                    </CallbackRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <SmartPagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/callbacks"
          />
        </>
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
  const headline =
    statusFilter === "pending"
      ? "No callbacks scheduled"
      : statusFilter === "all"
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
