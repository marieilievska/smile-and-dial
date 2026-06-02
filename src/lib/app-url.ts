import "server-only";

/**
 * Resolve the app's public base URL for building webhook / callback URLs
 * (Twilio voice + status, ElevenLabs conversation-init + server tools, auth
 * email redirects). Returned without a trailing slash, or null when nothing
 * is configured (local/test) so callers fall back to mock behavior instead of
 * building "undefined/api/..." URLs.
 *
 * Resolution order:
 *   1. NEXT_PUBLIC_APP_URL — explicit override (custom domain, local dev).
 *   2. VERCEL_PROJECT_PRODUCTION_URL — the stable production domain Vercel
 *      injects into EVERY deployment automatically. This is the reliable
 *      path: it needs no manual setup, so webhooks always resolve to the
 *      production app even when NEXT_PUBLIC_APP_URL was never set (Vercel's
 *      env store has repeatedly failed to persist a value for that var on
 *      this project). Vercel provides it WITHOUT a scheme, so we prepend
 *      https://.
 */
export function appBaseUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(
    /\/+$/,
    "",
  );
  if (vercel) return `https://${vercel}`;

  return null;
}
