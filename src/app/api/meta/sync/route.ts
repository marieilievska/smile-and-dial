import { NextResponse, type NextRequest } from "next/server";

import {
  getMetaSyncSecret,
  listMetaConnectedUserIds,
} from "@/lib/meta/settings";
import { runMetaSync } from "@/lib/meta/sync";
import { createClient } from "@/lib/supabase/server";

/**
 * Nightly Meta sync endpoint. Meta is per-user, so one run iterates EVERY user
 * who has connected Meta and syncs each into their own Custom Audience.
 *
 * Auth: the workspace sync secret (used by the pg_cron job) OR an admin session
 * (for a manual "run the whole workspace" trigger). The per-user "Sync now"
 * button does NOT come through here — it calls the syncMetaNow server action,
 * which syncs just that user.
 */
export async function POST(request: NextRequest) {
  const headerSecret = request.headers.get("x-meta-sync-secret");
  const syncSecret = await getMetaSyncSecret();

  let authorized = false;
  if (syncSecret && headerSecret && headerSecret === syncSecret) {
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

  try {
    const userIds = await listMetaConnectedUserIds();
    let added = 0;
    let removed = 0;
    let failures = 0;
    const errors: string[] = [];
    for (const userId of userIds) {
      const r = await runMetaSync(userId);
      added += r.added;
      removed += r.removed;
      if (!r.ok) {
        failures += 1;
        if (r.error) errors.push(`${userId}: ${r.error}`);
      }
    }
    const ok = failures === 0;
    return NextResponse.json(
      { ok, users: userIds.length, added, removed, failures, errors },
      { status: ok ? 200 : 500 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
