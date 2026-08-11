import { describe, expect, test } from "vitest";

import { hasBookingAtSlot } from "@/lib/calendly/booking-dedup";

describe("hasBookingAtSlot", () => {
  test("matches the same instant across timestamp formats (DB +00:00 vs Date Z)", () => {
    expect(
      hasBookingAtSlot(
        [{ scheduled_at: "2026-08-13T17:00:00+00:00" }],
        "2026-08-13T17:00:00.000Z",
      ),
    ).toBe(true);
  });

  test("a different slot does not match", () => {
    expect(
      hasBookingAtSlot(
        [{ scheduled_at: "2026-08-13T18:00:00+00:00" }],
        "2026-08-13T17:00:00.000Z",
      ),
    ).toBe(false);
  });

  test("matches when any of several bookings is at the slot", () => {
    expect(
      hasBookingAtSlot(
        [
          { scheduled_at: "2026-08-13T15:00:00+00:00" },
          { scheduled_at: "2026-08-13T17:00:00+00:00" },
        ],
        "2026-08-13T17:00:00Z",
      ),
    ).toBe(true);
  });

  test("empty list, null slot, or unparseable target are safe (no match)", () => {
    expect(hasBookingAtSlot([], "2026-08-13T17:00:00Z")).toBe(false);
    expect(
      hasBookingAtSlot([{ scheduled_at: null }], "2026-08-13T17:00:00Z"),
    ).toBe(false);
    expect(
      hasBookingAtSlot(
        [{ scheduled_at: "2026-08-13T17:00:00Z" }],
        "not-a-date",
      ),
    ).toBe(false);
  });
});
