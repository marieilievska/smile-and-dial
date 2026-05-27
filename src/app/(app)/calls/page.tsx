import { Phone } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { CallsActiveFilterChips } from "./active-filter-chips";
import { CallDetailModal } from "./call-detail-modal";
import { CallRow } from "./call-row";
import { CallRowActions } from "./call-row-actions";
import { CallsFilters } from "./calls-filters";
import {
  buildCallsQuery,
  parseSort,
  resolveLeadFilterIds,
  str,
} from "./calls-query";
import { CallsStatStrip } from "./calls-stat-strip";
import { CALL_COLUMNS, DEFAULT_COLUMN_KEYS, type DisplayCall } from "./columns";
import { ColumnPicker } from "./column-picker";
import { SavedViews } from "./saved-views";
import { SmartPagination } from "../leads/smart-pagination";
import { SortableHeader } from "./sortable-header";
import { fetchCallStats } from "./stats-query";
import { type SearchParams } from "./calls-url";

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const DEFAULT_PAGE_SIZE = 25;

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { sort, dir } = parseSort(params);
  const page = Math.max(1, Number(params.page) || 1);
  const perRaw = Number(str(params.per));
  const pageSize = ALLOWED_PAGE_SIZES.has(perRaw) ? perRaw : DEFAULT_PAGE_SIZE;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Admins see the Owner filter; members only see their own calls anyway.
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = me?.role === "admin";

  const [
    { data: campaigns },
    { data: agents },
    { data: owners },
    { data: viewsRaw },
    stats,
  ] = await Promise.all([
    supabase.from("campaigns").select("id, name").order("name"),
    supabase.from("agents").select("id, name").order("name"),
    isAdmin
      ? supabase.from("profiles").select("id, full_name, email").order("email")
      : Promise.resolve({
          data: [] as { id: string; full_name: string | null; email: string }[],
        }),
    supabase
      .from("saved_views")
      .select("id, name, params")
      .eq("page", "calls")
      .order("created_at", { ascending: false }),
    fetchCallStats(supabase),
  ]);

  const ownerOptions: { id: string; name: string }[] = (owners ?? []).map(
    (o) => ({
      id: o.id,
      name: o.full_name || o.email || "—",
    }),
  );
  const campaignOptions = (campaigns ?? []).map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const agentOptions = (agents ?? []).map((a) => ({ id: a.id, name: a.name }));

  const leadFilterIds = await resolveLeadFilterIds(supabase, params);
  const offset = (page - 1) * pageSize;
  const { data, count } = await buildCallsQuery(
    supabase,
    params,
    leadFilterIds ?? undefined,
  )
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(offset, offset + pageSize - 1);

  const rawCalls = data ?? [];
  const total = count ?? 0;

  // Owner names for the rows: gather distinct owner_ids across visible
  // leads. Members get a single owner (themselves) so this is cheap.
  const ownerIds = [
    ...new Set(
      rawCalls
        .map((c) => c.lead?.owner_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const ownerNameById = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", ownerIds);
    for (const p of profiles ?? []) {
      ownerNameById.set(p.id, p.full_name || p.email || "—");
    }
  }

  // Which calls have a callback row? Loaded in one query so the "has_callback"
  // column / filter never needs a per-row probe.
  const callIds = rawCalls.map((c) => c.id);
  const hasCallback = new Set<string>();
  if (callIds.length > 0) {
    const { data: cbs } = await supabase
      .from("callbacks")
      .select("originating_call_id")
      .in("originating_call_id", callIds);
    for (const cb of cbs ?? []) {
      if (cb.originating_call_id) hasCallback.add(cb.originating_call_id);
    }
  }

  const calls: DisplayCall[] = rawCalls.map((c) => ({
    id: c.id,
    direction: c.direction as DisplayCall["direction"],
    status: c.status,
    outcome: c.outcome,
    goal_met: c.goal_met,
    started_at: c.started_at,
    ended_at: c.ended_at,
    duration_seconds: c.duration_seconds,
    talk_time_seconds: c.talk_time_seconds,
    recording_path: c.recording_path,
    score: c.score,
    cost_breakdown: c.cost_breakdown,
    hasCallback: hasCallback.has(c.id),
    leadId: c.lead?.id ?? null,
    company: c.lead?.company ?? null,
    business_phone: c.lead?.business_phone ?? null,
    campaignName: c.campaign?.name ?? "—",
    agentName: c.agent?.name ?? "—",
    ownerName: c.lead?.owner_id
      ? (ownerNameById.get(c.lead.owner_id) ?? "—")
      : "—",
  }));

  // Visible columns (URL param `cols` overrides the default set).
  const colsParam = str(params.cols);
  const visibleKeys = colsParam
    ? new Set(colsParam.split(","))
    : new Set(DEFAULT_COLUMN_KEYS);
  const columns = CALL_COLUMNS.filter((c) => visibleKeys.has(c.key));

  // Has the user applied any filters or a search? Drives the empty-
  // state variant when no calls match.
  const hasAnyFilter =
    Boolean(
      str(params.q) ||
      str(params.direction) ||
      str(params.status) ||
      str(params.outcome) ||
      str(params.campaign) ||
      str(params.agent) ||
      str(params.owner) ||
      str(params.goal_met),
    ) ||
    Boolean(
      str(params.min_dur) ||
      str(params.max_dur) ||
      str(params.from) ||
      str(params.to),
    );

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Calls
        </h1>
        <p className="text-muted-foreground text-sm">
          What the AI dialed. Sortable, searchable, every recording one click
          away.
        </p>
      </div>

      <CallsStatStrip stats={stats} />

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <CallsFilters
            campaigns={campaignOptions}
            agents={agentOptions}
            owners={ownerOptions}
            showOwner={isAdmin}
          />
          <ColumnPicker />
          <SavedViews views={viewsRaw ?? []} />
        </div>
        <CallsActiveFilterChips
          campaigns={campaignOptions}
          agents={agentOptions}
          owners={ownerOptions}
        />
      </div>

      {calls.length > 0 ? (
        <>
          <div className="border-border overflow-x-auto rounded-lg border">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  {columns.map((col) =>
                    col.sortKey ? (
                      <SortableHeader
                        key={col.key}
                        label={col.label}
                        sortKey={col.sortKey}
                        currentSort={sort}
                        currentDir={dir}
                        params={params}
                        className={col.width}
                      />
                    ) : (
                      <TableHead key={col.key} className={col.width}>
                        {col.label}
                      </TableHead>
                    ),
                  )}
                  {/* Sticky-right actions header: stays pinned to the
                      table's right edge when extra columns force the
                      table to scroll horizontally. Background uses
                      bg-background (the warm-cream page surface) not
                      bg-card (pure white) — the table sits directly
                      on the page surface with no card wrapper, so
                      bg-card would render brighter white than the
                      rest of the row. */}
                  <TableHead
                    className="bg-background sticky right-0 z-10 w-[170px] shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)]"
                    aria-label="Row actions"
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((c) => (
                  <CallRow key={c.id} callId={c.id}>
                    {columns.map((col) => (
                      <TableCell key={col.key} className={col.width}>
                        {col.cell(c)}
                      </TableCell>
                    ))}
                    {/* Hover color is computed with color-mix so it
                        produces the SAME opaque pixel value as the
                        row's `hover:bg-muted/50` blend on top of the
                        warm-cream --background. Without this the
                        sticky cell stays a different shade than the
                        rest of the row and the two-tone effect looks
                        broken. */}
                    <TableCell className="bg-background sticky right-0 z-10 w-[170px] text-right shadow-[-8px_0_16px_-8px_rgba(0,0,0,0.06)] transition-colors group-hover:bg-[color-mix(in_oklab,var(--muted)_50%,var(--background))]">
                      <CallRowActions
                        callId={c.id}
                        leadId={c.leadId}
                        hasRecording={Boolean(c.recording_path)}
                      />
                    </TableCell>
                  </CallRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <SmartPagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/calls"
          />
        </>
      ) : hasAnyFilter ? (
        <FilteredEmptyState />
      ) : (
        <NoCallsEmptyState />
      )}

      <CallDetailModal />
    </div>
  );
}

/** Shown when filters or search restrict the result set to nothing. */
function FilteredEmptyState() {
  return (
    <div
      data-testid="calls-empty-filtered"
      className="border-border/70 bg-muted/10 flex flex-col items-center gap-3 rounded-2xl border border-dashed py-14 text-center"
    >
      <Phone className="text-muted-foreground/70 size-7" />
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-sm font-medium">No calls match</p>
        <p className="text-muted-foreground max-w-sm text-sm">
          Adjust the filters above or clear them with the chips just below the
          toolbar.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/calls">Clear all filters</Link>
      </Button>
    </div>
  );
}

/** Shown when there are no calls in the system at all. */
function NoCallsEmptyState() {
  return (
    <div
      data-testid="calls-empty-zero"
      className="border-border/70 bg-muted/10 flex flex-col items-center gap-4 rounded-2xl border border-dashed py-16 text-center"
    >
      <Phone className="text-muted-foreground/70 size-8" />
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-base font-medium">No calls yet</p>
        <p className="text-muted-foreground max-w-md text-sm">
          The dialer hasn&apos;t placed any calls yet. Make sure a campaign is
          active and attached to a list with at least one ready-to-call lead.
        </p>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button asChild size="sm">
          <Link href="/campaigns">Manage campaigns</Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/leads">Browse leads</Link>
        </Button>
      </div>
    </div>
  );
}
