import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** Admin-only: resolve a call's recording to a playable URL and redirect.
 *  Used as the `<audio src>` in the Reporting Voice of Customer tab. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  const { callId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin")
    return new NextResponse("Forbidden", { status: 403 });

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
