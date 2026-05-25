import { ChevronLeft, ChevronRight, Phone, PhoneIncoming } from "lucide-react";
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

import { CallsFilters } from "./calls-filters";
import {
  buildCallsQuery,
  parseSort,
  resolveSearchLeadIds,
  str,
} from "./calls-query";
import { callsHref, type SearchParams } from "./calls-url";
import { SortableHeader } from "./sortable-header";

const PAGE_SIZE = 25;

// Outcomes that count as a "connection" for color/styling purposes — same
// definition the connect-rate monitor uses.
const NON_CONNECT_OUTCOMES = new Set([
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "invalid_number",
]);

function fmtDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtCost(breakdown: unknown): string {
  if (!breakdown || typeof breakdown !== "object") return "—";
  const total = (breakdown as { total?: unknown }).total;
  if (typeof total !== "number") return "—";
  return `$${total.toFixed(2)}`;
}

function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  return d.toLocaleString();
}

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

  // Campaigns drive the filter dropdown. RLS scopes this for members.
  const { data: campaigns } = await supabase
    .from("campaigns")
    .select("id, name")
    .order("name");

  const searchLeadIds = await resolveSearchLeadIds(supabase, params);
  const offset = (page - 1) * PAGE_SIZE;
  const { data, count } = await buildCallsQuery(
    supabase,
    params,
    searchLeadIds ?? undefined,
  )
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  const rows = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Calls
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Every outbound and inbound call. Filter and sort to drill in.
        </p>
      </div>

      <CallsFilters
        campaigns={campaigns ?? []}
        initial={{
          q: str(params.q),
          direction: str(params.direction),
          status: str(params.status),
          outcome: str(params.outcome),
          campaign: str(params.campaign),
          from: str(params.from),
          to: str(params.to),
        }}
      />

      {rows.length > 0 ? (
        <>
          <div className="border-border overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Company</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Agent</TableHead>
                  <SortableHeader
                    label="Started"
                    sortKey="started_at"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                  />
                  <SortableHeader
                    label="Duration"
                    sortKey="duration_seconds"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                  />
                  <SortableHeader
                    label="Talk"
                    sortKey="talk_time_seconds"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                  />
                  <SortableHeader
                    label="Status"
                    sortKey="status"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                  />
                  <SortableHeader
                    label="Outcome"
                    sortKey="outcome"
                    currentSort={sort}
                    currentDir={dir}
                    params={params}
                  />
                  <TableHead>Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      {c.direction === "inbound" ? (
                        <PhoneIncoming
                          className="text-muted-foreground size-4"
                          aria-label="Inbound"
                        />
                      ) : (
                        <Phone
                          className="text-muted-foreground size-4"
                          aria-label="Outbound"
                        />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      {c.lead?.company ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.lead?.business_phone ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.campaign?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {c.agent?.name ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDateTime(c.started_at)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDuration(c.duration_seconds)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {fmtDuration(c.talk_time_seconds)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{c.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {c.outcome ? (
                        <Badge
                          variant={
                            c.outcome && NON_CONNECT_OUTCOMES.has(c.outcome)
                              ? "outline"
                              : "default"
                          }
                        >
                          {c.outcome}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {fmtCost(c.cost_breakdown)}
                    </TableCell>
                  </TableRow>
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
    </div>
  );
}
