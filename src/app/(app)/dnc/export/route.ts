import { type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

const EXPORT_LIMIT = 50000;
const BOM = "﻿";

const REASON_LABELS: Record<string, string> = {
  dnc_requested: "Caller requested",
  invalid_number: "Invalid number",
  language_barrier: "Language barrier",
  manual: "Manual",
  imported: "Imported",
};

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function str(value: string | string[] | undefined | null): string {
  return typeof value === "string" ? value : "";
}

/**
 * Export DNC entries as CSV. With `?ids=…` (from "Export selected") narrows
 * to those rows. Otherwise honors the same `reason` / `from` / `to` filters
 * as the /dnc page so the file mirrors what the user is looking at.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const params = request.nextUrl.searchParams;
  const idsParam = str(params.get("ids"));
  const reason = str(params.get("reason"));
  const from = str(params.get("from"));
  const to = str(params.get("to"));

  let query = supabase
    .from("dnc_entries")
    .select("id, phone, company_snapshot, reason, added_by_user_id, added_at")
    .order("added_at", { ascending: false });
  if (idsParam) {
    query = query.in("id", idsParam.split(",").filter(Boolean));
  }
  if (reason) query = query.eq("reason", reason);
  if (from) query = query.gte("added_at", from);
  if (to) query = query.lte("added_at", `${to}T23:59:59.999Z`);

  const { data: entries } = await query.range(0, EXPORT_LIMIT - 1);
  const rows = entries ?? [];

  const userIds = [
    ...new Set(
      rows
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
      userName.set(profile.id, profile.full_name || profile.email || "");
    }
  }

  const header = ["Phone", "Company", "Reason", "Added by", "Added at"];
  const body = rows.map((row) => [
    row.phone,
    row.company_snapshot ?? "",
    REASON_LABELS[row.reason] ?? row.reason,
    row.added_by_user_id ? (userName.get(row.added_by_user_id) ?? "") : "",
    row.added_at,
  ]);

  const csv =
    BOM +
    [header, ...body]
      .map((cells) => cells.map(csvField).join(","))
      .join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="dnc.csv"',
    },
  });
}
