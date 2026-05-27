import { NextResponse, type NextRequest } from "next/server";

import { runDialerTick } from "@/lib/dialer/tick";
import { createClient } from "@/lib/supabase/server";

/**
 * Manually fire one dialer tick. This is the endpoint pg_cron will hit
 * (via pg_net) when the cron schedule lands in 21c. For now it's protected
 * two ways:
 *
 *  1. A signed-in admin (the dashboard's "Run dialer once" debug button —
 *     not built yet, but the auth path is here so it works the day we add
 *     one).
 *  2. An HTTP header `x-dialer-secret` equal to `DIALER_TICK_SECRET`. Used
 *     by Playwright and by the (future) pg_cron job.
 *
 * Either is sufficient — no one else can fire the tick.
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

  // Optional `?lead_ids=<csv>` narrows the tick to those leads. Used by
  // Playwright so tick events fired by one test can't accidentally dial
  // another test's seeded leads. Production cron calls always omit this.
  const leadIdsParam = request.nextUrl.searchParams.get("lead_ids");
  const leadIds = leadIdsParam
    ? leadIdsParam.split(",").filter(Boolean)
    : undefined;

  try {
    const summary = await runDialerTick({ leadIds });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
