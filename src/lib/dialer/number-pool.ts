// src/lib/dialer/number-pool.ts
import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

export type PoolSettings = {
  daily_cap: number;
  warmup_days: number;
  warmup_start_cap: number;
};

export const DEFAULT_POOL_SETTINGS: PoolSettings = {
  daily_cap: 100,
  warmup_days: 14,
  warmup_start_cap: 20,
};

/** US (NANP) area code from an E.164 number (+1XXXXXXXXXX), or null. */
export function areaCodeOf(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(e164.trim());
  return m ? m[1] : null;
}

/** A number's daily cap today: the mature cap, ramped up over the warm-up window
 *  so a fresh number doesn't blast high volume. Pure. */
export function effectiveDailyCap(input: {
  matureCap: number;
  warmupStartCap: number;
  warmupDays: number;
  warmupStartedAt: string | null;
  now: number;
}): number {
  const { matureCap, warmupStartCap, warmupDays, warmupStartedAt, now } = input;
  if (!warmupStartedAt || warmupDays <= 0) return matureCap;
  const ageDays = (now - new Date(warmupStartedAt).getTime()) / 86_400_000;
  if (ageDays >= warmupDays) return matureCap;
  const ramped =
    warmupStartCap + (matureCap - warmupStartCap) * (ageDays / warmupDays);
  return Math.max(warmupStartCap, Math.round(ramped));
}

export type PoolCandidate = {
  id: string;
  elevenlabsPhoneNumberId: string;
  areaCode: string | null;
  calls24h: number;
  effectiveCap: number;
  connectRate: number | null;
};

/** Choose the best number to dial from. Exact-area-code matches win; within the
 *  chosen tier, least-used-today, tie-broken by higher connect rate then a stable
 *  spread key (so equal numbers share load evenly). Returns null when every
 *  candidate is at/over its cap (pool exhausted). Pure. */
export function pickPoolNumber(
  candidates: PoolCandidate[],
  leadAreaCode: string | null,
  spreadKey: string,
): PoolCandidate | null {
  const underCap = candidates.filter((c) => c.calls24h < c.effectiveCap);
  if (underCap.length === 0) return null;
  const local = leadAreaCode
    ? underCap.filter((c) => c.areaCode === leadAreaCode)
    : [];
  const tier = local.length > 0 ? local : underCap;
  const hash = (s: string): number =>
    s.split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return [...tier].sort(
    (a, b) =>
      a.calls24h - b.calls24h ||
      (b.connectRate ?? -1) - (a.connectRate ?? -1) ||
      hash(spreadKey + a.id) - hash(spreadKey + b.id),
  )[0];
}

/** Read the pool tunables from app_settings, falling back to defaults. */
export async function loadPoolSettings(db: Admin): Promise<PoolSettings> {
  const { data } = await db
    .from("app_settings")
    .select("number_pool_settings")
    .limit(1)
    .maybeSingle();
  const raw = (data as { number_pool_settings?: Partial<PoolSettings> } | null)
    ?.number_pool_settings;
  return { ...DEFAULT_POOL_SETTINGS, ...(raw ?? {}) };
}

/** Pick a live pool number for a campaign + lead. Loads the campaign's active,
 *  non-rested, imported numbers, their live 24h usage (via the grouped RPC), and
 *  ranks them with pickPoolNumber. Returns null when the pool is empty or fully
 *  capped (caller should defer the lead). */
export async function selectPoolNumber(
  db: Admin,
  campaignId: string,
  leadPhone: string | null,
  spreadKey: string,
): Promise<{ numberId: string; elevenlabsPhoneNumberId: string } | null> {
  const nowIso = new Date().toISOString();
  const [{ data: nums }, settings] = await Promise.all([
    db
      .from("twilio_numbers")
      .select(
        "id, elevenlabs_phone_number_id, area_code, warmup_started_at, daily_cap_override, last_connect_rate_24h",
      )
      .eq("attached_campaign_id", campaignId)
      .is("released_at", null)
      .eq("pool_status", "active")
      .eq("flagged_for_rotation", false)
      .not("elevenlabs_phone_number_id", "is", null)
      .or(`rested_until.is.null,rested_until.lte.${nowIso}`),
    loadPoolSettings(db),
  ]);
  const pool = (nums ?? []) as {
    id: string;
    elevenlabs_phone_number_id: string;
    area_code: string | null;
    warmup_started_at: string | null;
    daily_cap_override: number | null;
    last_connect_rate_24h: number | null;
  }[];
  if (pool.length === 0) return null;

  const { data: usage } = await db.rpc("pool_number_usage_24h", {
    in_campaign_id: campaignId,
  });
  const counts = new Map<string, number>();
  for (const u of (usage ?? []) as {
    twilio_number_id: string;
    calls_24h: number;
  }[]) {
    counts.set(u.twilio_number_id, Number(u.calls_24h));
  }

  const now = Date.now();
  const candidates: PoolCandidate[] = pool.map((n) => ({
    id: n.id,
    elevenlabsPhoneNumberId: n.elevenlabs_phone_number_id,
    areaCode: n.area_code,
    calls24h: counts.get(n.id) ?? 0,
    effectiveCap: effectiveDailyCap({
      matureCap: n.daily_cap_override ?? settings.daily_cap,
      warmupStartCap: settings.warmup_start_cap,
      warmupDays: settings.warmup_days,
      warmupStartedAt: n.warmup_started_at,
      now,
    }),
    connectRate: n.last_connect_rate_24h,
  }));

  const chosen = pickPoolNumber(candidates, areaCodeOf(leadPhone), spreadKey);
  return chosen
    ? {
        numberId: chosen.id,
        elevenlabsPhoneNumberId: chosen.elevenlabsPhoneNumberId,
      }
    : null;
}
