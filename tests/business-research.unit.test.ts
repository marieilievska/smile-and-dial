import { describe, expect, it } from "vitest";

import {
  buildFrontDeskBrief,
  extractOutputText,
  fallbackBrief,
  ownSiteOrigin,
  researchDomain,
} from "../src/lib/openai/business-research";

describe("researchDomain", () => {
  it("strips protocol, www and path", () => {
    expect(researchDomain("https://www.BellaNails.com/services")).toBe(
      "bellanails.com",
    );
  });

  it("accepts a bare domain with no protocol", () => {
    expect(researchDomain("bellanails.com")).toBe("bellanails.com");
  });

  it("returns null for empty, blank or unusable input", () => {
    expect(researchDomain(null)).toBeNull();
    expect(researchDomain("   ")).toBeNull();
    expect(researchDomain("not a url")).toBeNull();
    expect(researchDomain("localhost")).toBeNull();
  });
});

describe("ownSiteOrigin", () => {
  it("returns the origin of the business's own site", () => {
    expect(ownSiteOrigin("https://bellanails.com/book?x=1")).toBe(
      "https://bellanails.com",
    );
  });

  it("rejects directory and social listings so leads.website stays useful", () => {
    expect(ownSiteOrigin("https://www.yelp.com/biz/bella-nails")).toBeNull();
    expect(ownSiteOrigin("https://maps.google.com/place/bella")).toBeNull();
    expect(ownSiteOrigin("https://facebook.com/bellanails")).toBeNull();
  });

  it("does not reject a real site whose name merely starts like a directory", () => {
    expect(ownSiteOrigin("https://googlenails.com")).toBe(
      "https://googlenails.com",
    );
  });

  it("returns null when there is no source url", () => {
    expect(ownSiteOrigin(null)).toBeNull();
  });
});

describe("fallbackBrief", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    heardOnCall: null,
  };

  it("is speakable even though it knows nothing", () => {
    const brief = fallbackBrief(inputs);
    expect(brief.found).toBe(false);
    expect(brief.business_name_spoken).toBe("Bella Nails");
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling Bella Nails, how can I help you?",
    );
    expect(brief.common_caller_reasons.length).toBeGreaterThan(0);
    expect(brief.services).toEqual([]);
    expect(brief.source_url).toBeNull();
  });

  it("blocks the specifics an owner would instantly catch", () => {
    expect(fallbackBrief(inputs).do_not_claim).toEqual(
      expect.arrayContaining(["prices", "opening hours"]),
    );
  });

  it("keeps the greeting natural when we have no company name", () => {
    const brief = fallbackBrief({ ...inputs, company: null });
    expect(brief.business_name_spoken).toBe("the business");
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling, how can I help you?",
    );
  });

  it("uses what the caller already said as the description", () => {
    const brief = fallbackBrief({
      ...inputs,
      heardOnCall: "we do gel manicures and lash extensions",
    });
    expect(brief.what_they_do).toBe("we do gel manicures and lash extensions");
  });
});

describe("buildFrontDeskBrief", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    heardOnCall: null,
  };

  const good = {
    found: true,
    business_name_spoken: "Bella Nails",
    what_they_do: "A nail salon offering manicures and pedicures.",
    services: ["gel manicures", "pedicures", "lash extensions"],
    common_caller_reasons: ["booking", "prices", "walk-in availability"],
    receptionist_greeting: "Thanks for calling Bella Nails!",
    do_not_claim: ["exact prices"],
    source_url: "https://bellanails.com",
  };

  it("passes a complete answer through", () => {
    expect(buildFrontDeskBrief(inputs, good)).toEqual(good);
  });

  it("falls back entirely when the model could not identify the business", () => {
    expect(buildFrontDeskBrief(inputs, { ...good, found: false })).toEqual(
      fallbackBrief(inputs),
    );
  });

  it("falls back entirely on junk input", () => {
    expect(buildFrontDeskBrief(inputs, null)).toEqual(fallbackBrief(inputs));
    expect(buildFrontDeskBrief(inputs, "nope")).toEqual(fallbackBrief(inputs));
  });

  it("fills blank fields from the fallback rather than speaking empties", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      receptionist_greeting: "   ",
      common_caller_reasons: [],
    });
    expect(brief.receptionist_greeting).toBe(
      "Thanks for calling Bella Nails, how can I help you?",
    );
    expect(brief.common_caller_reasons).toEqual(
      fallbackBrief(inputs).common_caller_reasons,
    );
  });

  it("drops non-strings, blanks and overruns from list fields", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      services: ["a", "", "  ", 7, null, "b", "c", "d", "e", "f"],
    });
    expect(brief.services).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("normalises a missing source url to null", () => {
    expect(
      buildFrontDeskBrief(inputs, { ...good, source_url: "" }).source_url,
    ).toBeNull();
  });
});

describe("extractOutputText", () => {
  it("prefers the output_text convenience field", () => {
    expect(extractOutputText({ output_text: '{"found":true}' })).toBe(
      '{"found":true}',
    );
  });

  it("walks the output array past the web_search_call item", () => {
    const body = {
      output: [
        { type: "web_search_call", id: "ws_1", status: "completed" },
        {
          type: "message",
          content: [{ type: "output_text", text: '{"found":true}' }],
        },
      ],
    };
    expect(extractOutputText(body)).toBe('{"found":true}');
  });

  it("accepts a content part typed plain text", () => {
    const body = {
      output: [{ type: "message", content: [{ type: "text", text: "hi" }] }],
    };
    expect(extractOutputText(body)).toBe("hi");
  });

  it("returns empty string for anything unusable", () => {
    expect(extractOutputText(null)).toBe("");
    expect(extractOutputText({})).toBe("");
    expect(extractOutputText({ output_text: "   " })).toBe("");
    expect(extractOutputText({ output: [{ type: "web_search_call" }] })).toBe(
      "",
    );
  });
});
