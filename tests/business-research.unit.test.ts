import { describe, expect, it } from "vitest";

import {
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
