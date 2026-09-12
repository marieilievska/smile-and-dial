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
 *
 * `fromIso` is a timestamp with an offset (a timestamptz from the database).
 * A moment slightly in the future — clock drift — reads as "earlier today".
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
  // en-CA dates are YYYY-MM-DD on Node and current browsers. If a runtime ever
  // formats them differently the count is NaN, and "recently" is honest where
  // any band would be a guess.
  if (!Number.isFinite(days)) return "recently";
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

/** Which opener a call gets. Checked in this order; the first match wins. */
export type OpeningSituation =
  | "inbound"
  | "callback_booked"
  | "spoken_before"
  | "cold";

/** The "Callback booked" line when the campaign's box is blank. No persona
 *  name: this code serves every agent, and agents have no persona-name field. */
export const DEFAULT_CALLBACK_OPENER =
  "Hey there, um, I called {when} and was told to try back around this time for the owner or manager. Are they around?";

/** The "Spoken before" line when the campaign's box is blank. It covers every
 *  reason we'd call again (a front desk last time, a "not interested" after its
 *  rest, a missed callback), so it only claims that we reached out, and when. */
export const DEFAULT_SPOKEN_BEFORE_OPENER =
  "Hey there, um, I reached out {when} and wanted to check back in. Is the owner or manager around?";

/** Longest opener line a campaign may save. */
export const OPENER_MAX_LENGTH = 500;

export function pickOpeningSituation(input: {
  inbound: boolean;
  hasPendingCallbackInCampaign: boolean;
  latestConversationAt: string | null;
}): OpeningSituation {
  if (input.inbound) return "inbound";
  if (input.hasPendingCallbackInCampaign) return "callback_booked";
  if (input.latestConversationAt) return "spoken_before";
  return "cold";
}

/** What a campaign's opener box stores: trimmed, capped at
 *  OPENER_MAX_LENGTH, and blank → null (= use the default line). */
export function normalizeOpener(
  value: string | null | undefined,
): string | null {
  const text = (value ?? "").trim().slice(0, OPENER_MAX_LENGTH).trim();
  return text || null;
}

/** The spoken line: the campaign's text or the default, {when} filled in,
 *  folded onto one line, with double quotes turned into single quotes so the
 *  line can't close the quotes the instruction wraps it in. */
function renderLine(
  template: string | null | undefined,
  fallback: string,
  when: string,
): string {
  const text = (template ?? "").trim() || fallback;
  return text
    .split("{when}")
    .join(when)
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The {{opening_instruction}} dynamic variable for one call. */
export function renderOpeningInstruction(input: {
  situation: OpeningSituation;
  template?: string | null;
  when: string;
}): string {
  switch (input.situation) {
    case "inbound":
      return "INBOUND CALL: they are calling us back. Use the inbound opener below.";
    case "cold":
      return "COLD CALL: this is our first real conversation with this business. Use the cold opener below.";
    case "callback_booked": {
      const line = renderLine(
        input.template,
        DEFAULT_CALLBACK_OPENER,
        input.when,
      );
      return `CALLBACK: we agreed to call this business back. Wait for them to answer, then your first reply must be exactly: "${line}" Never use the cold opener on this call, however they answer the phone.`;
    }
    case "spoken_before": {
      const line = renderLine(
        input.template,
        DEFAULT_SPOKEN_BEFORE_OPENER,
        input.when,
      );
      return `FOLLOW-UP: we have spoken with this business before and no callback is booked. Wait for them to answer, then your first reply must be exactly: "${line}" Never use the cold opener on this call, however they answer the phone.`;
    }
  }
}
