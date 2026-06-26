import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type DB = SupabaseClient<Database>;

/** Standard data-collection fields every agent emits — excluded from per-campaign
 *  sentiment/notes detection (we want the agent's CUSTOM fields). Mirrors the
 *  DATA_COLLECTION_FIELDS ids in src/lib/elevenlabs/agents.ts. */
const STANDARD_KEYS = new Set([
  "disposition",
  "decision_maker_reached",
  "business_email",
  "owner_name",
  "manager_name",
  "employee_name",
  "callback_datetime",
]);

const POSITIVE = new Set([
  "yes",
  "happy",
  "good",
  "great",
  "interested",
  "satisfied",
  "positive",
]);
const NEUTRAL = new Set(["maybe", "mixed", "neutral", "unsure", "somewhat"]);
const NEGATIVE = new Set([
  "no",
  "unhappy",
  "bad",
  "not_interested",
  "dissatisfied",
  "negative",
]);

/** Lexicon rank: positive(0) < neutral(1) < negative(2) < unrecognized(3). */
export function sentimentRank(v: string): number {
  const s = v.trim().toLowerCase();
  if (POSITIVE.has(s)) return 0;
  if (NEUTRAL.has(s)) return 1;
  if (NEGATIVE.has(s)) return 2;
  return 3;
}

/** Warm = positive or neutral. */
export function isWarm(v: string): boolean {
  return sentimentRank(v) <= 1;
}

/** Tailwind classes for a sentiment pill, by lexicon (neutral gray fallback). */
export function sentimentTone(v: string): string {
  switch (sentimentRank(v)) {
    case 0:
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400";
    case 1:
      return "bg-amber-500/15 text-amber-700 dark:text-amber-400";
    case 2:
      return "bg-rose-500/15 text-rose-600 dark:text-rose-400";
    default:
      return "bg-muted text-foreground";
  }
}

export type DetectedFields = {
  sentimentKey: string | null;
  sentimentValues: string[]; // ordered by lexicon then alphabetical
  notesKey: string | null;
};

const SAMPLE_DAYS = 90;
const PAGE = 1000;

/** Inspect a campaign's recent calls and pick its sentiment field (a custom
 *  field with a small value set) and notes field (longest free text). Returns
 *  nulls when nothing qualifies. */
export async function detectCampaignFields(
  supabase: DB,
  campaignId: string,
): Promise<DetectedFields> {
  const since = new Date(Date.now() - SAMPLE_DAYS * 86_400_000).toISOString();
  const { data } = await supabase
    .from("calls")
    .select("extracted_data")
    .eq("campaign_id", campaignId)
    .eq("direction", "outbound")
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .range(0, PAGE - 1);
  const rows = (data ?? []) as { extracted_data: unknown }[];

  const distinct = new Map<string, Set<string>>(); // key -> lowercased values
  const text = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const ed =
      r.extracted_data && typeof r.extracted_data === "object"
        ? (r.extracted_data as Record<string, unknown>)
        : {};
    for (const [key, raw] of Object.entries(ed)) {
      if (STANDARD_KEYS.has(key)) continue;
      const val = String(raw ?? "").trim();
      if (!val) continue;
      if (!distinct.has(key)) distinct.set(key, new Set());
      distinct.get(key)!.add(val.toLowerCase());
      const t = text.get(key) ?? { total: 0, count: 0 };
      t.total += val.length;
      t.count++;
      text.set(key, t);
    }
  }

  // sentimentKey: 2–6 distinct values; prefer most lexicon-recognized, then
  // fewest distinct, then alphabetical key (deterministic).
  let sentimentKey: string | null = null;
  let best = { recognized: -1, size: Infinity, key: "~" };
  for (const [key, vals] of distinct) {
    const size = vals.size;
    if (size < 2 || size > 6) continue;
    const recognized = [...vals].filter((v) => sentimentRank(v) < 3).length;
    const better =
      recognized > best.recognized ||
      (recognized === best.recognized && size < best.size) ||
      (recognized === best.recognized && size === best.size && key < best.key);
    if (better) {
      best = { recognized, size, key };
      sentimentKey = key;
    }
  }
  const sentimentValues = sentimentKey
    ? [...distinct.get(sentimentKey)!].sort(
        (a, b) => sentimentRank(a) - sentimentRank(b) || a.localeCompare(b),
      )
    : [];

  // notesKey: longest average text (≥ 20 chars), excluding the sentiment key.
  let notesKey: string | null = null;
  let bestAvg = 0;
  for (const [key, t] of text) {
    if (key === sentimentKey || t.count === 0) continue;
    const avg = t.total / t.count;
    if (avg >= 20 && avg > bestAvg) {
      bestAvg = avg;
      notesKey = key;
    }
  }

  return { sentimentKey, sentimentValues, notesKey };
}
