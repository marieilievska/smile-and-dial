import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Signs the current browser out and returns to /login.
 *
 * The (app) layout sends a deactivated user here (`?reason=deactivated`): a
 * Server Component cannot clear auth cookies itself, but a route handler can.
 * For that case the sign-out is GLOBAL — every session the deactivated user
 * holds is revoked, not just this tab's — and the login page shows why. Any
 * other visit is a plain local sign-out, like the top-bar button.
 */
export async function GET(request: NextRequest) {
  const deactivated =
    request.nextUrl.searchParams.get("reason") === "deactivated";

  const supabase = await createClient();
  await supabase.auth.signOut({ scope: deactivated ? "global" : "local" });

  const url = new URL("/login", request.url);
  if (deactivated) url.searchParams.set("notice", "deactivated");
  return NextResponse.redirect(url);
}
