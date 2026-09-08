import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { isSuperAdmin } from "@/lib/auth/roles";
import {
  DEFAULT_LIMIT,
  reconcileCallStatuses,
} from "@/lib/calls/reconcile-twilio-status";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/** A cron run is a handful of Twilio reads and finishes in a second or two, but
 *  a BACKFILL over a wide window can be hundreds of them at five in flight.
 *  pg_net gives up listening at 30 s; give the function headroom past that so a
 *  long backfill still completes instead of being cut off half-written. */
export const maxDuration = 60;

/**
 * How far back a plain `{}` POST looks — the cron's window.
 *
 * Short on purpose. A row leaves the working set the moment it is reconciled,
 * so the only rows re-read every run are the genuinely-failed ones still inside
 * the window; a wide window at a 15-minute cadence would re-ask Twilio about
 * the same 47 dead calls ~96 times a day for nothing. Our row is written by
 * ElevenLabs' post-call webhook within seconds of the call ending, and Twilio's
 * call resource is final by then, so three hours gives every call twelve
 * chances to be picked up. The one-off backfill passes its own `sinceHours`.
 */
const CRON_WINDOW_HOURS = 3;

/** Clamp: 30 days is far past any window worth reconciling, and stops a typo
 *  from turning into a scan of the whole calls table. */
const MAX_SINCE_HOURS = 24 * 30;
const MAX_LIMIT = 5000;

function positiveInt(value: unknown, max: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), max);
}

/**
 * Re-label calls we recorded as `failed` from Twilio's own record of them.
 *
 * The numbers' StatusCallback points at ElevenLabs, so our own Twilio status
 * webhook never fires for an outbound call and every outcome arrives from
 * ElevenLabs, which flattens no-answer and busy into `failed`. On 2026-09-08,
 * 37 of 84 "failures" were an unanswered or engaged phone. See
 * @/lib/calls/reconcile-twilio-status for the full story, including why this
 * moves the daily cap and why it leaves the lead's retry ladder alone.
 *
 * Secret-gated EXACTLY like /api/maintenance/retention and /api/shaken/reconcile
 * — `x-dialer-secret` compared to `DIALER_TICK_SECRET`, with a signed-in
 * super-admin fallback so the backfill can be fired by hand. Either is
 * sufficient; nothing else can fire it.
 *
 * Body (all optional):
 *   { "sinceHours": 48, "limit": 500, "dryRun": true }
 * `{}` — what pg_cron sends — reconciles the last CRON_WINDOW_HOURS. A wider
 * `sinceHours` is the one-off backfill entry point; `dryRun` reports what it
 * WOULD change and writes nothing.
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

  // pg_cron POSTs '{}'; a hand-fired backfill POSTs options. An unparseable or
  // absent body is the cron's default, not an error.
  const body = (await request.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const sinceHours =
    positiveInt(body.sinceHours, MAX_SINCE_HOURS) ?? CRON_WINDOW_HOURS;
  const limit = positiveInt(body.limit, MAX_LIMIT) ?? DEFAULT_LIMIT;
  const dryRun = body.dryRun === true;

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
    const summary = await reconcileCallStatuses(admin, {
      sinceHours,
      limit,
      dryRun,
    });
    return NextResponse.json({ sinceHours, limit, dryRun, ...summary });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
