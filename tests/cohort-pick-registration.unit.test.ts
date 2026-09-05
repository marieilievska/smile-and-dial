import { describe, expect, it } from "vitest";

import { pickRegistrationToMark } from "../src/lib/goals/pick-registration";

// 2026-09-10, 3:30 PM ET — half an hour after that day's 2 PM session ended.
const NOW = new Date("2026-09-10T19:30:00Z");

describe("pickRegistrationToMark", () => {
  it("picks the session that just happened, not the earliest one", () => {
    // The operator marks people right after a webinar. Picking the earliest
    // would credit the mark to a session they already missed.
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        { id: "b", scheduled_at: "2026-09-10T18:00:00Z", attended_at: null },
      ],
      NOW,
    );
    expect(picked?.id).toBe("b");
  });

  it("ignores a session that has not started yet", () => {
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        { id: "b", scheduled_at: "2026-09-14T18:00:00Z", attended_at: null },
      ],
      NOW,
    );
    expect(picked?.id).toBe("a");
  });

  it("skips one already marked, so a re-mark does not overwrite history", () => {
    // The whole reason outcomes moved off the lead: a no-show who rebooks and
    // attends must not overwrite their own earlier record.
    const picked = pickRegistrationToMark(
      [
        { id: "a", scheduled_at: "2026-09-08T18:00:00Z", attended_at: null },
        {
          id: "b",
          scheduled_at: "2026-09-10T18:00:00Z",
          attended_at: "2026-09-10T19:00:00Z",
        },
      ],
      NOW,
    );
    expect(picked?.id).toBe("a");
  });

  it("returns null when there is nothing markable", () => {
    expect(pickRegistrationToMark([], NOW)).toBeNull();
    expect(
      pickRegistrationToMark(
        [{ id: "a", scheduled_at: "2026-09-14T18:00:00Z", attended_at: null }],
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores a registration with no session date at all", () => {
    expect(
      pickRegistrationToMark(
        [{ id: "a", scheduled_at: null, attended_at: null }],
        NOW,
      ),
    ).toBeNull();
  });

  it("ignores an unparseable session date rather than throwing", () => {
    expect(
      pickRegistrationToMark(
        [{ id: "a", scheduled_at: "not a date", attended_at: null }],
        NOW,
      ),
    ).toBeNull();
  });

  it("treats a session starting exactly now as already started", () => {
    const picked = pickRegistrationToMark(
      [{ id: "a", scheduled_at: NOW.toISOString(), attended_at: null }],
      NOW,
    );
    expect(picked?.id).toBe("a");
  });
});
