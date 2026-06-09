import { type NextRequest } from "next/server";

import { deriveCountry } from "@/lib/meta/audience-fields";
import { createClient } from "@/lib/supabase/server";

const BOM = "﻿";

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });

  const { data } = await supabase
    .from("leads")
    .select("business_email, business_phone, city, state")
    .is("deleted_at", null)
    .neq("status", "dnc")
    .not("business_email", "is", null)
    .limit(100000);
  const leads = data ?? [];

  const rows = [
    ["email", "phone", "ct", "st", "country"],
    ...leads.map((l) => [
      l.business_email ?? "",
      l.business_phone ?? "",
      l.city ?? "",
      l.state ?? "",
      deriveCountry(l),
    ]),
  ];
  const csv = BOM + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="meta-audience.csv"',
    },
  });
}
