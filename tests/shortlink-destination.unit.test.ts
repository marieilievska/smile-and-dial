import { describe, expect, it } from "vitest";

import {
  findFirstUrl,
  shortLinkLabel,
  withLeadParams,
} from "../src/lib/shortlinks/destination";

describe("findFirstUrl", () => {
  it("finds the link inside a rendered message", () => {
    expect(
      findFirstUrl("Hi Joe's Bar — here it is:\nhttps://presale.hireai.me/"),
    ).toBe("https://presale.hireai.me/");
  });

  it("keeps query strings intact", () => {
    expect(findFirstUrl("see https://x.com/?a=1&b=2 now")).toBe(
      "https://x.com/?a=1&b=2",
    );
  });

  it("strips sentence punctuation that isn't part of the URL", () => {
    expect(findFirstUrl("Go to https://x.com/page.")).toBe(
      "https://x.com/page",
    );
  });

  it("returns null when the template has no link", () => {
    expect(findFirstUrl("Thanks for your time today!")).toBeNull();
  });

  it("only takes the first link", () => {
    expect(findFirstUrl("https://a.com/ and https://b.com/")).toBe(
      "https://a.com/",
    );
  });
});

describe("withLeadParams", () => {
  const base = "https://presale.hireai.me/";

  it("attaches the lead's details to a bare link", () => {
    const url = withLeadParams(base, {
      business_name: "Joe's Bar & Grill",
      phone: "+19545551234",
      google_place_id: "ChIJN1t_tDeuEmsRUsoyG83frY4",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("business_name")).toBe("Joe's Bar & Grill");
    expect(parsed.searchParams.get("phone")).toBe("+19545551234");
    expect(parsed.searchParams.get("google_place_id")).toBe(
      "ChIJN1t_tDeuEmsRUsoyG83frY4",
    );
  });

  it("encodes ampersands and apostrophes so the query string survives", () => {
    const url = withLeadParams(base, { business_name: "Joe's Bar & Grill" });
    // The literal & would otherwise start a new parameter and truncate the name.
    expect(url).toContain("business_name=Joe%27s%20Bar%20%26%20Grill");
    expect(new URL(url).searchParams.get("business_name")).toBe(
      "Joe's Bar & Grill",
    );
  });

  it("encodes spaces as %20 rather than +", () => {
    const url = withLeadParams(base, { utm_campaign: "Med Spa Q3" });
    expect(url).toContain("utm_campaign=Med%20Spa%20Q3");
    expect(url).not.toContain("+");
  });

  it("never overwrites a parameter the author already wrote", () => {
    const authored = `${base}?utm_campaign=founder_rate_launch&utm_source=cold_call`;
    const url = withLeadParams(authored, {
      utm_campaign: "Med Spa Q3",
      utm_source: "smile-and-dial",
      utm_medium: "sms",
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("utm_campaign")).toBe("founder_rate_launch");
    expect(parsed.searchParams.get("utm_source")).toBe("cold_call");
    // ...but still fills the one the author left out.
    expect(parsed.searchParams.get("utm_medium")).toBe("sms");
  });

  it("omits missing values entirely instead of sending key=", () => {
    const url = withLeadParams(base, {
      business_name: "Joe's Bar",
      email: null,
      phone: "",
      google_place_id: undefined,
    });
    expect(url).not.toContain("email=");
    expect(url).not.toContain("phone=");
    expect(url).not.toContain("google_place_id=");
    expect(url).toContain("business_name=");
  });

  it("treats a whitespace-only value as missing", () => {
    expect(withLeadParams(base, { business_name: "   " })).toBe(base);
  });

  it("returns the link untouched when there's nothing to add", () => {
    expect(withLeadParams(base, {})).toBe(base);
  });

  it("appends with & when the author's link already has a query", () => {
    const url = withLeadParams(`${base}?utm_source=cold_call`, {
      business_name: "Joe's Bar",
    });
    expect(url).toBe(
      `${base}?utm_source=cold_call&business_name=Joe%27s%20Bar`,
    );
  });

  it("keeps a #fragment last so it still resolves", () => {
    const url = withLeadParams(`${base}#form`, { business_name: "Joe's Bar" });
    expect(url).toBe(`${base}?business_name=Joe%27s%20Bar#form`);
  });

  it("leaves an unparsable URL alone rather than mangling it", () => {
    expect(withLeadParams("not a url", { business_name: "Joe's Bar" })).toBe(
      "not a url",
    );
  });
});

describe("shortLinkLabel", () => {
  it("reads as a traceable line in the shortener dashboard", () => {
    expect(
      shortLinkLabel({
        campaignName: "Med Spa Q3",
        company: "Joe's Bar & Grill",
        channel: "sms",
      }),
    ).toBe("smiledial | Med Spa Q3 | Joe's Bar & Grill | sms");
  });

  it("stays readable when the campaign or business is unknown", () => {
    expect(
      shortLinkLabel({ campaignName: null, company: null, channel: "email" }),
    ).toBe("smiledial | no campaign | unknown business | email");
  });
});
