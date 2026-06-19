import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "./database.types";

/**
 * Refreshes the Supabase session on every request and enforces route
 * protection: unauthenticated users may only reach /login.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and getUser(): it keeps the
  // session token fresh and avoids hard-to-debug random logouts.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isLoginRoute = pathname === "/login";
  // /auth/* covers the invite / password-reset confirm + set-password flow.
  const isAuthFlowRoute = pathname.startsWith("/auth/");
  // /api/* routes return JSON error responses on auth failure; they should
  // not be redirected to /login (which produces a 405 on POST).
  const isApiRoute = pathname.startsWith("/api/");
  // /share/* are intentionally public, read-only views (e.g. the shareable
  // Market Research dashboard) — no login required. Aggregate data only.
  const isPublicShareRoute = pathname.startsWith("/share/");

  // Unauthenticated users may only reach /login, the /auth/* flow, and the
  // public /share/* views.
  if (
    !user &&
    !isLoginRoute &&
    !isAuthFlowRoute &&
    !isApiRoute &&
    !isPublicShareRoute
  ) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Signed-in users have no reason to see the login page.
  if (user && isLoginRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/leads";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
