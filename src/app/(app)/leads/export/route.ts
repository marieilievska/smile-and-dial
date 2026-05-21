import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

import {
  DEFAULT_COLUMN_KEYS,
  LEAD_COLUMNS,
  type DisplayLead,
} from "../columns";
import { buildLeadsQuery, parseSort, str } from "../leads-query";
import type { SearchParams } from "../leads-url";

// A generous ceiling so a full workspace exports in one file.
const EXPORT_LIMIT = 50000;

// A byte-order mark keeps Excel from mangling accented characters.
const BOM = "﻿";

/** Quote a CSV field and escape any embedded quotes. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Export the leads matching the current Leads-page filters as a CSV. The
 * query string carries the same search, filters, sort, and visible-column
 * params as the table, so the download mirrors exactly what the user sees.
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
  const { sort, dir } = parseSort(params);

  const { data } = await buildLeadsQuery(supabase, params)
    .order(sort, { ascending: dir === "asc" })
    .order("id", { ascending: true })
    .range(0, EXPORT_LIMIT - 1);
  const rawLeads = data ?? [];

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
    listName: l.list?.name ?? "",
    ownerName: ownerName.get(l.owner_id) ?? "",
  }));

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
