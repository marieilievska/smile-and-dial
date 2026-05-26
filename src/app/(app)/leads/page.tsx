import { Download, Search, Upload, Users } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

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
import { type CustomFieldType } from "@/lib/custom-fields/actions";
import { IMPORTABLE_FIELDS } from "@/lib/leads/import-fields";
import { createClient } from "@/lib/supabase/server";

import { BulkActionBar } from "./bulk-action-bar";
import { ColumnPicker } from "./column-picker";
import { DEFAULT_COLUMN_KEYS, LEAD_COLUMNS, type DisplayLead } from "./columns";
import {
  LeadDetailModal,
  type CustomFieldDef,
  type LeadEvent,
  type LeadMeta,
} from "./lead-detail-modal";
import { LeadRow } from "./lead-row";
import { LeadsFilters } from "./leads-filters";
import { buildLeadsQuery, parseSort, str } from "./leads-query";
import { leadsHref, type SearchParams } from "./leads-url";
import { SavedViews } from "./saved-views";
import { RowCheckbox, SelectAllCheckbox, SelectionProvider } from "./selection";
import { SortableHeader } from "./sortable-header";

const PAGE_SIZE = 25;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const query = str(params.q);
  const { sort, dir } = parseSort(params);
  const page = Math.max(1, Number(params.page) || 1);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const offset = (page - 1) * PAGE_SIZE;
  const { data, count } = await buildLeadsQuery(supabase, params)
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(offset, offset + PAGE_SIZE - 1);

  const rawLeads = data ?? [];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

  // Filter controls need the user's lists and saved views; bulk actions need
  // the current user's role (and, for admins, the possible owners).
  const [{ data: lists }, { data: views }, { data: me }] = await Promise.all([
    supabase.from("lists").select("id, name").order("name"),
    supabase
      .from("saved_views")
      .select("id, name, params")
      .eq("page", "leads")
      .order("created_at", { ascending: true }),
    supabase.from("profiles").select("role").eq("id", user.id).single(),
  ]);
  const isAdmin = me?.role === "admin";

  let owners: { id: string; name: string }[] = [];
  if (isAdmin) {
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .order("full_name");
    owners = (people ?? []).map((p) => ({
      id: p.id,
      name: p.full_name || p.email || "Unknown",
    }));
  }

  // Lead detail modal: load the full lead when ?lead=<id> is set.
  const leadParam = str(params.lead);
  let leadDetail: {
    id: string;
    company: string | null;
    fieldValues: Record<string, string>;
    customFields: CustomFieldDef[];
    customValues: Record<string, unknown>;
    meta: LeadMeta;
    events: LeadEvent[];
    availableCampaigns: { id: string; name: string }[];
  } | null = null;
  if (/^[0-9a-f-]{36}$/i.test(leadParam)) {
    const [{ data: lead }, { data: defs }, { data: values }] =
      await Promise.all([
        supabase
          .from("leads")
          .select("*, list:lists(name, is_inbound_default)")
          .eq("id", leadParam)
          .is("deleted_at", null)
          .maybeSingle(),
        supabase
          .from("custom_field_defs")
          .select("id, name, type, options, sort_order")
          .order("sort_order", { ascending: true }),
        supabase
          .from("lead_custom_values")
          .select("custom_field_id, value")
          .eq("lead_id", leadParam),
      ]);
    if (lead) {
      const row = lead as Record<string, unknown>;
      const fieldValues: Record<string, string> = {};
      for (const f of IMPORTABLE_FIELDS) {
        const value = row[f.key];
        fieldValues[f.key] = value == null ? "" : String(value);
      }
      // Active campaigns attached to this lead's list — what the user
      // can pick from in the Call Now dialog.
      const { data: campaignRows } = await supabase
        .from("list_campaign_attachments")
        .select("campaign:campaigns(id, name, status)")
        .eq("list_id", lead.list_id)
        .is("detached_at", null);
      type Joined = {
        campaign: { id: string; name: string; status: string } | null;
      };
      const availableCampaigns = ((campaignRows ?? []) as unknown as Joined[])
        .map((r) => r.campaign)
        .filter(
          (c): c is { id: string; name: string; status: string } =>
            Boolean(c) && c!.status === "active",
        )
        .map((c) => ({ id: c.id, name: c.name }));
      leadDetail = {
        availableCampaigns,
        id: lead.id,
        company: lead.company,
        fieldValues,
        customFields: (defs ?? []).map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type as CustomFieldType,
          options: Array.isArray(d.options)
            ? d.options.filter((o): o is string => typeof o === "string")
            : [],
        })),
        customValues: Object.fromEntries(
          (values ?? []).map((v) => [v.custom_field_id, v.value]),
        ),
        meta: {
          status: lead.status,
          lastOutcome: lead.last_outcome,
          listName: lead.list?.name ?? "—",
          isInbound: lead.list?.is_inbound_default ?? false,
          retryCounter: lead.retry_counter,
          restingUntil: lead.resting_until,
          nextCallAt: lead.next_call_at,
          aiSummary: lead.ai_summary,
        },
        events: [{ id: "created", label: "Lead created", at: lead.created_at }],
      };
    }
  }

  // Hidden inputs so the search form preserves filters, sort, and columns.
  const preservedParams = Object.entries(params).filter(
    ([key, value]) =>
      typeof value === "string" &&
      value &&
      key !== "q" &&
      key !== "page" &&
      key !== "lead",
  ) as [string, string][];

  // Export carries every filter except pagination — it exports all matches.
  const exportQs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (
      typeof value === "string" &&
      value &&
      key !== "page" &&
      key !== "lead"
    ) {
      exportQs.set(key, value);
    }
  }
  const exportHref = exportQs.toString()
    ? `/leads/export?${exportQs}`
    : "/leads/export";

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

      <div className="flex flex-wrap items-center gap-2">
        <form method="get" action="/leads" className="flex flex-1 gap-2">
          {preservedParams.map(([key, value]) => (
            <input key={key} type="hidden" name={key} value={value} />
          ))}
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
        <LeadsFilters lists={lists ?? []} />
        <ColumnPicker />
        <SavedViews views={views ?? []} />
        <Button asChild variant="outline">
          <a href={exportHref}>
            <Download className="size-4" />
            Export
          </a>
        </Button>
        <Button asChild variant="outline">
          <Link href="/leads/import">
            <Upload className="size-4" />
            Import
          </Link>
        </Button>
      </div>

      <SelectionProvider allIds={leads.map((l) => l.id)}>
        <BulkActionBar lists={lists ?? []} owners={owners} isAdmin={isAdmin} />
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
                  </LeadRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
            <Users className="text-muted-foreground size-8" />
            <p className="text-foreground text-sm font-medium">
              No leads match
            </p>
            <p className="text-muted-foreground text-sm">
              Try a different search or clear your filters.
            </p>
          </div>
        )}
      </SelectionProvider>

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
                <Link href={leadsHref(params, { page: String(page - 1) })}>
                  Previous
                </Link>
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
                <Link href={leadsHref(params, { page: String(page + 1) })}>
                  Next
                </Link>
              ) : (
                <span>Next</span>
              )}
            </Button>
          </div>
        </div>
      ) : null}

      {leadDetail ? (
        <LeadDetailModal
          leadId={leadDetail.id}
          leadCompany={leadDetail.company}
          fieldValues={leadDetail.fieldValues}
          customFields={leadDetail.customFields}
          customValues={leadDetail.customValues}
          meta={leadDetail.meta}
          events={leadDetail.events}
          availableCampaigns={leadDetail.availableCampaigns}
        />
      ) : null}
    </div>
  );
}
