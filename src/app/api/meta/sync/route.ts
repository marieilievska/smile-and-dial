import { NextResponse, type NextRequest } from "next/server";

import { getMetaSettings } from "@/lib/meta/settings";
import { runMetaSync } from "@/lib/meta/sync";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const headerSecret = request.headers.get("x-meta-sync-secret");
  const { syncSecret } = await getMetaSettings();

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
    const summary = await runMetaSync();
    return NextResponse.json(summary, { status: summary.ok ? 200 : 500 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
