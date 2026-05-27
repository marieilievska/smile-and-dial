// Supabase Edge Function: the dialer tick.
//
// **Not deployed yet.** This file is checked in so the deploy path is ready
// the day we flip the dialer on (after Step 24 lands and we accept real
// Twilio + ElevenLabs costs). For now, tests and local development hit the
// equivalent Next.js route at `/api/dialer/tick` instead.
//
// When deployed:
//   supabase functions deploy dial-tick --no-verify-jwt
// Required Edge Function secrets (set with `supabase functions secrets set`):
//   APP_BASE_URL       — https://<vercel-host> (where /api/dialer/tick lives)
//   DIALER_TICK_SECRET — the same secret the route validates
//
// This function is intentionally a thin proxy so the actual tick logic
// stays in TypeScript that the rest of the Next.js codebase can share. The
// alternative — porting the logic to Deno — duplicates types and Supabase
// client wiring with nothing to gain.

// @ts-expect-error Deno runtime import; resolved at deploy time.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(async () => {
  const baseUrl = Deno.env.get("APP_BASE_URL");
  const secret = Deno.env.get("DIALER_TICK_SECRET");
  if (!baseUrl || !secret) {
    return new Response(
      JSON.stringify({
        error: "APP_BASE_URL and DIALER_TICK_SECRET must be set.",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const response = await fetch(`${baseUrl}/api/dialer/tick`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-dialer-secret": secret,
    },
  });
  const body = await response.text();
  return new Response(body, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
});
