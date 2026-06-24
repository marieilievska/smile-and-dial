import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { repointInboundWebhooks } from "@/lib/twilio/inbound-guard";

/**
 * Re-assert our inbound voice/status webhooks on every active Twilio number.
 * ElevenLabs silently re-hijacks an imported number's voice webhook to its own
 * inbound handler after import, breaking app-bridged inbound — so a pg_cron job
 * hits this every few minutes to keep the numbers pointed back at the app.
 *
 * Secret-gated EXACTLY like /api/dialer/tick — `x-dialer-secret` compared to
 * DIALER_TICK_SECRET, with a signed-in admin fallback for a manual "fix now".
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
    const summary = await repointInboundWebhooks(admin);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
