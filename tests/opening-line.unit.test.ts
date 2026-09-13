import { describe, expect, it } from "vitest";

import {
  DEFAULT_CALLBACK_OPENER,
  DEFAULT_SPOKEN_BEFORE_OPENER,
  OPENER_MAX_LENGTH,
  normalizeOpener,
  openerTemplateFor,
  pickOpeningSituation,
  renderOpeningInstruction,
  whenPhrase,
} from "../src/lib/elevenlabs/opening-line";

/**
 * The "when" a follow-up opener says ("I called yesterday…"). Counted in
 * CALENDAR days on the lead's own clock. The old humanRecency in
 * conversation-init counted 24-hour blocks, so a 5 PM call still read
 * "earlier today" at 9 AM the next morning.
 */

// Saturday 2026-09-12, 10:00 AM in Chicago (CDT, UTC-5).
const NOW = new Date("2026-09-12T15:00:00Z");
const CHICAGO = "America/Chicago";

describe("whenPhrase", () => {
  it("same local day → earlier today", () => {
    expect(whenPhrase("2026-09-12T13:30:00Z", NOW, CHICAGO)).toBe(
      "earlier today",
    );
  });

  it("yesterday 5 PM read at 10 AM is 'yesterday' (the old 24-hour-block bug said 'earlier today')", () => {
    expect(whenPhrase("2026-09-11T22:00:00Z", NOW, CHICAGO)).toBe("yesterday");
  });

  it("2–6 days → the weekday", () => {
    expect(whenPhrase("2026-09-09T15:00:00Z", NOW, CHICAGO)).toBe(
      "on Wednesday",
    );
    expect(whenPhrase("2026-09-06T15:00:00Z", NOW, CHICAGO)).toBe("on Sunday");
  });

  it("7–13 days → last week", () => {
    expect(whenPhrase("2026-09-05T15:00:00Z", NOW, CHICAGO)).toBe("last week");
    expect(whenPhrase("2026-08-30T15:00:00Z", NOW, CHICAGO)).toBe("last week");
  });

  it("14–29 days → a few weeks ago", () => {
    expect(whenPhrase("2026-08-29T15:00:00Z", NOW, CHICAGO)).toBe(
      "a few weeks ago",
    );
    expect(whenPhrase("2026-08-14T15:00:00Z", NOW, CHICAGO)).toBe(
      "a few weeks ago",
    );
  });

  it("30–59 days → about a month ago (the 30-day 'not interested' rest)", () => {
    expect(whenPhrase("2026-08-13T15:00:00Z", NOW, CHICAGO)).toBe(
      "about a month ago",
    );
    expect(whenPhrase("2026-07-15T15:00:00Z", NOW, CHICAGO)).toBe(
      "about a month ago",
    );
  });

  it("60+ days → a couple of months ago", () => {
    expect(whenPhrase("2026-07-14T15:00:00Z", NOW, CHICAGO)).toBe(
      "a couple of months ago",
    );
  });

  it("counts days on the LEAD's calendar, not Eastern", () => {
    // 11:30 PM Pacific on Sep 11 is already 2:30 AM Sep 12 in New York.
    const nineAmPacific = new Date("2026-09-12T16:00:00Z");
    expect(
      whenPhrase("2026-09-12T06:30:00Z", nineAmPacific, "America/Los_Angeles"),
    ).toBe("yesterday");
    expect(
      whenPhrase("2026-09-12T06:30:00Z", nineAmPacific, "America/New_York"),
    ).toBe("earlier today");
  });

  it("counts calendar days across daylight-saving changes, not 24-hour blocks", () => {
    // Fall back (2026-11-01 is a 25-hour day): 12:30 AM EDT and 11:45 PM EST
    // are both Nov 1, 24h15m apart.
    expect(
      whenPhrase(
        "2026-11-01T04:30:00Z",
        new Date("2026-11-02T04:45:00Z"),
        "America/New_York",
      ),
    ).toBe("earlier today");
    // Spring forward (2026-03-08): 11:30 PM EST Sat Mar 7 → noon EDT Mon Mar 9
    // is 2 calendar days but only 35.5 hours.
    expect(
      whenPhrase(
        "2026-03-08T04:30:00Z",
        new Date("2026-03-09T16:00:00Z"),
        "America/New_York",
      ),
    ).toBe("on Saturday");
  });

  it("missing or unusable timezone → Eastern (not UTC, Central or Pacific)", () => {
    for (const tz of [null, "Not/AZone"]) {
      // 11:30 PM ET Friday — but already Saturday in UTC.
      expect(whenPhrase("2026-09-12T03:30:00Z", NOW, tz)).toBe("yesterday");
      // 12:30 AM ET Saturday — still Friday in Central and Pacific.
      expect(whenPhrase("2026-09-12T04:30:00Z", NOW, tz)).toBe("earlier today");
    }
  });

  it("no usable timestamp → recently", () => {
    expect(whenPhrase(null, NOW, CHICAGO)).toBe("recently");
    expect(whenPhrase("not a date", NOW, CHICAGO)).toBe("recently");
  });
});

describe("pickOpeningSituation — first match wins", () => {
  const nothing = {
    inbound: false,
    hasPendingCallbackInCampaign: false,
    latestConversationAt: null,
  };

  it("inbound beats everything", () => {
    expect(
      pickOpeningSituation({
        inbound: true,
        hasPendingCallbackInCampaign: true,
        latestConversationAt: "2026-09-11T22:00:00Z",
      }),
    ).toBe("inbound");
  });

  it("a callback booked in this campaign beats an earlier conversation", () => {
    expect(
      pickOpeningSituation({
        ...nothing,
        hasPendingCallbackInCampaign: true,
        latestConversationAt: "2026-09-11T22:00:00Z",
      }),
    ).toBe("callback_booked");
  });

  it("a past conversation and no callback → spoken before", () => {
    expect(
      pickOpeningSituation({
        ...nothing,
        latestConversationAt: "2026-09-11T22:00:00Z",
      }),
    ).toBe("spoken_before");
  });

  it("nothing → cold", () => {
    expect(pickOpeningSituation(nothing)).toBe("cold");
  });
});

describe("renderOpeningInstruction", () => {
  it("callback booked + blank box → the default line, {when} filled, told to wait for them", () => {
    expect(
      renderOpeningInstruction({
        situation: "callback_booked",
        template: null,
        when: "yesterday",
      }),
    ).toBe(
      'CALLBACK: we agreed to call this business back. Wait for them to answer, then your first reply must be exactly: "Hey there, um, I called yesterday and was told to try back around this time for the owner or manager. Are they around?" Never use the cold opener on this call, however they answer the phone.',
    );
  });

  it("spoken before uses the campaign's own line", () => {
    expect(
      renderOpeningInstruction({
        situation: "spoken_before",
        template:
          "Hey there, Tom here, um, I reached out {when} about a free Zoom. Is the owner around?",
        when: "about a month ago",
      }),
    ).toBe(
      'FOLLOW-UP: we have spoken with this business before and no callback is booked. Wait for them to answer, then your first reply must be exactly: "Hey there, Tom here, um, I reached out about a month ago about a free Zoom. Is the owner around?" Never use the cold opener on this call, however they answer the phone.',
    );
  });

  it("a whitespace-only box falls back to the default line", () => {
    expect(
      renderOpeningInstruction({
        situation: "spoken_before",
        template: "   ",
        when: "last week",
      }),
    ).toContain(
      '"Hey there, um, I reached out last week and wanted to check back in. Is the owner or manager around?"',
    );
  });

  it("double quotes and line breaks in a saved line can't break the quoted instruction", () => {
    expect(
      renderOpeningInstruction({
        situation: "callback_booked",
        template: 'Hey, it\'s "Tom"\nfrom earlier, {when}.',
        when: "yesterday",
      }),
    ).toContain(`"Hey, it's 'Tom' from earlier, yesterday."`);
  });

  it("curly double quotes become single quotes; apostrophes stay", () => {
    expect(
      renderOpeningInstruction({
        situation: "spoken_before",
        template: "It\u2019s \u201CTom\u201D again, {when}.",
        when: "yesterday",
      }),
    ).toContain(`"It\u2019s 'Tom' again, yesterday."`);
  });

  it("fills every {when} in the line, not just the first", () => {
    expect(
      renderOpeningInstruction({
        situation: "callback_booked",
        template: "I called {when}, and {when} they said try back.",
        when: "yesterday",
      }),
    ).toContain(`"I called yesterday, and yesterday they said try back."`);
  });

  it("a saved line longer than the cap is cut to OPENER_MAX_LENGTH before it's spoken", () => {
    const text = renderOpeningInstruction({
      situation: "spoken_before",
      template: "x".repeat(OPENER_MAX_LENGTH + 100),
      when: "yesterday",
    });
    expect(text).toContain(`"${"x".repeat(OPENER_MAX_LENGTH)}"`);
    expect(text).not.toContain("x".repeat(OPENER_MAX_LENGTH + 1));
  });

  it("a cold call ignores any saved line", () => {
    expect(
      renderOpeningInstruction({
        situation: "cold",
        template: "Hey there, Tom here, I reached out {when}.",
        when: "yesterday",
      }),
    ).toBe(
      "COLD CALL: this is our first real conversation with this business. Use the cold opener below.",
    );
  });

  it("cold and inbound point at the prompt's own openers", () => {
    expect(renderOpeningInstruction({ situation: "cold", when: "" })).toBe(
      "COLD CALL: this is our first real conversation with this business. Use the cold opener below.",
    );
    expect(renderOpeningInstruction({ situation: "inbound", when: "" })).toBe(
      "INBOUND CALL: they are calling us back. Use the inbound opener below.",
    );
  });

  it("the default lines carry no persona name and use {when}", () => {
    for (const line of [
      DEFAULT_CALLBACK_OPENER,
      DEFAULT_SPOKEN_BEFORE_OPENER,
    ]) {
      expect(line).toContain("{when}");
      expect(line).not.toMatch(/\bTom\b/);
    }
  });
});

describe("normalizeOpener — what a campaign's opener box stores", () => {
  it("trims, and blank becomes null (= use the default line)", () => {
    expect(normalizeOpener("  Hey there {when}  ")).toBe("Hey there {when}");
    expect(normalizeOpener("   ")).toBeNull();
    expect(normalizeOpener(undefined)).toBeNull();
    expect(normalizeOpener(null)).toBeNull();
  });

  it("caps at OPENER_MAX_LENGTH", () => {
    expect(normalizeOpener("x".repeat(OPENER_MAX_LENGTH + 50))).toHaveLength(
      OPENER_MAX_LENGTH,
    );
  });

  it("re-trims after the cap so a cut never leaves a trailing space", () => {
    expect(
      normalizeOpener("x".repeat(OPENER_MAX_LENGTH - 1) + " " + "y".repeat(10)),
    ).toBe("x".repeat(OPENER_MAX_LENGTH - 1));
  });
});

describe("the {when} placeholder, as people type it", () => {
  it.each(["{when}", "{{when}}", "{ When }", "{WHEN}", "{{ when }}"])(
    "fills %s",
    (token) => {
      const out = renderOpeningInstruction({
        situation: "spoken_before",
        template: `Hi, I reached out ${token} about the Zoom.`,
        when: "on Tuesday",
      });
      expect(out).toContain('"Hi, I reached out on Tuesday about the Zoom."');
    },
  );

  it("leaves any other braces exactly as typed", () => {
    const out = renderOpeningInstruction({
      situation: "callback_booked",
      template: "Hi {{owner_name}}, I called {when}.",
      when: "yesterday",
    });
    expect(out).toContain('"Hi {{owner_name}}, I called yesterday."');
  });
});

describe("openerTemplateFor", () => {
  const lines = {
    callbackOpener: "callback line",
    spokenBeforeOpener: "spoken before line",
  };

  it("gives the callback line when a callback is booked", () => {
    expect(openerTemplateFor("callback_booked", lines)).toBe("callback line");
  });

  it("gives the spoken-before line on a follow-up", () => {
    expect(openerTemplateFor("spoken_before", lines)).toBe(
      "spoken before line",
    );
  });

  it("gives no line to cold or inbound calls (they use the prompt's openers)", () => {
    expect(openerTemplateFor("cold", lines)).toBeNull();
    expect(openerTemplateFor("inbound", lines)).toBeNull();
  });

  it("treats a missing saved line as none", () => {
    expect(
      openerTemplateFor("callback_booked", {
        callbackOpener: undefined,
        spokenBeforeOpener: null,
      }),
    ).toBeNull();
  });
});
