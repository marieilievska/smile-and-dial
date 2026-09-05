import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { invalidateEffectiveRatesCache } from "@/lib/costs/effective-rates";
import type { EffectiveRateKey } from "@/lib/costs/rates";
import {
  fetchElevenLabsSubscription,
  type ElevenLabsSubscription,
} from "@/lib/elevenlabs/subscription";
import type { Database, Json } from "@/lib/supabase/database.types";
import {
  fetchTwilioUsage,
  type TwilioUsageCategory,
  type TwilioUsagePeriod,
  type TwilioUsageRecord,
} from "@/lib/twilio/usage";

/**
 * Daily cost-rate refresh: derive what the providers are ACTUALLY charging
 * from their own billing data and store it in `cost_rates`, so per-call
 * pricing tracks reality instead of a constant that drifts every time a plan
 * or a Twilio price changes.
 *
 *   ElevenLabs  $/credit  = next_invoice.amount_due_cents / 100 / character_limit
 *   Twilio      $/minute  = usage record price / usage   (per category)
 *   Twilio      $/lookup  = same, category `lookups`
 *
 * Twilio: read ThisMonth; when the month has fewer than MIN_USAGE_UNITS of a
 * category (early in the month, or a quiet category) fall back to LastMonth;
 * when neither has enough, leave that rate untouched — a rate derived from a
 * handful of minutes would be noise.
 *
 * The pure `derive*` functions are exported for the unit tests.
 */

type Admin = SupabaseClient<Database>;

/** Below this many units a period is too thin to derive a rate from. */
export const MIN_USAGE_UNITS = 100;

export type DerivedRate = {
  key: EffectiveRateKey;
  rate: number;
  source: string;
  detail: Record<string, Json | undefined>;
};

/** $/credit from the subscription, or null when either input is missing. */
export function deriveElevenLabsRate(
  sub: ElevenLabsSubscription | null,
): DerivedRate | null {
  if (!sub) return null;
  const cents = sub.nextInvoiceAmountDueCents;
  const credits = sub.characterLimit;
  if (
    cents === null ||
    !Number.isFinite(cents) ||
    cents <= 0 ||
    !Number.isFinite(credits) ||
    credits <= 0
  ) {
    return null;
  }
  const rate = cents / 100 / credits;
  return {
    key: "elevenlabs_usd_per_credit",
    rate: Number(rate.toFixed(10)),
    source: "elevenlabs:subscription",
    detail: {
      tier: sub.tier,
      amount_due_cents: cents,
      character_limit: credits,
      billing_period: sub.billingPeriod,
    },
  };
}

const TWILIO_CATEGORY_KEY: Record<TwilioUsageCategory, EffectiveRateKey> = {
  "calls-outbound": "twilio_outbound_usd_per_min",
  "calls-inbound": "twilio_inbound_usd_per_min",
  "calls-media-stream-minutes": "twilio_media_stream_usd_per_min",
  lookups: "twilio_lookup_usd",
};

export const TWILIO_USAGE_CATEGORIES = Object.keys(
  TWILIO_CATEGORY_KEY,
) as TwilioUsageCategory[];

/** price ÷ usage for one Twilio usage record, or null when the period is too
 *  thin (< MIN_USAGE_UNITS) or the record is unusable. */
export function deriveTwilioRate(
  category: TwilioUsageCategory,
  period: TwilioUsagePeriod,
  record: TwilioUsageRecord | null,
): DerivedRate | null {
  if (!record) return null;
  if (!Number.isFinite(record.usage) || record.usage < MIN_USAGE_UNITS) {
    return null;
  }
  if (!Number.isFinite(record.price) || record.price < 0) return null;
  const rate = record.price / record.usage;
  return {
    key: TWILIO_CATEGORY_KEY[category],
    rate: Number(rate.toFixed(8)),
    source: `twilio:usage:${period}`,
    detail: {
      category,
      period,
      usage: record.usage,
      usage_unit: record.usageUnit,
      price: record.price,
      count: record.count,
      start_date: record.startDate,
      end_date: record.endDate,
    },
  };
}

/** Pick the rate for a category: ThisMonth when it has enough usage, else
 *  LastMonth, else null. `fetchRecord` is injected so the tests can drive it. */
export async function deriveTwilioRateWithFallback(
  category: TwilioUsageCategory,
  fetchRecord: (
    category: TwilioUsageCategory,
    period: TwilioUsagePeriod,
  ) => Promise<TwilioUsageRecord | null>,
): Promise<{ derived: DerivedRate | null; tried: TwilioUsagePeriod[] }> {
  const tried: TwilioUsagePeriod[] = [];
  for (const period of ["ThisMonth", "LastMonth"] as const) {
    tried.push(period);
    const derived = deriveTwilioRate(
      category,
      period,
      await fetchRecord(category, period),
    );
    if (derived) return { derived, tried };
  }
  return { derived: null, tried };
}

export type CostRatesRefreshSummary = {
  updated: { key: EffectiveRateKey; rate: number; source: string }[];
  skipped: { key: EffectiveRateKey; reason: string }[];
  observedAt: string;
};

/** Run the refresh: read both providers, upsert every derivable rate, and
 *  report what changed. Rates that could not be derived are left as they were. */
export async function runCostRatesRefresh(
  admin: Admin,
  deps: {
    fetchSubscription?: () => Promise<ElevenLabsSubscription | null>;
    fetchUsage?: (
      category: TwilioUsageCategory,
      period: TwilioUsagePeriod,
    ) => Promise<TwilioUsageRecord | null>;
    now?: Date;
  } = {},
): Promise<CostRatesRefreshSummary> {
  const fetchSubscription =
    deps.fetchSubscription ?? fetchElevenLabsSubscription;
  const fetchUsage = deps.fetchUsage ?? fetchTwilioUsage;
  const observedAt = (deps.now ?? new Date()).toISOString();

  const derived: DerivedRate[] = [];
  const skipped: CostRatesRefreshSummary["skipped"] = [];

  const el = deriveElevenLabsRate(await fetchSubscription());
  if (el) derived.push(el);
  else {
    skipped.push({
      key: "elevenlabs_usd_per_credit",
      reason:
        "subscription unavailable or missing next_invoice/character_limit",
    });
  }

  for (const category of TWILIO_USAGE_CATEGORIES) {
    const { derived: d, tried } = await deriveTwilioRateWithFallback(
      category,
      fetchUsage,
    );
    if (d) derived.push(d);
    else {
      skipped.push({
        key: TWILIO_CATEGORY_KEY[category],
        reason: `fewer than ${MIN_USAGE_UNITS} units in ${tried.join("/")} (or usage unavailable)`,
      });
    }
  }

  const updated: CostRatesRefreshSummary["updated"] = [];
  if (derived.length > 0) {
    const { error } = await admin.from("cost_rates").upsert(
      derived.map((d) => ({
        key: d.key,
        rate: d.rate,
        source: d.source,
        observed_at: observedAt,
        detail: d.detail as Json,
        updated_at: observedAt,
      })),
      { onConflict: "key" },
    );
    if (error) throw new Error(`cost_rates upsert failed: ${error.message}`);
    for (const d of derived) {
      updated.push({ key: d.key, rate: d.rate, source: d.source });
    }
    invalidateEffectiveRatesCache();
  }

  return { updated, skipped, observedAt };
}
