import { type NextRequest } from "next/server";

import { createClient as createAdminClient } from "@supabase/supabase-js";

import { deriveCountry } from "@/lib/meta/audience-fields";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

const BOM = "﻿";

function csvCell(v: string): string {
  return `"${v.replace(/"/g, '""')}"`;
}

function digits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

/**
 * Export the eligible audience (one CSV, all leads) for manual upload to Meta.
 * Admin-only and service-role-backed so it matches exactly what the automated
 * sync would push — every lead with an email, excluding deleted and DNC
 * (status OR phone on the DNC list). Raw values; Meta hashes on upload.
 */
export async function GET(_request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Not signed in.", { status: 401 });
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") {
    return new Response("Admins only.", { status: 403 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const admin = createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // DNC phones (digits) to exclude.
  const dnc = new Set<string>();
  {
    const { data: entries } = await admin
      .from("dnc_entries")
      .select("phone")
      .limit(100000);
    for (const e of entries ?? []) {
      const d = digits(e.phone);
      if (d) dnc.add(d);
    }
  }

  const { data } = await admin
    .from("leads")
    .select("business_email, business_phone, city, state")
    .is("deleted_at", null)
    .neq("status", "dnc")
    .not("business_email", "is", null)
    .limit(100000);
  const leads = (data ?? []).filter((l) => !dnc.has(digits(l.business_phone)));

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
