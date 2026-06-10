import { createClient } from "@supabase/supabase-js";

import { CONNECTED_OUTCOMES } from "@/lib/calls/outcomes";
import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

/** Fallback timezone for leads with no resolved timezone — matches the rest of
 *  the dialer (see `localHourDaysAheadIso`). */
const DEFAULT_TZ = "America/New_York";

/** PostgREST caps any single response at 1,000 rows, so we keyset-page through
 *  `calls` on `id` (the same pattern as `fetchAllMatchingLeadIds`). */
const PAGE_SIZE = 1000;

/** One bucket of the connect heatmap: how many outbound calls we DIALED in this
 *  local day-of-week × hour slot, how many were ANSWERED (a real connection),
 *  and the resulting connect `rate` (0 when nothing was dialed). */
export type ConnectBucket = {
  dialed: number;
  answered: number;
  rate: number;
};

/** A 7×24 grid of connect buckets, indexed `[dayOfWeek][hour]` where
 *  dayOfWeek 0 = Sunday … 6 = Saturday and hour 0–23 is the LOCAL wall-clock
 *  hour in the lead's own timezone. */
export type ConnectHeatmap = ConnectBucket[][];

/** A weekday answer-likelihood prior (length 24, indexed by hour 0–23), used as
 *  a COLD-START score when a real bucket hasn't seen enough samples yet. The
 *  curve peaks mid-morning (~10–11) and mid-afternoon (~14–16), is low in the
 *  early morning / evening, and is ~0 outside an 8am–6pm calling window. Values
 *  are already normalized to 0..1 so they can be compared directly against an
 *  empirical connect rate. */
export const DEFAULT_HOUR_SCORES: number[] = [
  0.0, // 0
  0.0, // 1
  0.0, // 2
  0.0, // 3
  0.0, // 4
  0.0, // 5
  0.0, // 6
  0.0, // 7
  0.25, // 8
  0.45, // 9
  0.7, // 10
  0.75, // 11  morning peak
  0.55, // 12  lunch dip
  0.5, // 13
  0.7, // 14
  0.75, // 15  afternoon peak
  0.65, // 16
  0.4, // 17
  0.2, // 18
  0.0, // 19
  0.0, // 20
  0.0, // 21
  0.0, // 22
  0.0, // 23
];

/** Build an empty 7×24 heatmap with every bucket zeroed. */
function emptyHeatmap(): ConnectHeatmap {
  const grid: ConnectHeatmap = [];
  for (let day = 0; day < 7; day++) {
    const row: ConnectBucket[] = [];
    for (let hour = 0; hour < 24; hour++) {
      row.push({ dialed: 0, answered: 0, rate: 0 });
    }
    grid.push(row);
  }
  return grid;
}

/** Map JS weekday names (as produced by Intl `weekday: "short"`) to the 0=Sunday
 *  index this heatmap uses. */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * The local day-of-week (0=Sun) and hour (0–23) of an instant, read in a
 * specific IANA timezone via `Intl.DateTimeFormat` — NOT the server's zone. A
 * call dialed at 2pm Pacific must land in the 14:00 Pacific bucket regardless
 * of where this code runs. DST is handled for us by the formatter.
 */
export function localDowHour(
  instant: Date,
  timeZone: string,
): { dayOfWeek: number; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
  }).formatToParts(instant);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hourRaw = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return {
    dayOfWeek: WEEKDAY_INDEX[weekday] ?? 0,
    // Intl can emit "24" for midnight under hour12:false; fold it back to 0.
    hour: hourRaw % 24,
  };
}

/** Shape of a single joined call row we page through. PostgREST returns the
 *  embedded `lead` relation as an object for a many-to-one FK, but tolerate an
 *  array too. */
type CallRow = {
  id: string;
  started_at: string | null;
  outcome: string | null;
  lead: { timezone: string | null } | { timezone: string | null }[] | null;
};

/** Pull the lead timezone out of the embedded relation regardless of whether
 *  PostgREST handed back an object or a single-element array. */
function leadTimezone(lead: CallRow["lead"]): string | null {
  if (!lead) return null;
  if (Array.isArray(lead)) return lead[0]?.timezone ?? null;
  return lead.timezone ?? null;
}

/**
 * Compute a connect-rate heatmap (local day-of-week × hour) from historical
 * outbound calls. For each call we bucket it by the day/hour in the LEAD's own
 * timezone (falling back to America/New_York), count it as `dialed`, and count
 * it as `answered` when its outcome is in CONNECTED_OUTCOMES (the app-wide
 * "reached a human" definition).
 *
 * Reads `calls` keyset-paged on `id` to page past PostgREST's 1,000-row cap,
 * joined to the lead's timezone, restricted to outbound calls with a non-null
 * `started_at` within the last `sinceDays` (default 90).
 *
 * This is the model behind "best time to call": the returned grid is the raw
 * signal that `scoreForSlot` / `pickNextBestWindow` consume.
 */
export async function computeConnectHeatmap(
  supabase: SupabaseAdmin,
  opts?: { sinceDays?: number },
): Promise<ConnectHeatmap> {
  const sinceDays = opts?.sinceDays ?? 90;
  const sinceIso = new Date(
    Date.now() - sinceDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const heatmap = emptyHeatmap();
  let lastId: string | null = null;

  for (;;) {
    let query = supabase
      .from("calls")
      .select("id, started_at, outcome, lead:leads(timezone)")
      .eq("direction", "outbound")
      .not("started_at", "is", null)
      .gte("started_at", sinceIso)
      .order("id", { ascending: true })
      .limit(PAGE_SIZE);
    if (lastId !== null) query = query.gt("id", lastId);

    const { data, error } = await query;
    if (error) throw new Error(`computeConnectHeatmap: ${error.message}`);

    const page = (data ?? []) as unknown as CallRow[];
    for (const call of page) {
      if (!call.started_at) continue;
      const tz = leadTimezone(call.lead) || DEFAULT_TZ;
      const { dayOfWeek, hour } = localDowHour(new Date(call.started_at), tz);
      const bucket = heatmap[dayOfWeek][hour];
      bucket.dialed += 1;
      // "Answered" = a real human connection, defined the SAME way as the
      // app-wide connect-rate metric (CONNECTED_OUTCOMES) rather than
      // answered_at — ElevenLabs-native AI calls bypass the Twilio status
      // webhook that stamps answered_at, so the outcome is the reliable signal.
      if (call.outcome && CONNECTED_OUTCOMES.has(call.outcome)) {
        bucket.answered += 1;
      }
    }

    if (page.length < PAGE_SIZE) break;
    lastId = page[page.length - 1].id;
  }

  // Finalize the rates now that every bucket is fully counted.
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const b = heatmap[day][hour];
      b.rate = b.dialed > 0 ? b.answered / b.dialed : 0;
    }
  }

  return heatmap;
}

/**
 * Score a single (dayOfWeek, hour) slot in 0..1. When the slot has enough real
 * history (`dialed >= minSamples`) we trust the empirical connect rate; below
 * that threshold the sample is too noisy, so we fall back to the cold-start
 * weekday prior `DEFAULT_HOUR_SCORES[hour]` instead.
 */
export function scoreForSlot(
  heatmap: ConnectHeatmap,
  dayOfWeek: number,
  hour: number,
  minSamples = 8,
): number {
  const bucket = heatmap[dayOfWeek]?.[hour];
  if (bucket && bucket.dialed >= minSamples) {
    return bucket.rate;
  }
  return DEFAULT_HOUR_SCORES[hour] ?? 0;
}

/**
 * The single best integer hour to call on a given local day-of-week, restricted
 * to the campaign's calling window. Among the whole hours in
 * `[startHour, endHour)` we return the one with the highest
 * `scoreForSlot(heatmap, dayOfWeek, hour, minSamples)`, breaking ties toward the
 * EARLIEST hour. Returns `null` when the range is empty (start >= end) so callers
 * can fall back to their default hour.
 *
 * This is the read-side counterpart to `pickNextBestWindow`: the retry engine
 * keeps its own backoff cadence (which DAY) and only asks this for the best HOUR
 * on that day.
 */
export function bestHourForDay(
  heatmap: ConnectHeatmap,
  dayOfWeek: number,
  startHour: number,
  endHour: number,
  minSamples = 8,
): number | null {
  let best: { hour: number; score: number } | null = null;
  for (let hour = startHour; hour < endHour; hour++) {
    const score = scoreForSlot(heatmap, dayOfWeek, hour, minSamples);
    // Strict `>` keeps the EARLIEST hour on ties (we iterate ascending).
    if (best === null || score > best.score) {
      best = { hour, score };
    }
  }
  return best ? best.hour : null;
}

/** Parse an 'HH:MM:SS' (or 'HH:MM') calling-hours string to an integer hour. */
function parseHour(hhmmss: string): number {
  const h = Number(hhmmss.split(":")[0]);
  return Number.isFinite(h) ? h : 0;
}

/**
 * Convert a wall-clock instant (a given year/month/day/hour in `timeZone`) to a
 * real UTC epoch-ms, DST-correct. This is the same Intl offset-correction trick
 * as `localHourDaysAheadIso`: interpret the desired wall clock as if it were
 * UTC, read it back in the target zone to discover that zone's offset there,
 * then subtract the offset.
 */
function localWallToUtcMs(
  timeZone: string,
  year: number,
  month: number, // 1-based
  day: number,
  hour: number,
): number {
  const wallGuess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const rbParts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(wallGuess));
  const rb = (t: string) => Number(rbParts.find((x) => x.type === t)?.value);
  const readMs = Date.UTC(
    rb("year"),
    rb("month") - 1,
    rb("day"),
    rb("hour") % 24,
    rb("minute"),
    0,
  );
  const offset = readMs - wallGuess;
  return wallGuess - offset;
}

/** The local calendar date (Y/M/D) of an instant in a given timezone. */
function localYmd(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const num = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return { year: num("year"), month: num("month"), day: num("day") };
}

/**
 * Pick the next best in-hours call window for a lead and return it as a UTC ISO
 * timestamp.
 *
 * Candidate slots are each whole hour within [callingHoursStart, callingHoursEnd)
 * — both 'HH:MM:SS' campaign columns — across the next 7 local days in the
 * lead's `timeZone`. We skip any slot earlier than `nowMs + minHoursOut` (default
 * 1h), score the rest with `scoreForSlot`, and return the highest-scoring slot,
 * breaking ties toward the soonest.
 *
 * Local→UTC conversion is DST-correct (the Intl offset trick from
 * `localWallToUtcMs`), so a "10am local" slot maps to the right UTC instant even
 * across a spring-forward / fall-back boundary. `nowMs` is injected so callers
 * (and tests) stay deterministic — we never read `Date.now()` here.
 */
export function pickNextBestWindow(opts: {
  heatmap: ConnectHeatmap;
  timeZone: string | null;
  callingHoursStart: string;
  callingHoursEnd: string;
  nowMs: number;
  minHoursOut?: number;
}): string {
  const {
    heatmap,
    timeZone,
    callingHoursStart,
    callingHoursEnd,
    nowMs,
    minHoursOut,
  } = opts;
  const tz = timeZone || DEFAULT_TZ;
  const startHour = parseHour(callingHoursStart);
  const endHour = parseHour(callingHoursEnd);
  const earliestMs = nowMs + (minHoursOut ?? 1) * 60 * 60 * 1000;

  // Anchor on the lead's local calendar date "now" so day rollovers respect the
  // lead's zone, not the server's.
  const base = localYmd(new Date(nowMs), tz);

  let best: { utcMs: number; score: number } | null = null;

  for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
    for (let hour = startHour; hour < endHour; hour++) {
      const utcMs = localWallToUtcMs(
        tz,
        base.year,
        base.month,
        base.day + dayOffset,
        hour,
      );
      if (utcMs < earliestMs) continue;

      // Re-derive the slot's local day-of-week & hour from the resolved instant
      // so DST shifts and month/day rollovers are reflected accurately.
      const { dayOfWeek, hour: localHour } = localDowHour(new Date(utcMs), tz);
      const score = scoreForSlot(heatmap, dayOfWeek, localHour);

      if (
        best === null ||
        score > best.score ||
        (score === best.score && utcMs < best.utcMs)
      ) {
        best = { utcMs, score };
      }
    }
  }

  // Defensive fallback: if calling hours were degenerate (start >= end) so no
  // candidate qualified, aim at the earliest allowed instant.
  const chosenMs = best ? best.utcMs : earliestMs;
  return new Date(chosenMs).toISOString();
}
