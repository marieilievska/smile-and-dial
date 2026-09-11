import { afterEach, describe, expect, it, vi } from "vitest";

import { createInvitee } from "../src/lib/calendly/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status: number; body: unknown };

/** Stub Calendly: answer each POST with the next reply, and record every URL
 *  and JSON body we sent. */
function stubCalendly(replies: Reply[]) {
  const urls: string[] = [];
  const sent: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: string }) => {
    urls.push(url);
    sent.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    const reply = replies.shift() ?? { status: 500, body: {} };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return { urls, sent };
}

const booked: Reply = {
  status: 201,
  body: {
    resource: {
      uri: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
      event: "https://api.calendly.com/scheduled_events/EV1",
    },
  },
};

/** Calendly's 400 shape: a `details` list of { parameter, message }. */
const rejected = (parameter: string, message: string): Reply => ({
  status: 400,
  body: {
    title: "Invalid Argument",
    message: "The supplied parameters are invalid.",
    details: [{ parameter, message }],
  },
});

const company = {
  question: "Company Name",
  answer: "Alaska Healing Arts",
  position: 0,
};
const phone = { question: "Phone Number", answer: "+18135550123", position: 1 };

const input = {
  eventTypeUri: "https://api.calendly.com/event_types/ET1",
  startTime: "2026-09-15T18:00:00.000Z",
  email: "owner@alaskahealingarts.com",
  name: "Roberta",
  timezone: "America/Anchorage",
  questionsAndAnswers: [company],
  optionalQuestionsAndAnswers: [phone],
};

describe("createInvitee: optional answers", () => {
  it("sends the optional phone answer alongside the required ones", async () => {
    const { urls, sent } = stubCalendly([booked]);
    const result = await createInvitee(input, "token");
    expect(result).toEqual({
      ok: true,
      inviteeUri: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
      eventUri: "https://api.calendly.com/scheduled_events/EV1",
    });
    expect(urls).toEqual(["https://api.calendly.com/invitees"]);
    expect(sent[0].questions_and_answers).toEqual([company, phone]);
  });

  it("retries once WITHOUT the phone when Calendly rejects an answer (the booking beats the field)", async () => {
    const { sent } = stubCalendly([
      rejected(
        "questions_and_answers",
        "Phone Number is not a valid phone number",
      ),
      booked,
    ]);
    const result = await createInvitee(input, "token");
    expect(result).toMatchObject({ ok: true, droppedOptionalAnswers: true });
    expect(sent).toHaveLength(2);
    // The required company answer is still sent; only the optional one goes.
    expect(sent[1].questions_and_answers).toEqual([company]);
  });

  it("omits questions_and_answers entirely on the retry when nothing required is left", async () => {
    const { sent } = stubCalendly([
      rejected("questions_and_answers", "invalid phone"),
      booked,
    ]);
    await createInvitee({ ...input, questionsAndAnswers: [] }, "token");
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toHaveProperty("questions_and_answers");
  });

  it("does not drop the phone for an unrelated failure (slot filled)", async () => {
    const { sent } = stubCalendly([
      rejected("start_time", "That start time has been filled"),
    ]);
    const result = await createInvitee(input, "token");
    expect(result).toEqual({
      ok: false,
      error: "start_time That start time has been filled",
    });
    expect(sent).toHaveLength(1);
  });

  it("composes with the tracking retry: drop tracking first, then the phone", async () => {
    const tracking = {
      utm_source: "smile_dial",
      utm_medium: "voice",
      utm_campaign: "webinar",
      utm_content: "webinar",
      utm_term: "voice_ai",
      salesforce_uuid: "lead-1",
    };
    const { sent } = stubCalendly([
      rejected("tracking.utm_content", "is missing"),
      rejected(
        "questions_and_answers",
        "Phone Number is not a valid phone number",
      ),
      booked,
    ]);
    const result = await createInvitee({ ...input, tracking }, "token");
    expect(result).toMatchObject({ ok: true, droppedOptionalAnswers: true });
    expect(sent).toHaveLength(3);
    expect(sent[0]).toHaveProperty("tracking");
    expect(sent[1]).not.toHaveProperty("tracking");
    expect(sent[1].questions_and_answers).toEqual([company, phone]);
    expect(sent[2]).not.toHaveProperty("tracking");
    expect(sent[2].questions_and_answers).toEqual([company]);
  });

  it("with no optional answers, a question failure is returned as-is (no extra POST)", async () => {
    const { sent } = stubCalendly([
      rejected(
        "questions_and_answers",
        "Required Questions and Answers cannot be blank.",
      ),
    ]);
    const result = await createInvitee(
      { ...input, optionalQuestionsAndAnswers: [] },
      "token",
    );
    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(1);
  });
});
