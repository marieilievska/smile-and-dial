import { describe, expect, it } from "vitest";

import {
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
