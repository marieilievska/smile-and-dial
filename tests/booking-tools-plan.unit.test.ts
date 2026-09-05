import { describe, expect, it } from "vitest";

import {
  BOOKING_NOT_CONFIGURED_MESSAGE,
  planBookingTool,
} from "../src/lib/calendly/booking-tools-plan";

describe("planBookingTool — get_available_times / book_appointment honesty matrix", () => {
  it("connected + event chosen → live booking, in either mode", () => {
    expect(
      planBookingTool({ live: true, hasToken: true, hasEventType: true }),
    ).toBe("live");
    expect(
      planBookingTool({ live: false, hasToken: true, hasEventType: true }),
    ).toBe("live");
  });

  it("connected but NO event chosen → booking is off for the campaign, in either mode", () => {
    expect(
      planBookingTool({ live: true, hasToken: true, hasEventType: false }),
    ).toBe("disabled");
    expect(
      planBookingTool({ live: false, hasToken: true, hasEventType: false }),
    ).toBe("disabled");
  });

  it("non-live with no Calendly → mock (generic slots / pretend confirmation keep dev flows moving)", () => {
    expect(
      planBookingTool({ live: false, hasToken: false, hasEventType: false }),
    ).toBe("mock");
  });

  it("LIVE with no Calendly → not_configured: never invent slots or fake a booking on a real call", () => {
    expect(
      planBookingTool({ live: true, hasToken: false, hasEventType: false }),
    ).toBe("not_configured");
  });

  it("an event id without a token can't be live (the token is what books)", () => {
    expect(
      planBookingTool({ live: true, hasToken: false, hasEventType: true }),
    ).toBe("not_configured");
    expect(
      planBookingTool({ live: false, hasToken: false, hasEventType: true }),
    ).toBe("mock");
  });

  it("the refusal lines tell the agent what NOT to say", () => {
    expect(BOOKING_NOT_CONFIGURED_MESSAGE.get_available_times).toMatch(
      /Scheduling isn't set up for this campaign yet/,
    );
    expect(BOOKING_NOT_CONFIGURED_MESSAGE.get_available_times).toMatch(
      /Don't invent a time/,
    );
    expect(BOOKING_NOT_CONFIGURED_MESSAGE.book_appointment).toMatch(
      /Don't say it's booked/,
    );
  });
});
