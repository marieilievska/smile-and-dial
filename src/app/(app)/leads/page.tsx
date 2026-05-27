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
import { DEFAULT_COLUMN_KEYS, LEAD_COLUMNS, type DisplayLead } from "./columns";
import { LeadRow } from "./lead-row";
import { LeadRowActions } from "./lead-row-actions";
import { LeadsFilters } from "./leads-filters";
import { LeadsSearchInput } from "./search-input";
import { LeadsStatStrip } from "./leads-stat-strip";
import { buildLeadsQuery, parseSort, str } from "./leads-query";
import { type SearchParams } from "./leads-url";
import { SmartPagination } from "./smart-pagination";
import { SaveCurrentViewButton } from "./saved-views";
import { fetchLeadStats } from "./stats-query";
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
  // Run the table query + the stat strip + lookups in parallel — none
  // of them depend on each other.
  const [
    { data: leadsData, count: leadsCount },
    stats,
    { data: lists },
    { data: me },
  ] = await Promise.all([
    buildLeadsQuery(supabase, params)
      .order(sort, { ascending: dir === "asc" })
      .order("id", { ascending: true })
      .range(offset, offset + pageSize - 1),
    fetchLeadStats(supabase),
    supabase.from("lists").select("id, name").order("name"),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
  ]);

  const rawLeads = leadsData ?? [];
  const total = leadsCount ?? 0;

  // Owner names.
  const ownerIds = [...new Set(rawLeads.map((l) => l.owner_id))];
  const ownerName = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: owners } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", ownerIds);
    for (const owner of owners ?? []) {
      ownerName.set(owner.id, owner.full_name || owner.email || "—");
    }
  }

  const leads: DisplayLead[] = rawLeads.map((l) => ({
    id: l.id,
    company: l.company,
    business_phone: l.business_phone,
    business_email: l.business_email,
    status: l.status,
    last_outcome: l.last_outcome,
    city: l.city,
    state: l.state,
    conversations: l.conversations,
    call_attempts: l.call_attempts,
    last_call_at: l.last_call_at,
    next_call_at: l.next_call_at,
    listName: l.list?.name ?? "—",
    ownerName: ownerName.get(l.owner_id) ?? "—",
  }));

  // Visible columns.
  const colsParam = str(params.cols);
  const visibleKeys = colsParam
    ? new Set(colsParam.split(","))
    : new Set(DEFAULT_COLUMN_KEYS);
  const columns = LEAD_COLUMNS.filter((c) => visibleKeys.has(c.key));

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
    );

  return (
    <div className="flex flex-col gap-6 p-8">
      {/* HEADER — title + count */}
      <div className="flex flex-col gap-1.5">
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Leads
        </h1>
        <p className="text-muted-foreground text-sm">
          {total.toLocaleString()} {total === 1 ? "lead" : "leads"} in view
        </p>
      </div>

      {/* L1 — stat strip: ready · callbacks · sale this week · added today.
          Each tile is a clickable filter shortcut. */}
      <LeadsStatStrip stats={stats} />

      {/* L2 — toolbar in three zones:
            left = search · middle = filter cluster + chips · right = actions. */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <LeadsSearchInput />
          <div className="flex items-center gap-1.5">
            <LeadsFilters lists={lists ?? []} />
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
        <ActiveFilterChips lists={lists ?? []} />
      </div>

      <SelectionProvider allIds={leads.map((l) => l.id)}>
        <BulkActionBar
          lists={lists ?? []}
          owners={bulkOwners}
          isAdmin={isAdmin}
        />
        {leads.length > 0 ? (
          <div className="border-border overflow-x-auto rounded-lg border">
            <Table>
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
                      />
                    ) : (
                      <TableHead key={col.key}>{col.label}</TableHead>
                    ),
                  )}
                  {/* Right-edge column for hover-only row actions. */}
                  <TableHead className="w-[120px]" aria-label="Row actions" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {leads.map((lead) => (
                  <LeadRow key={lead.id} leadId={lead.id}>
                    <TableCell className="w-10">
                      <RowCheckbox leadId={lead.id} />
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell key={col.key}>{col.cell(lead)}</TableCell>
                    ))}
                    <TableCell className="w-[120px] text-right">
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
