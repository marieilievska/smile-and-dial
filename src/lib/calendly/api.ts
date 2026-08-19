import "server-only";

import type {
  CalendlyCustomQuestion,
  CalendlyQuestionAnswer,
} from "./booking";

/**
 * Calendly API v2 client.
 *
 * Calendly is a PER-USER integration: each rep connects their own account by
 * pasting a Personal Access Token, and the AI books on behalf of the campaign
 * owner. So every function here takes the caller's token explicitly — there is
 * no global Calendly env var. "Live" simply means the relevant user has
 * connected (a token exists in user_integrations).
 *
 * Calendly's 2025 Scheduling API books a meeting directly at a chosen time
 * (no invitee link-click) via POST /invitees (scope scheduled_events:write).
 * Verified against the live API:
 *   - POST /invitees requires { event_type, start_time, invitee:{ email,
 *     timezone, name? } }; location is only required for event types that ask
 *     the invitee for it (host-defined Zoom/Meet types don't).
 *   - GET /event_type_available_times?event_type&start_time&end_time returns a
 *     `collection` of slots (future-only, <=7-day window).
 *   - GET /event_types?organization=... lists the bookable event types.
 */

const CAL_API = "https://api.calendly.com";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export type CalendlyIdentity = {
  userUri: string | null;
  organizationUri: string | null;
};

export type CalendlyEventType = {
  uri: string;
  name: string;
  schedulingUrl: string | null;
  durationMinutes: number | null;
  active: boolean;
  /** "round_robin" | "collective" for team events; null for solo events. */
  poolingType: string | null;
};

export type CalendlySlot = {
  startTime: string;
  schedulingUrl: string | null;
};

export type CreateInviteeResult =
  | { ok: true; inviteeUri: string | null; eventUri: string | null }
  | { ok: false; error: string };

type UsersMeResponse = {
  resource?: { uri?: string; current_organization?: string };
};

/** Resolve the user + organization URIs for a token (GET /users/me). Also
 *  doubles as a token-validity check (null org => bad/unauthorized token). */
export async function getIdentity(token: string): Promise<CalendlyIdentity> {
  try {
    const res = await fetch(`${CAL_API}/users/me`, {
      headers: authHeaders(token),
    });
    if (!res.ok) return { userUri: null, organizationUri: null };
    const data = (await res.json()) as UsersMeResponse;
    return {
      userUri: data.resource?.uri ?? null,
      organizationUri: data.resource?.current_organization ?? null,
    };
  } catch {
    return { userUri: null, organizationUri: null };
  }
}

type EventTypesResponse = {
  collection?: {
    uri?: string;
    name?: string;
    scheduling_url?: string;
    duration?: number;
    active?: boolean;
    pooling_type?: string | null;
  }[];
  pagination?: { next_page?: string | null };
};

/** Fetch (paginated) active event types for an arbitrary scope query string,
 *  e.g. `organization=<uri>` or `user=<uri>`. */
async function fetchEventTypes(
  scopeParam: string,
  token: string,
): Promise<CalendlyEventType[]> {
  const out: CalendlyEventType[] = [];
  let url: string = `${CAL_API}/event_types?${scopeParam}&active=true&count=100`;
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) break;
    const data = (await res.json()) as EventTypesResponse;
    for (const e of data.collection ?? []) {
      if (!e.uri || !e.name) continue;
      out.push({
        uri: e.uri,
        name: e.name,
        schedulingUrl: e.scheduling_url ?? null,
        durationMinutes: typeof e.duration === "number" ? e.duration : null,
        active: e.active ?? true,
        poolingType: e.pooling_type ?? null,
      });
    }
    url = data.pagination?.next_page ?? "";
  }
  return out;
}

type OrgMembershipsResponse = {
  collection?: { user?: { uri?: string } }[];
  pagination?: { next_page?: string | null };
};

/** List the user URIs of every member in an organization (paginated). */
async function listOrgMemberUris(
  organizationUri: string,
  token: string,
): Promise<string[]> {
  const out: string[] = [];
  let url: string =
    `${CAL_API}/organization_memberships?organization=` +
    `${encodeURIComponent(organizationUri)}&count=100`;
  for (let page = 0; page < 20 && url; page++) {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) break;
    const data = (await res.json()) as OrgMembershipsResponse;
    for (const m of data.collection ?? []) {
      if (m.user?.uri) out.push(m.user.uri);
    }
    url = data.pagination?.next_page ?? "";
  }
  return out;
}

/**
 * List the bookable event types for an organization.
 *
 * Calendly's org-scope `event_types?organization=` list OMITS some team
 * round-robin / collective events (e.g. ones created at team level with a
 * `/d/<hash>/` booking link and a null slug) — those only surface on the
 * PER-USER `event_types?user=` query of a host. So we union the org-scope list
 * with each member's team (pooling_type != null) events, deduped by URI. We
 * deliberately do NOT add members' personal solo events (that would flood the
 * picker with every rep's 1:1 calls); only shared team events are merged in.
 */
export async function listEventTypes(
  organizationUri: string,
  token: string,
): Promise<CalendlyEventType[]> {
  const byUri = new Map<string, CalendlyEventType>();

  // 1) Org-wide list (covers all solo + org-surfaced team events).
  for (const e of await fetchEventTypes(
    `organization=${encodeURIComponent(organizationUri)}`,
    token,
  )) {
    byUri.set(e.uri, e);
  }

  // 2) Per-member team events the org list misses (round_robin / collective).
  const members = await listOrgMemberUris(organizationUri, token);
  for (const memberUri of members) {
    const events = await fetchEventTypes(
      `user=${encodeURIComponent(memberUri)}`,
      token,
    );
    for (const e of events) {
      if (e.poolingType && !byUri.has(e.uri)) byUri.set(e.uri, e);
    }
  }

  return [...byUri.values()];
}

type EventTypeResource = {
  resource?: {
    locations?: { kind?: string | null }[] | null;
    custom_questions?: CalendlyCustomQuestion[] | null;
  };
};

/**
 * Fetch the parts of an event type we must echo back when booking, in ONE GET
 * (this runs mid-call, so a second round trip is real dead air):
 *
 *  - locations       — a booking that omits the location for an event type
 *    that has one is rejected ("location_configuration.kind invalid location
 *    choice").
 *  - customQuestions — the host's booking-form fields. A REQUIRED one left
 *    blank is rejected ("Required Questions and Answers cannot be blank."),
 *    which took booking to 0% on 2026-08-18.
 *
 * Both live in the HOST's Calendly account and can change without warning, so
 * we read them per booking rather than caching assumptions. Returns empty
 * collections on any failure — no worse than before for simple event types.
 */
export async function getEventTypeConfig(
  eventTypeUri: string,
  token: string,
): Promise<{
  locations: { kind: string }[];
  customQuestions: CalendlyCustomQuestion[];
}> {
  try {
    const res = await fetch(eventTypeUri, { headers: authHeaders(token) });
    if (!res.ok) return { locations: [], customQuestions: [] };
    const data = (await res.json()) as EventTypeResource;
    return {
      locations: (data.resource?.locations ?? []).flatMap((l) =>
        typeof l?.kind === "string" && l.kind.length > 0
          ? [{ kind: l.kind }]
          : [],
      ),
      customQuestions: data.resource?.custom_questions ?? [],
    };
  } catch {
    return { locations: [], customQuestions: [] };
  }
}

type AvailableTimesResponse = {
  collection?: {
    status?: string;
    start_time?: string;
    scheduling_url?: string;
  }[];
};

/**
 * Fetch open slots for an event type. Calendly requires a future window no
 * larger than 7 days, so callers should pass a range within that bound.
 */
export async function getAvailableTimes(
  eventTypeUri: string,
  startISO: string,
  endISO: string,
  token: string,
): Promise<CalendlySlot[]> {
  const url =
    `${CAL_API}/event_type_available_times?event_type=` +
    `${encodeURIComponent(eventTypeUri)}&start_time=` +
    `${encodeURIComponent(startISO)}&end_time=${encodeURIComponent(endISO)}`;
  try {
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) return [];
    const data = (await res.json()) as AvailableTimesResponse;
    return (data.collection ?? [])
      .filter((s) => s.status === "available" && s.start_time)
      .map((s) => ({
        startTime: s.start_time as string,
        schedulingUrl: s.scheduling_url ?? null,
      }));
  } catch {
    return [];
  }
}

type CreateInviteeResponse = {
  resource?: { uri?: string; event?: string };
  message?: string;
  details?: { parameter?: string; message?: string }[];
};

/**
 * Cancel a scheduled Calendly event (POST /scheduled_events/{uuid}/cancellation).
 * `eventUri` is the full scheduled-event URI we store on `calendly_events`
 * (…/scheduled_events/{uuid}), so we just append `/cancellation`. Best-effort:
 * returns ok=false with a message on failure so the caller can log and carry on
 * rather than throw (a cancel that hiccups must never block the new booking).
 */
export async function cancelScheduledEvent(
  eventUri: string,
  token: string,
  reason = "Superseded by a newer appointment for this lead.",
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${eventUri}/cancellation`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      return { ok: false, error: `Calendly cancel failed (${res.status}).` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Calendly cancel request failed." };
  }
}

type ScheduledEventResponse = {
  resource?: {
    event_memberships?: { user?: string; user_email?: string }[];
  };
};

/**
 * Resolve the HOST of a scheduled Calendly event — the rep who ran the booking —
 * by email, so a handoff task can be assigned to the right closer. `eventUri` is
 * the full scheduled-event URI stored on `calendly_events.event_uri`
 * (…/scheduled_events/{uuid}); we GET it and read
 * `event_memberships[0].user_email`. Best-effort: returns null on any failure or
 * missing field so the caller can fall back to another assignee.
 */
export async function getScheduledEventHostEmail(
  eventUri: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(eventUri, { headers: authHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as ScheduledEventResponse;
    // Read user_email directly (present in the current Calendly API). If a future
    // API version drops it, this returns null and the caller falls back to the
    // account owner — no user-URI resolution needed.
    const email = data.resource?.event_memberships?.[0]?.user_email;
    return email && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Book a meeting directly (Scheduling API). `startTime` must be an open slot
 * (ISO 8601). Returns the created invitee + event URIs, or a human-readable
 * error (e.g. the slot was just taken).
 */
export async function createInvitee(
  input: {
    eventTypeUri: string;
    startTime: string;
    email: string;
    name?: string;
    timezone: string;
    /** The event type's location, echoed back so Calendly accepts the booking.
     *  REQUIRED whenever the event type has a location (Zoom/Meet/phone/etc.);
     *  omit only when it has none. Build it from getEventTypeLocations via
     *  buildInviteeLocation (see ./booking). */
    location?: { kind: string };
    /** UTM attribution stamped on the booking (Calendly's invitee `tracking`
     *  object). Surfaces in Calendly reporting/exports + the post-call webhook.
     *  Build it from bookingTracking (see ./booking). */
    tracking?: {
      utm_source?: string;
      utm_medium?: string;
      utm_campaign?: string;
      utm_content?: string;
      utm_term?: string;
      salesforce_uuid?: string;
    };
    /** Answers to the event type's REQUIRED booking-form questions. Calendly
     *  rejects the booking outright when one is missing ("Required Questions
     *  and Answers cannot be blank."). Build it from getEventTypeConfig's
     *  customQuestions via buildQuestionsAndAnswers (see ./booking). */
    questionsAndAnswers?: CalendlyQuestionAnswer[];
  },
  token: string,
): Promise<CreateInviteeResult> {
  const invitee: Record<string, string> = {
    email: input.email,
    timezone: input.timezone,
  };
  if (input.name) invitee.name = input.name;

  const payload: Record<string, unknown> = {
    event_type: input.eventTypeUri,
    start_time: input.startTime,
    invitee,
  };
  // Calendly rejects a booking that omits the location for an event type that
  // has one ("location_configuration.kind invalid location choice"). Include it
  // when we have it; omit entirely for locationless event types.
  if (input.location) payload.location = input.location;
  // Answers to the host's required booking-form questions. Omit the field
  // entirely when there are none — an empty array reads as "blank answers".
  if (input.questionsAndAnswers?.length) {
    payload.questions_and_answers = input.questionsAndAnswers;
  }
  // UTM attribution (Calendly's invitee `tracking`). Only send when at least one
  // field is set, so a bookingless/untagged call never posts an empty object.
  if (input.tracking && Object.values(input.tracking).some((v) => v)) {
    payload.tracking = input.tracking;
  }

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch(`${CAL_API}/invitees`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    });
    const data = (await res
      .json()
      .catch(() => null)) as CreateInviteeResponse | null;
    const detail =
      data?.details
        ?.map((d) => `${d.parameter ?? ""} ${d.message ?? ""}`.trim())
        .join(", ") ||
      data?.message ||
      `Calendly booking failed (${res.status}).`;
    return { ok: res.ok, data, detail };
  };

  try {
    let result = await post(payload);
    // Attribution must NEVER cost a real booking. Calendly's Create Invitee API
    // treats the `tracking` object as all-or-nothing, so a stray/partial one
    // gets the whole booking rejected ("tracking.utm_* is missing"). If that's
    // why it failed, drop tracking and retry once — the booking is the goal, the
    // UTM tag is a nice-to-have.
    if (!result.ok && payload.tracking && /tracking/i.test(result.detail)) {
      const retry = { ...payload };
      delete retry.tracking;
      result = await post(retry);
    }
    if (!result.ok) return { ok: false, error: result.detail };
    return {
      ok: true,
      inviteeUri: result.data?.resource?.uri ?? null,
      eventUri: result.data?.resource?.event ?? null,
    };
  } catch {
    return { ok: false, error: "Calendly booking request failed." };
  }
}
