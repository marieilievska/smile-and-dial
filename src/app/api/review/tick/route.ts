import { NextResponse, type NextRequest } from "next/server";
import { runReviewTick } from "@/lib/review/worker";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-dialer-secret");
  const expected = process.env.DIALER_TICK_SECRET ?? "";
  let authorized = Boolean(expected && secret && secret === expected);
  if (!authorized) {
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
  if (!authorized)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await runReviewTick({}));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
