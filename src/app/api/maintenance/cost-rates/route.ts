import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { runCostRatesRefresh } from "@/lib/costs/refresh-rates";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/** One ElevenLabs read plus up to eight Twilio usage reads; pg_net gives up
 *  at 30s, so give the function the same budget. */
export const maxDuration = 30;

/**
 * Daily cost-rate refresh: derive the real ElevenLabs $/credit (plan price ÷
 * credits included) and Twilio $/minute per category (usage-record price ÷
 * usage) from the providers' own billing, and store them in `cost_rates`.
 * Every pricing helper reads that table first (lib/costs/effective-rates).
 * Secret-gated EXACTLY like /api/maintenance/retention: x-dialer-secret ==
 * DIALER_TICK_SECRET, or a signed-in admin (so it can be triggered by hand
 * from a browser session). pg_cron hits this at 04:15 UTC.
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
    const summary = await runCostRatesRefresh(admin);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
