import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { refreshSmartListMembers } from "@/lib/smart-lists/cache";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

// Every attached list is rebuilt in one pass (delete + re-select over all of
// the owner's leads, per list). Give the pass a full minute so a large
// workspace can't hit the default function timeout part-way through the loop.
export const maxDuration = 60;

/**
 * Rebuild the smart-list membership cache for every attached smart list. The
 * pg_cron job hits this every few minutes (via pg_net); an attach also kicks an
 * immediate refresh inline (see campaigns/actions). Secret-gated EXACTLY like
 * /api/dialer/tick and /api/best-time/refresh — the `x-dialer-secret` header
 * compared to DIALER_TICK_SECRET, with a signed-in admin fallback.
 *
 * Responds with `{ ok, refreshed, failed, totalMembers, failures }`. A list
 * that fails to rebuild is counted in `failed` (and recorded on the list +
 * system_events by the refresh itself) rather than aborting the pass, so one
 * bad recipe can never leave every other list stale.
 */
export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-dialer-secret");
  const expected = process.env.DIALER_TICK_SECRET ?? "";

  let authorized = false;
  if (expected && secret && secret === expected) {
    authorized = true;
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (me?.role === "admin") authorized = true;
    }
  }

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return NextResponse.json(
      { error: "Supabase service role env missing." },
      { status: 500 },
    );
  }

  try {
    const admin = createServiceClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await refreshSmartListMembers(admin);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
