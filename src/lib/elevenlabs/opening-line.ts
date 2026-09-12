/**
 * How a call opens — pure: no database, no network, and no "server-only",
 * because the campaign Test Call tab renders it in the browser too.
 * Design: 2026-09-12 callback-openers spec.
 *
 * The agent no longer picks its own opener. ElevenLabs substitutes every
 * {{variable}} BEFORE the model reads the prompt, so a rule like
 * `(when {{call_type}} is "cold")` reached it as `(when callback is "cold")`,
 * and on 2026-09-12 51% of scheduled callbacks opened with the cold pitch.
 * Code decides the situation and hands the agent one plain instruction,
 * {{opening_instruction}}.
 *
 * Every line here is the agent's first REPLY, after the business answers.
 * Nothing in this module is ever an ElevenLabs first_message.
 */

const FALLBACK_TIME_ZONE = "America/New_York";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The lead's IANA zone, or Eastern when it's missing or not a real zone. */
function usableTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions();
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

/** Midnight UTC of the calendar date `date` falls on in `timeZone`. Two of
 *  these subtract to a whole number of days, even across a DST change. */
function localDayMs(date: Date, timeZone: string): number {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Plain-English "when" for a past conversation, in calendar days on the lead's
 * clock: earlier today · yesterday · on {Weekday} · last week · a few weeks
 * ago · about a month ago · a couple of months ago. "recently" when there's no
 * usable timestamp.
 */
export function whenPhrase(
  fromIso: string | null | undefined,
  now: Date,
  timeZone: string | null | undefined,
): string {
  if (!fromIso) return "recently";
  const then = new Date(fromIso);
  if (Number.isNaN(then.getTime())) return "recently";
  const tz = usableTimeZone(timeZone);
  const days = Math.round(
    (localDayMs(now, tz) - localDayMs(then, tz)) / DAY_MS,
  );
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days <= 6) {
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).format(then);
    return `on ${weekday}`;
  }
  if (days <= 13) return "last week";
  if (days <= 29) return "a few weeks ago";
  if (days <= 59) return "about a month ago";
  return "a couple of months ago";
}
