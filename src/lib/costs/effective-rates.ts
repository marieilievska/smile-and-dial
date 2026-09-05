import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EFFECTIVE_RATE_KEYS,
  setEffectiveRates,
  type EffectiveRateKey,
  type EffectiveRates,
} from "@/lib/costs/rates";

/**
 * Loads the provider-derived rates from `cost_rates` into lib/costs/rates so
 * every pricing helper (priceTwilioCall, priceElevenLabsCredits, …) uses what
 * the providers are actually charging instead of a constant.
 *
 * Call `primeEffectiveRates(client)` once at the top of anything that prices
 * a call (the post-call webhook, the recording webhook, the import lookup
 * ledger). It is cheap: one small read, cached in module scope for 10 minutes,
 * and it never throws — a failed read leaves the env/default fallbacks in
 * place, which is exactly what the pricing helpers do on their own.
 *
 * Storage choice, documented: a keyed table (`cost_rates`, one row per rate)
 * rather than a jsonb column on app_settings, so each rate carries its own
 * `source` and `observed_at` and the refresh can update one provider without
 * rewriting the other's row.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { at: number; rates: Partial<EffectiveRates> } | null = null;

function isRateKey(key: string): key is EffectiveRateKey {
  return (EFFECTIVE_RATE_KEYS as readonly string[]).includes(key);
}

/** Drop the module cache so the next prime re-reads the table (the refresh
 *  route calls this after writing new rates). */
export function invalidateEffectiveRatesCache(): void {
  cache = null;
}

export async function primeEffectiveRates(
  // Any client works: the table is readable by authenticated users (RLS) and
  // by the service role.
  client: Pick<SupabaseClient, "from">,
): Promise<Partial<EffectiveRates>> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    setEffectiveRates(cache.rates);
    return cache.rates;
  }
  try {
    const { data, error } = await client.from("cost_rates").select("key, rate");
    if (error) throw error;
    const rates: Partial<EffectiveRates> = {};
    for (const row of (data ?? []) as { key: string; rate: unknown }[]) {
      const n = Number(row.rate);
      if (isRateKey(row.key) && Number.isFinite(n) && n >= 0) {
        rates[row.key] = n;
      }
    }
    cache = { at: Date.now(), rates };
    setEffectiveRates(rates);
    return rates;
  } catch {
    // Keep whatever is installed (possibly nothing → env/default fallbacks).
    return cache?.rates ?? {};
  }
}
