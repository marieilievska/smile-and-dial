import { Ban, SearchX, Upload, X } from "lucide-react";
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
import { createClient } from "@/lib/supabase/server";

import { AddDncDialog } from "./add-dnc-dialog";
import { DncBulkActionBar } from "./bulk-action-bar";
import { CopyPhoneButton } from "./copy-phone";
import { DncFilters } from "./dnc-filters";
import { DncStatStrip } from "./dnc-stat-strip";
import { formatAddedAt } from "./format-added";
import { RemoveDncDialog } from "./remove-dnc-dialog";
import { RowCheckbox, SelectAllCheckbox, SelectionProvider } from "./selection";
import { fetchDncStats } from "./stats-query";
import { SmartPagination } from "../leads/smart-pagination";

const REASON_LABELS: Record<string, string> = {
  dnc_requested: "Caller requested",
  invalid_number: "Invalid number",
  language_barrier: "Language barrier",
  manual: "Manual",
  imported: "Imported",
};

const REASON_OPTIONS = Object.keys(REASON_LABELS);

/** Tone palette for the reason badge column. Caller-requested is the
 *  most "active" signal (someone explicitly asked) — coral. Invalid
 *  number is a system fact, no judgement needed — muted. Imported is
 *  bulk provenance — info/secondary blue tone. Manual and language
 *  barrier are everyday secondary. */
function reasonBadgeVariant(
  reason: string,
): "warning" | "secondary" | "outline" | "ghost" {
  switch (reason) {
    case "dnc_requested":
      return "warning";
    case "imported":
      return "outline";
    case "invalid_number":
      return "ghost";
    default:
      return "secondary";
  }
}

const ALLOWED_PAGE_SIZES = new Set([25, 50, 100]);
const DEFAULT_PAGE_SIZE = 25;

function dateStr(value: string | string[] | undefined): string {
  const s = typeof value === "string" ? value : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function str(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function intParam(
  value: string | string[] | undefined,
  fallback: number,
): number {
  const s = typeof value === "string" ? value : "";
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export default async function DncPage({
  searchParams,
}: {
  searchParams: Promise<{
    reason?: string;
    from?: string;
    to?: string;
    page?: string;
    per?: string;
  }>;
}) {
  const params = await searchParams;
  const reasonFilter = REASON_OPTIONS.includes(str(params.reason))
    ? str(params.reason)
    : "";
  const fromFilter = dateStr(params.from);
  const toFilter = dateStr(params.to);
  const page = intParam(params.page, 1);
  const requestedPageSize = intParam(params.per, DEFAULT_PAGE_SIZE);
  const pageSize = ALLOWED_PAGE_SIZES.has(requestedPageSize)
    ? requestedPageSize
    : DEFAULT_PAGE_SIZE;

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
  const isAdmin = me?.role === "admin";

  let query = supabase
    .from("dnc_entries")
    .select("id, phone, company_snapshot, reason, added_by_user_id, added_at", {
      count: "exact",
    })
    .order("added_at", { ascending: false });
  if (reasonFilter) query = query.eq("reason", reasonFilter);
  if (fromFilter) query = query.gte("added_at", fromFilter);
  if (toFilter) query = query.lte("added_at", `${toFilter}T23:59:59.999Z`);
  const offset = (page - 1) * pageSize;
  query = query.range(offset, offset + pageSize - 1);

  const [{ data: rawEntries, count }, stats] = await Promise.all([
    query,
    fetchDncStats(supabase),
  ]);
  const entries = rawEntries ?? [];
  const total = count ?? 0;

  const userIds = [
    ...new Set(
      entries
        .map((e) => e.added_by_user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const userName = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", userIds);
    for (const profile of profiles ?? []) {
      userName.set(profile.id, profile.full_name || profile.email || "—");
    }
  }

  const rowsForSelection = entries.map((e) => ({ id: e.id, phone: e.phone }));
  const filtersActive = Boolean(reasonFilter || fromFilter || toFilter);
  const now = new Date();

  // Active-filter chips above the table, each a click-to-remove link
  // that re-pushes the URL without that filter.
  function chipHref(removeKey: string): string {
    const next = new URLSearchParams();
    if (reasonFilter && removeKey !== "reason")
      next.set("reason", reasonFilter);
    if (fromFilter && removeKey !== "from") next.set("from", fromFilter);
    if (toFilter && removeKey !== "to") next.set("to", toFilter);
    const qs = next.toString();
    return qs ? `/dnc?${qs}` : "/dnc";
  }

  return (
    <SelectionProvider allRows={rowsForSelection}>
      <div className="flex flex-col gap-6 p-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-baseline gap-3">
              <h1 className="text-foreground text-2xl font-bold tracking-tight">
                Do not call
              </h1>
              {stats.total > 0 ? (
                <span className="text-muted-foreground text-sm tabular-nums">
                  {stats.total.toLocaleString()}{" "}
                  {stats.total === 1 ? "number" : "numbers"}
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              Workspace-wide list of phone numbers the dialer must skip.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" asChild>
              <Link href="/dnc/import">
                <Upload className="size-4" />
                Import
              </Link>
            </Button>
            <AddDncDialog />
          </div>
        </div>

        <DncStatStrip stats={stats} />

        <div className="flex justify-end">
          <DncFilters />
        </div>

        {filtersActive ? (
          <div
            data-testid="dnc-active-filters"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase">
              Active
            </span>
            {reasonFilter ? (
              <FilterChip
                label={`Reason: ${REASON_LABELS[reasonFilter] ?? reasonFilter}`}
                href={chipHref("reason")}
              />
            ) : null}
            {fromFilter ? (
              <FilterChip
                label={`From ${fromFilter}`}
                href={chipHref("from")}
              />
            ) : null}
            {toFilter ? (
              <FilterChip label={`To ${toFilter}`} href={chipHref("to")} />
            ) : null}
            <Link
              href="/dnc"
              className="text-muted-foreground hover:text-foreground ml-1 text-xs underline-offset-4 hover:underline"
            >
              Clear all
            </Link>
          </div>
        ) : null}

        <DncBulkActionBar isAdmin={isAdmin} />

        {entries.length > 0 ? (
          <>
            <div className="border-border overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <SelectAllCheckbox />
                    </TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Added by</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead className="bg-background sticky right-0 w-28 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => (
                    <TableRow key={entry.id} className="group">
                      <TableCell>
                        <RowCheckbox id={entry.id} phone={entry.phone} />
                      </TableCell>
                      <TableCell className="font-mono text-xs font-medium">
                        {entry.phone}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.company_snapshot || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={reasonBadgeVariant(entry.reason)}>
                          {REASON_LABELS[entry.reason] ?? entry.reason}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {entry.added_by_user_id
                          ? (userName.get(entry.added_by_user_id) ?? "—")
                          : "—"}
                      </TableCell>
                      <TableCell
                        className="text-muted-foreground tabular-nums"
                        title={new Date(entry.added_at).toLocaleString()}
                      >
                        {formatAddedAt(entry.added_at, now)}
                      </TableCell>
                      <TableCell
                        className="bg-background sticky right-0 text-right"
                        style={{
                          backgroundColor:
                            "color-mix(in oklab, var(--muted) 0%, var(--background))",
                        }}
                      >
                        <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <CopyPhoneButton phone={entry.phone} />
                          {isAdmin ? (
                            <RemoveDncDialog phone={entry.phone} />
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <SmartPagination
              page={page}
              pageSize={pageSize}
              total={total}
              basePath="/dnc"
            />
          </>
        ) : filtersActive ? (
          <div
            data-testid="dnc-empty-filtered"
            className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center"
          >
            <SearchX className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              No DNC entries match these filters
            </p>
            <p className="text-muted-foreground max-w-xs text-sm">
              Try widening the date range or removing the reason filter.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/dnc">Clear filters</Link>
            </Button>
          </div>
        ) : (
          <div
            data-testid="dnc-empty-initial"
            className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center"
          >
            <Ban className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              No numbers on DNC yet
            </p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Numbers added here are blocked at dial time. Use{" "}
              <span className="text-foreground font-medium">Add number</span>{" "}
              above for a single addition, or import a CSV.
            </p>
            <Button asChild variant="outline" size="sm" className="mt-2">
              <Link href="/dnc/import">
                <Upload className="size-4" />
                Import CSV
              </Link>
            </Button>
          </div>
        )}
      </div>
    </SelectionProvider>
  );
}

function FilterChip({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="border-border bg-card hover:bg-muted/60 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
    >
      <span className="text-foreground">{label}</span>
      <X className="text-muted-foreground size-3" />
    </Link>
  );
}
