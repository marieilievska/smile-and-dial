import { ChevronLeft, ChevronRight, Phone } from "lucide-react";
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

import { CallsFilters } from "./calls-filters";
import {
  buildCallsQuery,
  parseSort,
  resolveLeadFilterIds,
  str,
} from "./calls-query";
import { callsHref, type SearchParams } from "./calls-url";
import { CallDetailModal } from "./call-detail-modal";
import { CallRow } from "./call-row";
import { CALL_COLUMNS, DEFAULT_COLUMN_KEYS, type DisplayCall } from "./columns";
import { ColumnPicker } from "./column-picker";
import { SavedViews } from "./saved-views";
import { SortableHeader } from "./sortable-header";

const PAGE_SIZE = 25;

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const { sort, dir } = parseSort(params);
  const page = Math.max(1, Number(params.page) || 1);

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
  ]);

  const ownerOptions: { id: string; name: string }[] = (owners ?? []).map(
    (o) => ({
      id: o.id,
      name: o.full_name || o.email || "—",
    }),
  );

  const leadFilterIds = await resolveLeadFilterIds(supabase, params);
  const offset = (page - 1) * PAGE_SIZE;
  const { data, count } = await buildCallsQuery(
    supabase,
    params,
    leadFilterIds ?? undefined,
  )
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  const rawCalls = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

  return (
    <div className="flex flex-col gap-6 p-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-foreground text-2xl font-bold tracking-tight">
            Calls
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Every outbound and inbound call. Filter and sort to drill in.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SavedViews views={viewsRaw ?? []} />
          <ColumnPicker />
        </div>
      </div>

      <CallsFilters
        campaigns={campaigns ?? []}
        agents={agents ?? []}
        owners={ownerOptions}
        initial={{
          q: str(params.q),
          direction: str(params.direction),
          status: str(params.status),
          outcome: str(params.outcome),
          campaign: str(params.campaign),
          agent: str(params.agent),
          owner: str(params.owner),
          goal_met: str(params.goal_met),
          min_dur: str(params.min_dur),
          max_dur: str(params.max_dur),
          from: str(params.from),
          to: str(params.to),
        }}
      />

      {calls.length > 0 ? (
        <>
          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
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
                      />
                    ) : (
                      <TableHead key={col.key}>{col.label}</TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((c) => (
                  <CallRow key={c.id} callId={c.id}>
                    {columns.map((col) => (
                      <TableCell key={col.key}>{col.cell(c)}</TableCell>
                    ))}
                  </CallRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-sm">
              {total === 0
                ? "No calls"
                : `Showing ${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1} asChild>
                <Link
                  href={callsHref(params, { page: String(page - 1) })}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="size-4" />
                </Link>
              </Button>
              <span className="text-foreground text-sm">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                asChild
              >
                <Link
                  href={callsHref(params, { page: String(page + 1) })}
                  aria-label="Next page"
                >
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Phone className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">No calls yet</p>
          <p className="text-muted-foreground text-sm">
            Calls show up here as soon as the dialer places them.
          </p>
        </div>
      )}

      <CallDetailModal />
    </div>
  );
}
