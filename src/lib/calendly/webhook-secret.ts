import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/**
 * Resolve the Calendly webhook-subscription signing key.
 *
 * Same pattern as getToolWebhookSecret(): the env var wins when set, with the
 * `app_settings.calendly_webhook_signing_key` column (row id=1) as fallback,
 * because this project's Vercel env store has dropped values before. Returns
 * "" when neither is configured — the route then accepts unsigned deliveries
 * (nothing is subscribed yet, so nothing breaks before the key exists).
 */
export async function getCalendlyWebhookSigningKey(): Promise<string> {
  const env = process.env.CALENDLY_WEBHOOK_SIGNING_KEY?.trim();
  if (env) return env;
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    if (!url || !key) return "";
    const supabase = createClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await supabase
      .from("app_settings")
      .select("calendly_webhook_signing_key")
      .eq("id", 1)
      .maybeSingle();
    return data?.calendly_webhook_signing_key?.trim() || "";
  } catch {
    return "";
  }
}
