import { Download, Upload, Users } from "lucide-react";
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

import { ActiveFilterChips } from "./active-filter-chips";
import { BulkActionBar } from "./bulk-action-bar";
import { ColumnPicker } from "./column-picker";
import {
  DEFAULT_COLUMN_KEYS,
  LEAD_COLUMNS,
  statusRailClass,
  type DisplayLead,
} from "./columns";
import { InlineListCell } from "./inline-list-cell";
import { InlineStatusCell } from "./inline-status-cell";
import { LeadRow } from "./lead-row";
import { LeadRowActions } from "./lead-row-actions";
import { LeadsFilters } from "./leads-filters";
import { LeadsStatStrip } from "./leads-stat-strip";
import {
  buildLeadsQuery,
  parseSort,
  resolveCustomFieldLeadIds,
  str,
} from "./leads-query";
import { type SearchParams } from "./leads-url";
import { SelectAllBanner } from "./select-all-banner";
import { SmartPagination } from "./smart-pagination";
import { SaveCurrentViewButton } from "./saved-views";
import { fetchLeadStats } from "./stats-query";
import { LeadsJKNavigation } from "./jk-navigation";
import { RowCheckbox, SelectAllCheckbox, SelectionProvider } from "./selection";
import { SortableHeader } from "./sortable-header";

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const DEFAULT_PAGE_SIZE = 25;

export default async function LeadsPage({
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

  const offset = (page - 1) * pageSize;
  // Resolve custom-field filters to matching lead ids first (a plain array, not
  // a query builder), then pass them into the synchronous query builder.
  const customLeadIds = await resolveCustomFieldLeadIds(supabase, params);
  // Run the table query + the stat strip + lookups in parallel — none
  // of them depend on each other.
  const [
    { data: leadsData, count: leadsCount },
    stats,
    { data: lists },
    { data: me },
    { data: customFieldDefs },
    { data: customValues },
  ] = await Promise.all([
    buildLeadsQuery(supabase, params, customLeadIds)
      .order(sort, { ascending: dir === "asc" })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1),
    fetchLeadStats(supabase),
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
    supabase
      .from("custom_field_defs")
      .select("id, name, slug")
      .order("sort_order"),
    // Collected values per custom field, to populate each field's value
    // dropdown. Bounded; only connected calls populate these, so it's small.
    supabase
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .limit(6000),
  ]);

  // Build the custom-field options the filter popover + chips need: each field
  // with the distinct values actually collected for it (capped per field).
  const valueOptionsByField = new Map<string, Set<string>>();
  for (const r of (customValues ?? []) as {
    custom_field_id: string;
    value: string | null;
  }[]) {
    if (!r.value) continue;
    let set = valueOptionsByField.get(r.custom_field_id);
    if (!set) {
      set = new Set<string>();
      valueOptionsByField.set(r.custom_field_id, set);
    }
    if (set.size < 50) set.add(r.value);
  }
  const customFields = (
    (customFieldDefs ?? []) as { id: string; name: string; slug: string }[]
  ).map((d) => ({
    id: d.id,
    name: d.name,
    slug: d.slug,
    options: [...(valueOptionsByField.get(d.id) ?? [])].sort((a, b) =>
      a.localeCompare(b),
    ),
  }));

  const rawLeads = leadsData ?? [];
  const total = leadsCount ?? 0;

  // Owner names + the set of leads the dialer has a call in flight for
  // right now. Both lookups key off the visible rows, so run them in
  // parallel — the on-call set drives the live pulse in the company cell.
  const ownerIds = [...new Set(rawLeads.map((l) => l.owner_id))];
  const leadIds = rawLeads.map((l) => l.id);
  const ownerName = new Map<string, string>();
  const onCallIds = new Set<string>();
  if (rawLeads.length > 0) {
    const [{ data: owners }, { data: activeCalls }] = await Promise.all([
      ownerIds.length > 0
        ? supabase
            .from("profiles")
            .select("id, full_name, email")
            .in("id", ownerIds)
        : Promise.resolve({
            data: [] as {
              id: string;
              full_name: string | null;
              email: string | null;
            }[],
          }),
      supabase
        .from("calls")
        .select("lead_id")
        .in("lead_id", leadIds)
        .in("status", ["queued", "dialing", "ringing", "in_progress"]),
    ]);
    for (const owner of owners ?? []) {
      ownerName.set(owner.id, owner.full_name || owner.email || "—");
    }
    for (const call of activeCalls ?? []) {
      if (call.lead_id) onCallIds.add(call.lead_id);
    }
  }

  const newCutoff = new Date().getTime() - 24 * 60 * 60 * 1000;
  const leads: DisplayLead[] = rawLeads.map((l) => ({
    id: l.id,
    company: l.company,
    business_phone: l.business_phone,
    business_email: l.business_email,
    status: l.status,
    category: l.category,
    decision_maker_reached: l.decision_maker_reached ?? false,
    city: l.city,
    state: l.state,
    timezone: l.timezone,
    conversations: l.conversations,
    call_attempts: l.call_attempts,
    last_call_at: l.last_call_at,
    next_call_at: l.next_call_at,
    listId: l.list_id ?? null,
    listName: l.list?.name ?? "—",
    ownerName: ownerName.get(l.owner_id) ?? "—",
    onCall: onCallIds.has(l.id),
    aiSummary: l.ai_summary,
    isNew: l.created_at ? new Date(l.created_at).getTime() >= newCutoff : false,
  }));

  // Visible columns.
  const colsParam = str(params.cols);
  const visibleKeys = colsParam
    ? new Set(colsParam.split(","))
    : new Set(DEFAULT_COLUMN_KEYS);
  const columns = LEAD_COLUMNS.filter((c) => visibleKeys.has(c.key));

  // The effective list state, threaded onto each row's detail link so the
  // lead page can offer prev/next through this exact view and a Back link
  // that returns here. sort/dir/per/page are always set (even at defaults)
  // so the detail page can tell it was reached from the list.
  const ctx = new URLSearchParams();
  for (const key of [
    "q",
    "list",
    "status",
    "outcome",
    "created_from",
    "created_to",
    "lastcall_from",
    "lastcall_to",
    "nextcall_from",
    "nextcall_to",
    "cols",
  ]) {
    const v = str(params[key]);
    if (v) ctx.set(key, v);
  }
  // Carry custom-field filters (cf_<slug> / cfc_<slug>) into the detail-page
  // context so prev/next walks the same filtered view.
  for (const [key, value] of Object.entries(params)) {
    if (
      (key.startsWith("cf_") || key.startsWith("cfc_")) &&
      typeof value === "string" &&
      value
    ) {
      ctx.set(key, value);
    }
  }
  ctx.set("sort", sort);
  ctx.set("dir", dir);
  ctx.set("per", String(pageSize));
  ctx.set("page", String(page));
  const contextQuery = ctx.toString();

  const isAdmin = me?.role === "admin";

  // Admins get the owner list for the bulk reassign dialog.
  let bulkOwners: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name");
    bulkOwners = (people ?? []).map((p) => ({
      id: p.id,
      name: p.full_name || p.email || "Unknown",
    }));
  }

  // Export carries every filter except pagination — it exports all matches.
  const exportQs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value && key !== "page" && key !== "per") {
      exportQs.set(key, value);
    }
  }
  const exportHref = exportQs.toString()
    ? `/leads/export?${exportQs}`
    : "/leads/export";

  // Has the user applied any filters or a search? If not, the empty
  // state is "no leads in the system" (different copy / different
  // primary CTA) vs the filter-restricted empty state.
  const hasAnyFilter =
    Boolean(
      str(params.q) ||
      str(params.status) ||
      str(params.outcome) ||
      str(params.list),
    ) ||
    Boolean(
      str(params.created_from) ||
      str(params.created_to) ||
      str(params.lastcall_from) ||
      str(params.lastcall_to) ||
      str(params.nextcall_from) ||
      str(params.nextcall_to),
    ) ||
    Object.keys(params).some(
      (k) => k.startsWith("cf_") || k.startsWith("cfc_"),
    );

  return (
    <div className="flex flex-col gap-5 p-6">
      {/* HEADER — title + count */}
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-1.5 duration-500">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Leads
        </h1>
        <p className="text-muted-foreground text-sm">
          Everyone the AI can dial — {total.toLocaleString()}{" "}
          {total === 1 ? "lead" : "leads"} in view.
        </p>
      </div>

      {/* Live updates are handled app-wide by <AutoRefresh> in the (app)
          layout — no per-page poller needed. */}

      {/* L1 — stat strip: ready · callbacks · goals met this week.
          Each tile is a clickable filter shortcut. */}
      <LeadsStatStrip stats={stats} />

      {/* L2 — toolbar. Search lives in the global top bar now, so this
            row holds filter + column + save-view on the left and the
            export / import actions on the right. */}
      <div className="animate-in fade-in slide-in-from-bottom-1 fill-mode-both flex flex-col gap-3 delay-150 duration-500">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <LeadsFilters lists={lists ?? []} customFields={customFields} />
            <ColumnPicker />
            <SaveCurrentViewButton />
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              asChild
              variant="ghost"
              size="sm"
              title="Export current view"
            >
              <a href={exportHref} aria-label="Export current view as CSV">
                <Download className="size-4" />
                Export
              </a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/leads/import">
                <Upload className="size-4" />
                Import
              </Link>
            </Button>
          </div>
        </div>
        <ActiveFilterChips lists={lists ?? []} customFields={customFields} />
      </div>

      <SelectionProvider allIds={leads.map((l) => l.id)}>
        <LeadsJKNavigation
          ids={leads.map((l) => l.id)}
          context={contextQuery}
        />
        <BulkActionBar
          lists={lists ?? []}
          owners={bulkOwners}
          isAdmin={isAdmin}
        />
        <SelectAllBanner total={total} />
        {leads.length > 0 ? (
          <div className="border-border animate-in fade-in slide-in-from-bottom-2 fill-mode-both overflow-x-auto rounded-lg border delay-200 duration-500">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <SelectAllCheckbox />
                  </TableHead>
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
                  {/* Right-edge column for hover-only row actions. */}
                  <TableHead className="w-[100px]" aria-label="Row actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <LeadRow
                    key={lead.id}
                    leadId={lead.id}
                    context={contextQuery}
                  >
                    {/* First cell carries a faint stage-colored left rail
                        that only shows on row hover — a quiet wayfinding
                        cue keyed to the lead's stage. The transparent base
                        border is always present so the 2px never shifts the
                        layout (a documented table-fixed caveat). */}
                    <TableCell
                      className={`w-10 border-l-2 border-l-transparent transition-colors ${statusRailClass(
                        lead.status,
                      )}`}
                    >
                      <RowCheckbox leadId={lead.id} />
                    </TableCell>
                    {columns.map((col) => {
                      // I3 — Inline editable cells for the columns where
                      // a per-row picker is the right UX. Everything else
                      // falls through to the static `col.cell(lead)` so
                      // there's exactly one place in the page where the
                      // editable-vs-read-only decision lives.
                      let body: React.ReactNode;
                      if (col.key === "status") {
                        body = (
                          <InlineStatusCell
                            leadId={lead.id}
                            status={lead.status}
                          />
                        );
                      } else if (col.key === "list") {
                        body = (
                          <InlineListCell
                            leadId={lead.id}
                            listId={lead.listId}
                            listName={lead.listName}
                            options={lists ?? []}
                          />
                        );
                      } else {
                        body = col.cell(lead);
                      }
                      return (
                        <TableCell key={col.key} className={col.width}>
                          {body}
                        </TableCell>
                      );
                    })}
                    <TableCell className="w-[100px] text-right">
                      <LeadRowActions
                        leadId={lead.id}
                        leadName={lead.company ?? ""}
                      />
                    </TableCell>
                  </LeadRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : hasAnyFilter ? (
          <FilteredEmptyState />
        ) : (
          <NoLeadsEmptyState />
        )}
      </SelectionProvider>

      {leads.length > 0 ? (
        <SmartPagination page={page} pageSize={pageSize} total={total} />
      ) : null}
    </div>
  );
}

/** Shown when filters or search restrict the result set to nothing.
 *  Primary action is to clear filters (handled by the chips strip
 *  above the table) — here we just nudge the user. */
function FilteredEmptyState() {
  return (
    <div
      data-testid="leads-empty-filtered"
      className="border-border/70 bg-muted/10 flex flex-col items-center gap-3 rounded-2xl border border-dashed py-14 text-center"
    >
      <Users className="text-muted-foreground/70 size-7" />
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-sm font-medium">No leads match</p>
        <p className="text-muted-foreground max-w-sm text-sm">
          Adjust the filters above or clear them with the chips just below the
          toolbar.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/leads">Clear all filters</Link>
      </Button>
    </div>
  );
}

/** Shown when there are *no leads at all* in the system. Friendlier
 *  copy + a primary CTA to import a CSV. */
function NoLeadsEmptyState() {
  return (
    <div
      data-testid="leads-empty-zero"
      className="border-border/70 bg-muted/10 flex flex-col items-center gap-4 rounded-2xl border border-dashed py-16 text-center"
    >
      <Users className="text-muted-foreground/70 size-8" />
      <div className="flex flex-col gap-1">
        <p className="text-foreground text-base font-medium">No leads yet</p>
        <p className="text-muted-foreground max-w-md text-sm">
          Import a CSV to bring in your first batch. The AI starts calling once
          a campaign is attached to the list.
        </p>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <Button asChild size="sm">
          <Link href="/leads/import">
            <Upload className="size-4" />
            Import a CSV
          </Link>
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/settings/lists">Manage lists</Link>
        </Button>
      </div>
    </div>
  );
}
