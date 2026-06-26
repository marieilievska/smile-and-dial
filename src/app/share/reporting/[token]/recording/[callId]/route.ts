import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** Public, token-gated: resolve a call's recording to a playable URL and
 *  redirect. The share token is validated against app_settings (same gate as
 *  the share page). Service-role client (key stays server-side). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string; callId: string }> },
) {
  const { token, callId } = await params;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return new NextResponse("Not found", { status: 404 });
  const supabase = createServiceClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: settings } = await supabase
    .from("app_settings")
    .select("agent_analytics_share_token")
    .eq("id", 1)
    .maybeSingle();
  const expected = settings?.agent_analytics_share_token ?? "";
  if (!expected || token !== expected)
    return new NextResponse("Not found", { status: 404 });

  const { data: call } = await supabase
    .from("calls")
    .select("recording_path")
    .eq("id", callId)
    .eq("direction", "outbound")
    .maybeSingle();
  const path = call?.recording_path;
  if (!path) return new NextResponse("Not found", { status: 404 });
  if (/^https?:\/\//.test(path)) return NextResponse.redirect(path);
  const { data: signed } = await supabase.storage
    .from("call-recordings")
    .createSignedUrl(path, 3600);
  if (!signed?.signedUrl) return new NextResponse("Not found", { status: 404 });
  return NextResponse.redirect(signed.signedUrl);
}
