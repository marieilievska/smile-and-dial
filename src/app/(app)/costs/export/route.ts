import { NextResponse } from "next/server";

import {
  fetchCostRows,
  pickBreakdown,
  resolveDatePreset,
  type Slicers,
} from "@/lib/analytics/costs";
import { createClient } from "@/lib/supabase/server";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function str(value: string | null): string {
  return value ?? "";
}

function csvEscape(value: string | number | null | undefined): string {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** CSV export for /costs. Returns one row per call with the breakdown
 *  expanded into individual columns — most useful slice for a PM
 *  dropping spend numbers into a spreadsheet or board update.
 *
 *  Honours the same slicers the page uses, so "Export CSV" downloads
 *  exactly what's currently on screen — not the full history. */
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  }

  const url = new URL(request.url);
  const preset = str(url.searchParams.get("preset")) || "last30";
  const fromParam = str(url.searchParams.get("from"));
  const toParam = str(url.searchParams.get("to"));
  const { from, to } = resolveDatePreset(preset, {
    from: DATE_RE.test(fromParam) ? fromParam : undefined,
    to: DATE_RE.test(toParam) ? toParam : undefined,
  });
  const campaignId = UUID_RE.test(str(url.searchParams.get("campaign")))
    ? str(url.searchParams.get("campaign"))
    : undefined;
  const ownerId = UUID_RE.test(str(url.searchParams.get("user")))
    ? str(url.searchParams.get("user"))
    : undefined;
  const listId = UUID_RE.test(str(url.searchParams.get("list")))
    ? str(url.searchParams.get("list"))
    : undefined;

  const slicers: Slicers = { from, to, campaignId, ownerId, listId };
  const rows = await fetchCostRows(supabase, slicers);

  // Resolve campaign names so the CSV is human-readable.
  const campaignIds = Array.from(new Set(rows.map((r) => r.campaign_id)));
  const campaignName = new Map<string, string>();
  if (campaignIds.length > 0) {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("id, name")
      .in("id", campaignIds);
    for (const c of campaigns ?? []) {
      campaignName.set((c as { id: string }).id, (c as { name: string }).name);
    }
  }

  const headers = [
    "call_id",
    "started_at",
    "campaign",
    "duration_seconds",
    "goal_met",
    "twilio",
    "elevenlabs",
    "openai",
    "lookup",
    "total",
  ];
  const lines: string[] = [headers.join(",")];
  for (const r of rows) {
    const b = pickBreakdown(r.cost_breakdown);
    lines.push(
      [
        r.id,
        r.started_at ?? r.created_at,
        campaignName.get(r.campaign_id) ?? "",
        r.duration_seconds ?? "",
        r.goal_met ? "true" : "false",
        b.twilio.toFixed(4),
        b.elevenlabs.toFixed(4),
        b.openai.toFixed(4),
        b.lookup.toFixed(4),
        b.total.toFixed(4),
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  const filename = `smile-and-dial-costs-${from}-to-${to}.csv`;
  return new Response(lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
