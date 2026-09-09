// tests/lead-timezone-nanp.unit.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  phoneToTimezone,
  stateFromPhone,
  stateToTimezone,
} from "../src/lib/leads/timezone";
import {
  PROVINCE_AREA_CODES,
  STATE_AREA_CODES,
  stateForAreaCode,
} from "../src/lib/dialer/nanp-states";

/**
 * A lead with no timezone is not skipped — `is_within_calling_hours` does
 * `coalesce(lead_timezone, 'America/New_York')`, and Eastern is the EARLIEST
 * US zone. So an area code this file cannot resolve does not fail safe, it
 * fails EARLY: a California lead falls back to Eastern and a 9am window opens
 * at 6am local, under the 8am floor. That is why these are pinned.
 */

describe("the lead timezone map has one source of truth", () => {
  it("declares no area-code map of its own", () => {
    const src = readFileSync("src/lib/leads/timezone.ts", "utf8");
    expect(src).not.toMatch(/STATE_AREA_CODES\s*:\s*Record/);
  });

  it("agrees with the dialer's NANP map on every US area code", () => {
    for (const [state, codes] of Object.entries(STATE_AREA_CODES)) {
      for (const code of codes) {
        expect(stateFromPhone(`${code}5550123`)).toBe(state);
      }
    }
  });

  it("claims no US state for a code the dialer's map does not have", () => {
    for (let n = 200; n <= 999; n++) {
      const code = String(n);
      expect(stateFromPhone(`${code}5550123`)).toBe(stateForAreaCode(code));
    }
  });

  it("gives every state in the shared map an IANA zone", () => {
    for (const state of Object.keys(STATE_AREA_CODES)) {
      expect(stateToTimezone(state)).toBeTruthy();
    }
  });
});

describe("area codes that used to resolve to no timezone at all", () => {
  // [area code, state, IANA zone] — generated from the NANPA NPA Database
  // (reports.nanpa.com/public/npa_report.csv, file dated 09/09/2026), never
  // hand-transcribed. All 29 were in-service geographic NPAs that the private
  // duplicate map in timezone.ts had never picked up.
  //
  // The state column is the point, per the lesson from #509: asserting a code
  // against the code it supposedly overlays is self-consistent and can be
  // consistently wrong. The literal state pins each row to something outside
  // this repo.
  const NEWLY_RESOLVED: [code: string, state: string, zone: string][] = [
    ["227", "MD", "America/New_York"],
    ["235", "MO", "America/Chicago"],
    ["283", "OH", "America/New_York"],
    ["324", "FL", "America/New_York"],
    ["327", "AR", "America/Chicago"],
    ["329", "NY", "America/New_York"],
    ["353", "WI", "America/Chicago"],
    ["357", "CA", "America/Los_Angeles"],
    ["369", "CA", "America/Los_Angeles"],
    ["436", "OH", "America/New_York"],
    ["448", "FL", "America/Chicago"], // NANPA TIME_ZONE=EC — see below
    ["457", "LA", "America/Chicago"],
    ["465", "NY", "America/New_York"],
    ["471", "MS", "America/Chicago"],
    ["483", "AL", "America/Chicago"],
    ["572", "OK", "America/Chicago"],
    ["621", "TX", "America/Chicago"],
    ["624", "NY", "America/New_York"],
    ["686", "VA", "America/New_York"],
    ["728", "FL", "America/New_York"],
    ["729", "TN", "America/New_York"], // NANPA TIME_ZONE=EC — see below
    ["738", "CA", "America/Los_Angeles"],
    ["748", "CO", "America/Denver"],
    ["771", "DC", "America/New_York"],
    ["821", "SC", "America/New_York"],
    ["837", "CA", "America/Los_Angeles"],
    ["840", "CA", "America/Los_Angeles"],
    ["861", "IL", "America/Chicago"],
    ["924", "MN", "America/Chicago"],
  ];

  it.each(NEWLY_RESOLVED)("%s is in %s, on %s", (code, state, zone) => {
    expect(stateFromPhone(`${code}5550123`)).toBe(state);
    expect(phoneToTimezone(`${code}5550123`)).toBe(zone);
  });

  it("resolves all 29 in every phone format we accept", () => {
    for (const [code, , zone] of NEWLY_RESOLVED) {
      expect(phoneToTimezone(`+1${code}5550123`)).toBe(zone);
      expect(phoneToTimezone(`(${code}) 555-0123`)).toBe(zone);
      expect(phoneToTimezone(`1${code}5550123`)).toBe(zone);
    }
  });
});

describe("the two new codes that land in a split-timezone state", () => {
  // Twenty-seven of the 29 sit in a state with one zone, so the state default
  // is correct for them. These two do not, and taking the state default would
  // have introduced a WRONG timezone — which is worse than the missing one it
  // replaced, because a wrong zone silently succeeds.

  it("puts 448 on Central with the rest of the Florida panhandle", () => {
    // NANPA: 448 is OVERLAY_COMPLEX 448/850, PARENT_NPA_ID 850, TIME_ZONE EC.
    // 850 is Pensacola/Panama City and is already pinned to Central; Florida's
    // state default is Eastern, so 448 needs the same override 850 has.
    expect(stateFromPhone("4485550123")).toBe("FL");
    expect(phoneToTimezone("4485550123")).toBe("America/Chicago");
    expect(phoneToTimezone("4485550123")).toBe(phoneToTimezone("8505550123"));
    expect(phoneToTimezone("4485550123")).not.toBe(stateToTimezone("FL"));
  });

  it("puts 729 on Eastern with the rest of east Tennessee", () => {
    // NANPA: 729 is OVERLAY_COMPLEX 423/729, PARENT_NPA_ID 423, TIME_ZONE EC.
    // 423 is Chattanooga/Knoxville and is already pinned to Eastern;
    // Tennessee's state default is Central, so 729 needs 423's override.
    expect(stateFromPhone("7295550123")).toBe("TN");
    expect(phoneToTimezone("7295550123")).toBe("America/New_York");
    expect(phoneToTimezone("7295550123")).toBe(phoneToTimezone("4235550123"));
    expect(phoneToTimezone("7295550123")).not.toBe(stateToTimezone("TN"));
  });
});

describe("behaviour the single map must not change", () => {
  it("still overrides the split-state codes it always did", () => {
    expect(phoneToTimezone("9155550123")).toBe("America/Denver"); // El Paso
    expect(phoneToTimezone("8505550123")).toBe("America/Chicago"); // panhandle
    expect(phoneToTimezone("2705550123")).toBe("America/Chicago"); // west KY
    expect(phoneToTimezone("2195550123")).toBe("America/Chicago"); // NW Indiana
    expect(phoneToTimezone("4235550123")).toBe("America/New_York"); // east TN
  });

  it("keeps Canada out of the US state lookup but still zones it", () => {
    for (const codes of Object.values(PROVINCE_AREA_CODES)) {
      for (const code of codes) {
        expect(stateFromPhone(`${code}5550123`)).toBeNull();
      }
    }
    expect(phoneToTimezone("4165550123")).toBe("America/New_York"); // Toronto
    expect(phoneToTimezone("6045550123")).toBe("America/Los_Angeles"); // Vancouver
    expect(phoneToTimezone("3065550123")).toBe("America/Regina"); // Saskatchewan
    expect(phoneToTimezone("9025550123")).toBe("America/Halifax"); // Halifax
  });

  it("still resolves nothing for non-geographic and malformed numbers", () => {
    expect(stateFromPhone("8005550123")).toBeNull();
    expect(phoneToTimezone("8005550123")).toBeNull();
    expect(phoneToTimezone("9005550123")).toBeNull();
    expect(phoneToTimezone("555012")).toBeNull();
    expect(phoneToTimezone("")).toBeNull();
    expect(phoneToTimezone(null)).toBeNull();
  });

  it("still prefers an explicit state over the phone's area code", () => {
    expect(stateToTimezone("CA")).toBe("America/Los_Angeles");
    expect(stateToTimezone("california")).toBe("America/Los_Angeles");
    expect(stateToTimezone("Ontario")).toBe("America/New_York");
    expect(stateToTimezone("")).toBeNull();
  });
});
