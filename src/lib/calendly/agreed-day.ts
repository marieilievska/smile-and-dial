import { relativeDayLabel } from "./booking";

/** Does the day the lead said YES to (in their own words) name the day of the
 *  slot the agent is about to book?
 *
 *  Pure: no I/O. `nowMs` and `timeZone` decide what "today" / "tomorrow" mean
 *  on the LEAD's calendar (a Pacific lead at 10:30 PM Wednesday calls a Thursday
 *  slot "tomorrow"). Verdicts:
 *   - "match"        the agreed day is the slot's day
 *   - "mismatch"     the agreed day is a different day — refuse the booking
 *   - "unrecognized" nothing day-like in `agreedDay` (or no usable slot) —
 *                    the caller decides; the booking guard fails open.
 *  `slotDay` is the slot's day as it reads to the lead, e.g.
 *  "today (Thursday, September 3)" or "Tuesday, September 8". */
export function agreedDayMatchesSlot(
  agreedDay: string | null | undefined,
  slotISO: string,
  nowMs: number,
  timeZone: string | null | undefined,
): { verdict: "match" | "mismatch" | "unrecognized"; slotDay: string } {
  const tz = timeZone || "America/New_York";
  const slot = new Date(slotISO);
  if (Number.isNaN(slot.getTime())) {
    return { verdict: "unrecognized", slotDay: "" };
  }

  const relative = relativeDayLabel(slotISO, nowMs, tz);
  const slotWeekday = slot
    .toLocaleDateString("en-US", { weekday: "long", timeZone: tz })
    .toLowerCase();
  const slotDayOfMonth = Number(
    new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: tz }).format(
      slot,
    ),
  );
  const calendarDay = slot.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
  const slotDay =
    relative === "today" || relative === "tomorrow"
      ? `${relative} (${calendarDay})`
      : calendarDay;

  const parsed = parseAgreedDay(agreedDay);
  if (parsed.weekday) {
    return {
      verdict: parsed.weekday === slotWeekday ? "match" : "mismatch",
      slotDay,
    };
  }
  if (parsed.relative) {
    return {
      verdict: parsed.relative === relative ? "match" : "mismatch",
      slotDay,
    };
  }
  if (parsed.dayOfMonth !== null) {
    return {
      verdict: parsed.dayOfMonth === slotDayOfMonth ? "match" : "mismatch",
      slotDay,
    };
  }
  return { verdict: "unrecognized", slotDay };
}

const WEEKDAYS: Array<[name: string, pattern: RegExp]> = [
  ["monday", /\bmon(?:day)?\b/],
  ["tuesday", /\btue(?:s|sday)?\b/],
  ["wednesday", /\bwed(?:nesday)?\b/],
  ["thursday", /\bthu(?:r|rs|rsday)?\b/],
  ["friday", /\bfri(?:day)?\b/],
  ["saturday", /\bsat(?:urday)?\b/],
  ["sunday", /\bsun(?:day)?\b/],
];

const MONTH_WORD =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/;

/** Pull the day-like parts out of free text: a weekday word (abbreviations
 *  included; "next tuesday" is just tuesday), today/tomorrow, and a
 *  day-of-month number ("the 8th", "sept 8", "9/8" → 8). */
function parseAgreedDay(input: string | null | undefined): {
  weekday: string | null;
  relative: "today" | "tomorrow" | null;
  dayOfMonth: number | null;
} {
  const raw = (input ?? "").toLowerCase();
  const text = raw.replace(/[^a-z0-9/]+/g, " ").trim();
  if (!text) return { weekday: null, relative: null, dayOfMonth: null };

  const weekday = WEEKDAYS.find(([, re]) => re.test(text))?.[0] ?? null;
  const relative = /\btoday\b/.test(text)
    ? "today"
    : /\btomorrow\b/.test(text)
      ? "tomorrow"
      : null;

  return { weekday, relative, dayOfMonth: parseDayOfMonth(text) };
}

function parseDayOfMonth(text: string): number | null {
  const inRange = (n: number) => (n >= 1 && n <= 31 ? n : null);
  // "9/8" → US month/day → 8.
  const slash = /\b\d{1,2}\/(\d{1,2})\b/.exec(text);
  if (slash) return inRange(Number(slash[1]));
  // "the 8th" — an ordinal is unambiguous.
  const ordinal = /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(text);
  if (ordinal) return inRange(Number(ordinal[1]));
  // "sept 8" / "september 8".
  const month = MONTH_WORD.exec(text);
  if (month) {
    const after = /^\s*(\d{1,2})\b/.exec(
      text.slice(month.index + month[0].length),
    );
    if (after) return inRange(Number(after[1]));
  }
  // A bare number that isn't a clock time ("at 2", "2 pm", "2:30").
  const bare = /\b(\d{1,2})\b(?!\s*(?:am|pm|a m|p m|o clock|:\d))/.exec(
    text.replace(/\bat\s+\d{1,2}\b/g, ""),
  );
  if (bare) return inRange(Number(bare[1]));
  return null;
}
