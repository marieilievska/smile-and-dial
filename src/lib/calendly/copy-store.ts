import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAvailableTimes } from "./api";
import { availabilityWindows, OFFER_LOOKAHEAD_DAYS } from "./booking";
import {
  AVAILABILITY_TIMEOUT_MS,
  copyAgeSeconds,
  copyFreshness,
  needsWarm,
  offerableSlots,
  parseSlotList,
} from "./copy-rules";
import type { Database, Json } from "@/lib/supabase/database.types";

/**
 * Reading and refreshing our copy of a Calendly event's open times.
 *
 * The copy lives on `calendly_event_types` (availability_slots +
 * availability_fetched_at). The dialer keeps it warm while it is placing calls,
 * so `get_available_times` normally answers from a copy under a minute old
 * instead of waiting 1.0-1.4 s for Calendly with the caller listening.
 *
 * Everything here is best-effort: a failed read or write leaves the previous
 * copy in place and the tool falls through to the live fetch it did before.
 */

type Admin = SupabaseClient<Database>;

/** Which event to read, and with whose token. */
export type CopyTarget = {
  eventTypeId: string;
  eventTypeUri: string;
  token: string;
};

/** A target plus the copy we already hold for it. */
export type AvailabilityCopy = CopyTarget & {
  slots: unknown;
  fetchedAt: string | null;
};

export type SlotSource = "copy" | "live" | "stale_fallback" | "none";

export type OfferableSlots = {
  /** Slot start times, soonest first, already filtered to what can be offered. */
  slots: string[];
  source: SlotSource;
  /** How old the copy was, when one was used. */
  copyAgeS: number | null;
};

/**
 * Read Calendly and store the result. Returns what Calendly said so a caller
 * can use it immediately.
 *
 * A failed read leaves the stored copy untouched on purpose: "Calendly didn't
 * answer" must not be recorded as "nothing is open", or the next caller is told
 * there are no sessions.
 */
export async function refreshAvailabilityCopy(
  supabase: Admin,
  target: CopyTarget,
  nowMs: number = Date.now(),
): Promise<{ ok: true; slots: string[] } | { ok: false; error: string }> {
  const [window] = availabilityWindows(nowMs, {
    windows: 1,
    spanDays: OFFER_LOOKAHEAD_DAYS,
  });
  const result = await fetchAvailableTimes(
    target.eventTypeUri,
    window.startISO,
    window.endISO,
    target.token,
    AVAILABILITY_TIMEOUT_MS,
  );
  if (!result.ok) return result;

  const slots = result.slots.map((s) => s.startTime);
  try {
    const { error } = await supabase
      .from("calendly_event_types")
      .update({
        availability_slots: slots as unknown as Json,
        // The time of the READ, so freshness never counts the write.
        availability_fetched_at: new Date(nowMs).toISOString(),
      })
      .eq("id", target.eventTypeId);
    if (error) {
      console.error(
        `[calendly-copy] could not store availability for event ${target.eventTypeId}: ${error.message}`,
      );
    }
  } catch {
    // The copy is an optimisation; never fail a caller over storing it.
  }
  return { ok: true, slots };
}

/**
 * The times to offer this caller, and where they came from.
 *
 *  - fresh copy        → answer from it, touch nothing.
 *  - usable copy       → answer from it, then refresh for the next caller.
 *  - older or missing  → read Calendly now (bounded), store it, answer.
 *  - Calendly silent   → an up-to-an-hour-old copy beats "nothing is open".
 *
 * `refreshAfter` lets a route hand in Next's `after()` so the background
 * refresh runs once the caller already has their answer; by default it runs
 * inline (scripts, tests).
 */
export async function resolveOfferableSlots(
  supabase: Admin,
  copy: AvailabilityCopy,
  nowMs: number = Date.now(),
  refreshAfter: (task: () => Promise<unknown>) => Promise<void> = async (
    task,
  ) => {
    await task();
  },
): Promise<OfferableSlots> {
  const freshness = copyFreshness(copy.fetchedAt, nowMs);
  const stored = offerableSlots(parseSlotList(copy.slots), nowMs);
  const age = copyAgeSeconds(copy.fetchedAt, nowMs);

  if (freshness === "fresh") {
    return { slots: stored, source: "copy", copyAgeS: age };
  }
  if (freshness === "usable") {
    await refreshAfter(async () => {
      await refreshAvailabilityCopy(supabase, copy, nowMs);
    });
    return { slots: stored, source: "copy", copyAgeS: age };
  }

  const live = await refreshAvailabilityCopy(supabase, copy, nowMs);
  if (live.ok) {
    return {
      slots: offerableSlots(live.slots, nowMs),
      source: "live",
      copyAgeS: null,
    };
  }
  if (freshness === "fallback_only" && stored.length > 0) {
    return { slots: stored, source: "stale_fallback", copyAgeS: age };
  }
  return { slots: [], source: "none", copyAgeS: age };
}

/**
 * Top up the copy for every campaign that placed a call on this dialer tick,
 * so the copy a live call reads is under a minute old. At most one Calendly
 * read per event per tick, and none at all when nothing is dialling.
 *
 * Best-effort and never throws: the dialer must not be affected by Calendly.
 */
export async function warmBookingCopies(
  supabase: Admin,
  campaignIds: readonly string[],
  nowMs: number = Date.now(),
): Promise<{ refreshed: number; checked: number }> {
  const out = { refreshed: 0, checked: 0 };
  if (campaignIds.length === 0) return out;
  try {
    const { data: campaigns } = await supabase
      .from("campaigns")
      .select("owner_id, calendly_event_id")
      .in("id", [...campaignIds])
      .not("calendly_event_id", "is", null);

    // One event can back several campaigns; refresh it once.
    const ownerByEvent = new Map<string, string>();
    for (const c of campaigns ?? []) {
      if (
        c.calendly_event_id &&
        c.owner_id &&
        !ownerByEvent.has(c.calendly_event_id)
      ) {
        ownerByEvent.set(c.calendly_event_id, c.owner_id);
      }
    }
    if (ownerByEvent.size === 0) return out;

    const [{ data: events }, { data: integrations }] = await Promise.all([
      supabase
        .from("calendly_event_types")
        .select("id, event_uri, availability_fetched_at")
        .in("id", [...ownerByEvent.keys()]),
      supabase
        .from("user_integrations")
        .select("user_id, calendly_api_key")
        .in("user_id", [...new Set(ownerByEvent.values())]),
    ]);

    const tokenByUser = new Map(
      (integrations ?? []).map((i) => [
        i.user_id,
        i.calendly_api_key?.trim() ?? "",
      ]),
    );

    await Promise.all(
      (events ?? []).map(async (event) => {
        const token = tokenByUser.get(ownerByEvent.get(event.id) ?? "") ?? "";
        if (!token || !event.event_uri) return;
        out.checked++;
        if (!needsWarm(event.availability_fetched_at, nowMs)) return;
        const result = await refreshAvailabilityCopy(
          supabase,
          { eventTypeId: event.id, eventTypeUri: event.event_uri, token },
          nowMs,
        );
        if (result.ok) out.refreshed++;
      }),
    );
  } catch {
    // Warming is an optimisation; a failure just means the next caller waits.
  }
  return out;
}
