import { Search, Users } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createClient } from "@/lib/supabase/server";

import { SortableHeader } from "./sortable-header";

const PAGE_SIZE = 25;

const SORT_COLUMNS: Record<string, string> = {
  company: "company",
  status: "status",
  city: "city",
  state: "state",
  conversations: "conversations",
  call_attempts: "call_attempts",
  last_call: "last_call_at",
  next_call: "next_call_at",
  created: "created_at",
};

function humanize(value: string | null): string {
  if (!value) return "—";
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, " ");
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleDateString() : "—";
}

function statusVariant(
  status: string,
): "success" | "destructive" | "secondary" {
  if (["goal_met", "sale", "closed", "attended"].includes(status)) {
    return "success";
  }
  if (status === "dnc") return "destructive";
  return "secondary";
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const sortKey =
    typeof params.sort === "string" && params.sort in SORT_COLUMNS
      ? params.sort
      : "created";
  const dir: "asc" | "desc" = params.dir === "asc" ? "asc" : "desc";
  const page = Math.max(1, Number(params.page) || 1);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  let listQuery = supabase
    .from("leads")
    .select(
      "id, company, business_phone, business_email, status, last_outcome, city, state, conversations, call_attempts, last_call_at, next_call_at, owner_id, list:lists(name)",
      { count: "exact" },
    )
    .is("deleted_at", null);

  if (query) {
    const safe = query.replace(/[%,()\\*]/g, "").trim();
    if (safe) {
      listQuery = listQuery.or(
        `company.ilike.%${safe}%,business_phone.ilike.%${safe}%,business_email.ilike.%${safe}%`,
      );
    }
  }

  const from = (page - 1) * PAGE_SIZE;
  const { data, count } = await listQuery
    .order(SORT_COLUMNS[sortKey], { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  const leads = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Resolve owner names for the leads on this page.
  const ownerIds = [...new Set(leads.map((l) => l.owner_id))];
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

  function pageHref(target: number): string {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    p.set("sort", sortKey);
    p.set("dir", dir);
    p.set("page", String(target));
    return `/leads?${p.toString()}`;
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <div>
        <h1 className="text-foreground text-2xl font-bold tracking-tight">
          Leads
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {total} {total === 1 ? "lead" : "leads"}
        </p>
      </div>

      <form method="get" action="/leads" className="flex gap-2">
        <input type="hidden" name="sort" value={sortKey} />
        <input type="hidden" name="dir" value={dir} />
        <div className="relative max-w-sm flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            name="q"
            defaultValue={query}
            placeholder="Search company, phone, or email"
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>

      {leads.length > 0 ? (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHeader
                  label="Company"
                  column="company"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <TableHead>Phone</TableHead>
                <TableHead>Email</TableHead>
                <SortableHeader
                  label="Status"
                  column="status"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <TableHead>Last outcome</TableHead>
                <TableHead>List</TableHead>
                <SortableHeader
                  label="City"
                  column="city"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <SortableHeader
                  label="State"
                  column="state"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <SortableHeader
                  label="Conversations"
                  column="conversations"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <SortableHeader
                  label="Attempts"
                  column="call_attempts"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <SortableHeader
                  label="Last call"
                  column="last_call"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <SortableHeader
                  label="Next call"
                  column="next_call"
                  currentSort={sortKey}
                  currentDir={dir}
                  query={query}
                />
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow key={lead.id}>
                  <TableCell className="font-medium">
                    {lead.company || "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {lead.business_phone || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.business_email || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(lead.status)}>
                      {humanize(lead.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {humanize(lead.last_outcome)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.list?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.city || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.state || "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.conversations}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.call_attempts}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(lead.last_call_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(lead.next_call_at)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {ownerName.get(lead.owner_id) ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Users className="text-muted-foreground size-8" />
          <p className="text-foreground text-sm font-medium">
            {query ? "No leads match your search" : "No leads yet"}
          </p>
          <p className="text-muted-foreground text-sm">
            {query
              ? "Try a different company, phone, or email."
              : "Leads arrive through CSV import or the public API."}
          </p>
        </div>
      )}

      {leads.length > 0 ? (
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              asChild={page > 1}
              variant="outline"
              size="sm"
              disabled={page <= 1}
            >
              {page > 1 ? (
                <Link href={pageHref(page - 1)}>Previous</Link>
              ) : (
                <span>Previous</span>
              )}
            </Button>
            <Button
              asChild={page < totalPages}
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
            >
              {page < totalPages ? (
                <Link href={pageHref(page + 1)}>Next</Link>
              ) : (
                <span>Next</span>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
