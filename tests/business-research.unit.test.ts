import { describe, expect, it } from "vitest";

import {
  buildFrontDeskBrief,
  buildResearchRequest,
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

  // Regression: research for a real salon returned a vagaro.com listings page
  // and we stored it as the lead's website. Not their site — and since that
  // column pins the next search, it would have aimed every future lookup at a
  // platform whose pages can't be read. 69% of leads are on Vagaro.
  it("rejects booking platforms, which is where research usually lands", () => {
    expect(
      ownSiteOrigin("https://www.vagaro.com/listings/lashes/saltlakecity--ut"),
    ).toBeNull();
    expect(
      ownSiteOrigin("https://square.site/book/5918NVHB63WEC/shania-esthetics"),
    ).toBeNull();
    expect(ownSiteOrigin("https://glossgenius.com/x")).toBeNull();
    expect(ownSiteOrigin("https://booksy.com/en-us/1234_salon")).toBeNull();
    expect(ownSiteOrigin("https://app.squareup.com/appointments")).toBeNull();
  });

  it("does not reject a real site whose name merely starts like a directory", () => {
    expect(ownSiteOrigin("https://googlenails.com")).toBe(
      "https://googlenails.com",
    );
    expect(ownSiteOrigin("https://squarenails.com")).toBe(
      "https://squarenails.com",
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
    bookingSoftware: null,
    heardOnCall: null,
  };

  it("still names the business when it knows nothing else", () => {
    const brief = fallbackBrief(inputs);
    expect(brief.found).toBe(false);
    expect(brief.business_name_spoken).toBe("Bella Nails");
    expect(brief.hours).toBe("");
    expect(brief.source_url).toBeNull();
  });

  it("blocks the specifics an owner would instantly catch", () => {
    expect(fallbackBrief(inputs).do_not_claim).toEqual(
      expect.arrayContaining(["prices", "opening hours"]),
    );
  });

  it("falls back to a generic name when we have none", () => {
    expect(
      fallbackBrief({ ...inputs, company: null }).business_name_spoken,
    ).toBe("the business");
  });

  // The two facts that survive a total research failure, because they came from
  // our own import rather than the web.
  it("still knows where they are, from the lead's own city", () => {
    expect(fallbackBrief(inputs).where_we_are).toBe("Cicero, IL");
  });

  it("still knows how to book, from the imported booking platform", () => {
    expect(
      fallbackBrief({ ...inputs, bookingSoftware: "Vagaro" }).how_to_book,
    ).toBe("You can book through Vagaro.");
  });

  it("leaves booking blank when we don't know the platform", () => {
    expect(fallbackBrief(inputs).how_to_book).toBe("");
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
    bookingSoftware: "Vagaro",
    heardOnCall: null,
  };

  const good = {
    found: true,
    business_name_spoken: "Bella Nails",
    what_they_do: "A nail salon offering manicures and pedicures.",
    where_we_are: "On Main Street, parking round the back.",
    hours: "Open Monday to Saturday, nine to six.",
    how_to_book: "I can get you booked in through Vagaro.",
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

  // The bug this guards: `found` used to mean both "I identified them" AND "I
  // got everything", so one unverifiable field blanked an otherwise perfect
  // brief. Unknown hours must cost us the hours and nothing else.
  it("keeps everything else when hours could not be verified", () => {
    const brief = buildFrontDeskBrief(inputs, { ...good, hours: "" });
    expect(brief.found).toBe(true);
    expect(brief.hours).toBe("");
    expect(brief.where_we_are).toBe("On Main Street, parking round the back.");
    expect(brief.what_they_do).toBe(good.what_they_do);
  });

  it("fills a blank location and booking line from what we already knew", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      where_we_are: "   ",
      how_to_book: "",
    });
    expect(brief.where_we_are).toBe("Cicero, IL");
    expect(brief.how_to_book).toBe("You can book through Vagaro.");
  });

  it("drops non-strings, blanks and overruns from do_not_claim", () => {
    const brief = buildFrontDeskBrief(inputs, {
      ...good,
      do_not_claim: ["a", "", "  ", 7, null, "b", "c", "d", "e", "f", "g"],
    });
    expect(brief.do_not_claim).toEqual(["a", "b", "c", "d", "e", "f"]);
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

describe("buildResearchRequest", () => {
  const inputs = {
    company: "Bella Nails",
    city: "Cicero",
    state: "IL",
    website: null,
    bookingSoftware: null,
    heardOnCall: null,
  };

  function toolOf(req: Record<string, unknown>) {
    return (req.tools as Record<string, unknown>[])[0];
  }

  it("pins the search to the lead's own domain when we have one", () => {
    const req = buildResearchRequest({
      ...inputs,
      website: "https://www.bellanails.com/book",
    });
    expect(toolOf(req).filters).toEqual({
      allowed_domains: ["bellanails.com"],
    });
  });

  it("searches openly when we have no website", () => {
    expect(toolOf(buildResearchRequest(inputs))).not.toHaveProperty("filters");
  });

  it("always requests web search and the strict brief schema", () => {
    const req = buildResearchRequest(inputs);
    expect(toolOf(req).type).toBe("web_search");
    const format = (req.text as { format: Record<string, unknown> }).format;
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.name).toBe("front_desk_brief");
  });

  it("puts the business, its location and anything heard on the call in the prompt", () => {
    const req = buildResearchRequest({
      ...inputs,
      heardOnCall: "we mostly do lashes now",
    });
    expect(String(req.input)).toContain("Bella Nails");
    expect(String(req.input)).toContain("Cicero, IL");
    expect(String(req.input)).toContain("we mostly do lashes now");
  });
});
