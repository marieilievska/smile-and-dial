import "server-only";

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
  }[];
  pagination?: { next_page?: string | null };
};

/** List active event types for an organization (paginated). */
export async function listEventTypes(
  organizationUri: string,
  token: string,
): Promise<CalendlyEventType[]> {
  const out: CalendlyEventType[] = [];
  let url: string =
    `${CAL_API}/event_types?organization=` +
    `${encodeURIComponent(organizationUri)}&active=true&count=100`;
  for (let page = 0; page < 10 && url; page++) {
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
      });
    }
    url = data.pagination?.next_page ?? "";
  }
  return out;
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
  },
  token: string,
): Promise<CreateInviteeResult> {
  const invitee: Record<string, string> = {
    email: input.email,
    timezone: input.timezone,
  };
  if (input.name) invitee.name = input.name;

  try {
    const res = await fetch(`${CAL_API}/invitees`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        event_type: input.eventTypeUri,
        start_time: input.startTime,
        invitee,
      }),
    });
    const data = (await res
      .json()
      .catch(() => null)) as CreateInviteeResponse | null;
    if (!res.ok) {
      const detail =
        data?.details
          ?.map((d) => `${d.parameter ?? ""} ${d.message ?? ""}`.trim())
          .join(", ") ||
        data?.message ||
        `Calendly booking failed (${res.status}).`;
      return { ok: false, error: detail };
    }
    return {
      ok: true,
      inviteeUri: data?.resource?.uri ?? null,
      eventUri: data?.resource?.event ?? null,
    };
  } catch {
    return { ok: false, error: "Calendly booking request failed." };
  }
}
