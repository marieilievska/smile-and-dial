import { NextResponse, type NextRequest } from "next/server";

import { warmBookingCopies } from "@/lib/calendly/copy-store";
import { runDialerTick } from "@/lib/dialer/tick";
import { afterResponse } from "@/lib/server/after-response";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isSuperAdmin } from "@/lib/auth/roles";

/**
 * Manually fire one dialer tick. This is the endpoint pg_cron will hit
 * (via pg_net) when the cron schedule lands in 21c. For now it's protected
 * two ways:
 *
 *  1. A signed-in super admin (the dashboard's "Run dialer once" debug button —
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
      if (isSuperAdmin(me?.role)) authorized = true;
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
    // Top up the booking tools' copy of Calendly's open times for the campaigns
    // that just dialled — AFTER the response, so it can never lengthen a tick
    // or delay a dial. At most one Calendly read per event per minute, and none
    // when nothing is dialling.
    const dialedCampaignIds = summary.dialedCampaignIds ?? [];
    if (dialedCampaignIds.length > 0) {
      await afterResponse(() =>
        warmBookingCopies(createAdminClient(), dialedCampaignIds),
      );
    }
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
