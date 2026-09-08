import { NextResponse, type NextRequest } from "next/server";

import { isSuperAdmin } from "@/lib/auth/roles";
import { createClient } from "@/lib/supabase/server";
import { reconcileShakenNumbers } from "@/lib/twilio/shaken";

/**
 * Reconcile SHAKEN/STIR signing: make the parent Trust Hub's trust product and
 * supporting customer profile hold exactly the numbers the subaccount owns.
 *
 * The backstop for `assignNumberToShaken`, which is best-effort at purchase
 * time and has no retry of its own — on 2026-09-02 its product POST failed for
 * ten of 97 numbers and they dialled unsigned for six days. A pg_cron job
 * (`shaken-reconcile`, every 30 minutes) POSTs this; it used to be a Windows
 * scheduled task running a script that nothing in the repo referenced, so when
 * the task stopped running nobody noticed and the script was later deleted as
 * dead code.
 *
 * Secret-gated EXACTLY like /api/best-time/refresh and /api/dialer/tick — the
 * same `x-dialer-secret` header compared to `DIALER_TICK_SECRET`, with a
 * signed-in super-admin fallback (this reconciles the SHARED Twilio account,
 * not one person's numbers) so a "Reconcile now" button works too. Either is
 * sufficient; nothing else can fire it.
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

  try {
    const result = await reconcileShakenNumbers();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
