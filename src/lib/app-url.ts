import "server-only";

/**
 * The app's canonical public domain. Hardcoded on purpose: Vercel's env store
 * has repeatedly failed to persist NEXT_PUBLIC_APP_URL on this project, which
 * left auth / invite / password-reset emails pointing at localhost or the old
 * throwaway *.vercel.app host. If the production domain ever moves, change this
 * one constant.
 */
const CANONICAL_URL = "https://www.smile-and-dial.com";

/**
 * Resolve the app's public base URL for building webhook / callback URLs
 * (Twilio voice + status, ElevenLabs conversation-init + server tools, auth
 * email redirects). Returned without a trailing slash, or null when nothing is
 * configured (local/test) so callers fall back to mock behaviour instead of
 * building "undefined/api/..." URLs.
 *
 * Resolution order:
 *   1. PRODUCTION (VERCEL_ENV === "production") → the canonical custom domain,
 *      ALWAYS. This is the reliable path — it never depends on an env var that
 *      may be missing/stale, so invite + reset links and webhooks always point
 *      at the real site.
 *   2. NEXT_PUBLIC_APP_URL — explicit override for local tunnels / previews.
 *   3. VERCEL_PROJECT_PRODUCTION_URL — Vercel's per-deploy URL (preview builds).
 */
export function appBaseUrl(): string | null {
  if (process.env.VERCEL_ENV === "production") return CANONICAL_URL;

  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim().replace(
    /\/+$/,
    "",
  );
  if (vercel) return `https://${vercel}`;

  return null;
}
