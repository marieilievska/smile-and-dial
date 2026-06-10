import { type NextRequest } from "next/server";

import {
  fetchAllMatchingLeadIds,
  fetchLeadRowsByIds,
} from "@/lib/leads/fetch-all-ids";
import { createClient } from "@/lib/supabase/server";

import {
  DEFAULT_COLUMN_KEYS,
  LEAD_COLUMNS,
  type DisplayLead,
} from "../columns";
import { parseSort, str } from "../leads-query";
import type { SearchParams } from "../leads-url";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

// A byte-order mark keeps Excel from mangling accented characters.
const BOM = "﻿";

/** Quote a CSV field and escape any embedded quotes. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

type RawLead = Record<string, unknown> & {
  id: string;
  owner_id: string;
  list?: { name?: string | null } | null;
};

/** Shape a raw leads row into the DisplayLead the column renderers expect. */
function toDisplayLead(
  l: RawLead,
  ownerName: Map<string, string>,
): DisplayLead {
  return {
    id: l.id,
    company: l.company as string,
    business_phone: l.business_phone as string | null,
    business_email: l.business_email as string | null,
    status: l.status as string,
    last_outcome: l.last_outcome as string | null,
    category: l.category as string | null,
    decision_maker_reached: (l.decision_maker_reached as boolean) ?? false,
    city: l.city as string | null,
    state: l.state as string | null,
    conversations: l.conversations as number,
    call_attempts: l.call_attempts as number,
    last_call_at: l.last_call_at as string | null,
    next_call_at: l.next_call_at as string | null,
    listId: (l.list_id as string | null) ?? null,
    listName: l.list?.name ?? "",
    ownerName: ownerName.get(l.owner_id) ?? "",
  };
}

/** Build the CSV body from raw leads rows and the requested visible columns. */
async function buildCsv(
  supabase: SupabaseServerClient,
  rawLeads: RawLead[],
  params: SearchParams,
): Promise<Response> {
  // Owner names.
  const ownerIds = [...new Set(rawLeads.map((l) => l.owner_id))];
  const ownerName = new Map<string, string>();
  if (ownerIds.length > 0) {
    const { data: owners } = await supabase
      .from("profiles")
      .select("id, full_name, email")
      .in("id", ownerIds);
    for (const owner of owners ?? []) {
      ownerName.set(owner.id, owner.full_name || owner.email || "");
    }
  }

  const leads = rawLeads.map((l) => toDisplayLead(l, ownerName));

  // Visible columns, in table order.
  const colsParam = str(params.cols);
  const visibleKeys = colsParam
    ? new Set(colsParam.split(","))
    : new Set(DEFAULT_COLUMN_KEYS);
  const columns = LEAD_COLUMNS.filter((c) => visibleKeys.has(c.key));

  const rows = [
    columns.map((c) => c.label),
    ...leads.map((lead) => columns.map((c) => c.text(lead))),
  ];
  const csv =
    BOM + rows.map((cells) => cells.map(csvField).join(",")).join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="leads.csv"',
    },
  });
}

/** Sort raw leads rows the same way the table would, for a stable export. */
function sortRows(rows: RawLead[], params: SearchParams): RawLead[] {
  const { sort, dir } = parseSort(params);
  const factor = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sort];
    const bv = b[sort];
    // Nulls sort last regardless of direction.
    if (av == null && bv == null) return a.id < b.id ? -1 : 1;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * factor;
    if (av > bv) return 1 * factor;
    // Stable tie-break on id, matching the table's secondary order.
    return a.id < b.id ? -1 : 1;
  });
}

/**
 * Export every lead matching the current Leads-page filters as a CSV. The
 * query string carries the same search, filters, sort, and visible-column
 * params as the table, so the download mirrors exactly what the user sees.
 *
 * Pages past PostgREST's 1,000-row response cap via the shared keyset helper
 * (`fetchAllMatchingLeadIds` → `fetchLeadRowsByIds`) so a full workspace of
 * ~8k leads exports completely instead of being silently truncated at 1,000.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const params: SearchParams = Object.fromEntries(
    request.nextUrl.searchParams.entries(),
  );

  // Fetch ALL matching ids (keyset paged), then re-hydrate full rows in
  // chunks. This is the "export everything matching the filter" path.
  const { ids, error } = await fetchAllMatchingLeadIds(supabase, params);
  if (error) return new Response("Could not export leads.", { status: 500 });

  const { rows, error: rowsError } = await fetchLeadRowsByIds(supabase, ids);
  if (rowsError) {
    return new Response("Could not export leads.", { status: 500 });
  }

  const sorted = sortRows(rows as RawLead[], params);
  return buildCsv(supabase, sorted, params);
}

/**
 * Export a specific set of leads (the "Export selected" action) as a CSV.
 * The ids arrive in the POST body instead of the query string so a large
 * selection — thousands of ids from "select all matching" — can't overflow
 * the request URL the way a GET `?ids=…` would.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  let body: { ids?: unknown; cols?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid request body.", { status: 400 });
  }

  const ids = Array.isArray(body.ids)
    ? body.ids.filter((id): id is string => typeof id === "string")
    : [];
  if (ids.length === 0) {
    return new Response("No leads selected.", { status: 400 });
  }

  // `cols` rides along in the body so the export honours the table's visible
  // columns, matching the GET path's `?cols=` behaviour.
  const params: SearchParams = {};
  if (typeof body.cols === "string") params.cols = body.cols;

  const { rows, error } = await fetchLeadRowsByIds(supabase, ids);
  if (error) return new Response("Could not export leads.", { status: 500 });

  const sorted = sortRows(rows as RawLead[], params);
  return buildCsv(supabase, sorted, params);
}
