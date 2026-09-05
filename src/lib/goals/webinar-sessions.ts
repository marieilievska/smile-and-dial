/** The weekday 2 PM Eastern webinar schedule, as plain data.
 *
 *  Pure and free of `server-only` so it unit-tests directly — the ET offset
 *  math is exactly the kind of thing that silently breaks across a DST
 *  boundary, so it gets tests rather than trust. */

export type SessionOption = { iso: string; label: string };

/**
 * The next `count` weekday sessions at 2 PM ET.
 *
 * The webinar runs every weekday at 2 PM Eastern, so the reschedule picker does
 * not need to ask Calendly what exists — it needs to offer the operator the
 * handful of days a person could plausibly have moved to. Calendly remains the
 * source of truth for what is actually bookable; this records what the person
 * said, it does not make a booking.
 *
 * The 2 PM instant is derived from each date rather than hardcoded to an
 * offset: ET is UTC-4 in summer and UTC-5 in winter, so a fixed 18:00Z would
 * quietly become 1 PM ET after the November changeover.
 */
export function upcomingSessions(
  count = 7,
  now: Date = new Date(),
): SessionOption[] {
  const out: SessionOption[] = [];
  const cursor = new Date(now.getTime());

  for (let guard = 0; out.length < count && guard < 30; guard++) {
    if (guard > 0) cursor.setUTCDate(cursor.getUTCDate() + 1);

    const weekday = cursor.toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    });
    if (weekday === "Sat" || weekday === "Sun") continue;

    const session = etTwoPmOn(cursor);
    if (session.getTime() <= now.getTime()) continue;

    out.push({
      iso: session.toISOString(),
      label: session.toLocaleString("en-US", {
        timeZone: "America/New_York",
        weekday: "long",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    });
  }
  return out;
}

/** The instant of 2 PM Eastern on whatever ET calendar day `d` falls on. */
export function etTwoPmOn(d: Date): Date {
  const ymd = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // Start from a guess, read back what ET hour it landed on, then correct.
  const guess = new Date(`${ymd}T18:00:00Z`);
  const etHour = Number(
    guess.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
  );
  return new Date(guess.getTime() + (14 - etHour) * 3_600_000);
}
