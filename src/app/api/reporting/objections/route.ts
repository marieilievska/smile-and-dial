import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { runObjectionExtraction } from "@/lib/reporting/objection-worker";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/** Drain a batch of the objection-extraction queue. Secret-gated EXACTLY like
 *  /api/smart-lists/refresh: x-dialer-secret == DIALER_TICK_SECRET, or a
 *  signed-in admin. pg_cron hits this every few minutes via pg_net. */
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
    const summary = await runObjectionExtraction(admin, { limit: 25 });
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
