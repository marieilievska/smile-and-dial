import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { runRetentionSweep } from "@/lib/maintenance/retention";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/** The sweep loops in batches for up to ~20s of its own budget; give the
 *  function headroom past pg_net's 30s timeout so a slow storage delete on
 *  the last batch still finishes instead of being cut off mid-update. */
export const maxDuration = 60;

/**
 * Nightly retention sweep: remove call audio + transcripts older than 90 days
 * from OUR storage/database and prune the raw ElevenLabs webhook log. The
 * call rows themselves (outcome, summary, extracted data, objections, cost)
 * are never touched. Secret-gated EXACTLY like /api/reporting/objections:
 * x-dialer-secret == DIALER_TICK_SECRET, or a signed-in admin (so it can be
 * triggered by hand from a browser session). pg_cron hits this at 03:30 UTC.
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
    const summary = await runRetentionSweep(admin, { days: 90, limit: 200 });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
