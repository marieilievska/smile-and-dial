// tests/lead-timezone-city.unit.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  cityToTimezone,
  leadTimezoneFrom,
  phoneToTimezone,
  stateToTimezone,
} from "../src/lib/leads/timezone";

/**
 * Idaho is a different failure from the ones #510 and #511 fixed. There the
 * area code COULD separate a state's two halves — 915 from 214, 850 from 305,
 * 423 from 615 — and the map simply had the wrong answer. Idaho has no such
 * code: 208 and its overlay 986 both cover the whole state, so no area-code
 * table can ever be right. Pinning Idaho to Mountain only minimises how many
 * people it is wrong about (~400,362 in the north against ~1.55M in the
 * south); it does not make anyone's calling window correct.
 *
 * The city does separate them, and imports already carry one. This is the
 * only signal we hold that can.
 */

const PACIFIC = "America/Los_Angeles";
const MOUNTAIN = "America/Denver";

describe("north Idaho resolves to Pacific by city", () => {
  // County of record for each city read off the Wikipedia city list and, for
  // the two the summary got wrong, the city's own article. Populations are
  // 2020 census. Every county here sits wholly north of the Salmon River, the
  // line 49 CFR 71.9(a) uses to split Idaho.
  const NORTH_IDAHO: [city: string, county: string][] = [
    ["Coeur d'Alene", "Kootenai"],
    ["Post Falls", "Kootenai"],
    ["Hayden", "Kootenai"],
    ["Rathdrum", "Kootenai"],
    ["Dalton Gardens", "Kootenai"],
    ["Spirit Lake", "Kootenai"],
    ["Hauser", "Kootenai"],
    ["Athol", "Kootenai"],
    ["Hayden Lake", "Kootenai"],
    ["Lewiston", "Nez Perce"],
    ["Lapwai", "Nez Perce"],
    ["Culdesac", "Nez Perce"],
    ["Moscow", "Latah"],
    ["Genesee", "Latah"],
    ["Troy", "Latah"],
    ["Potlatch", "Latah"],
    ["Juliaetta", "Latah"],
    ["Deary", "Latah"],
    ["Sandpoint", "Bonner"],
    ["Priest River", "Bonner"],
    ["Ponderay", "Bonner"],
    ["Kootenai", "Bonner"],
    ["Dover", "Bonner"],
    ["Clark Fork", "Bonner"],
    ["Bonners Ferry", "Boundary"],
    ["Moyie Springs", "Boundary"],
    ["St. Maries", "Benewah"],
    ["Plummer", "Benewah"],
    ["Kellogg", "Shoshone"],
    ["Pinehurst", "Shoshone"],
    ["Osburn", "Shoshone"],
    ["Wallace", "Shoshone"],
    ["Smelterville", "Shoshone"],
    ["Mullan", "Shoshone"],
    ["Orofino", "Clearwater"],
    ["Pierce", "Clearwater"],
    ["Weippe", "Clearwater"],
    ["Craigmont", "Lewis"],
    ["Nezperce", "Lewis"],
  ];

  it.each(NORTH_IDAHO)("%s (%s County) is Pacific", (city) => {
    expect(cityToTimezone(city, "ID")).toBe(PACIFIC);
  });

  it("overrides the Mountain answer the area code would have given", () => {
    // Both statewide codes still say Mountain on their own; the city is what
    // changes the outcome, which is the whole point of this table.
    expect(phoneToTimezone("2085550123")).toBe(MOUNTAIN);
    expect(phoneToTimezone("9865550123")).toBe(MOUNTAIN);
    expect(stateToTimezone("ID")).toBe(MOUNTAIN);
    expect(cityToTimezone("Coeur d'Alene", "ID")).not.toBe(
      stateToTimezone("ID"),
    );
  });
});

describe("south Idaho is left on Mountain", () => {
  it.each([
    ["Boise", 235684],
    ["Meridian", 117635],
    ["Nampa", 100200],
    ["Idaho Falls", 64818],
    ["Pocatello", 56320],
    ["Caldwell", 59996],
    ["Twin Falls", 51807],
  ])("%s is not claimed by the north-Idaho table", (city) => {
    expect(cityToTimezone(city, "ID")).toBeNull();
  });

  it("does NOT claim Shoshone, which is a southern city", () => {
    // The trap. The city of Shoshone is the seat of LINCOLN County in
    // south-central Idaho and observes Mountain time; it shares a name with
    // northern Shoshone County, and a list of "cities in Shoshone County" duly
    // reported it as northern. Listing it here would have moved a Magic Valley
    // lead an hour west — the silent kind of wrong, since it would still
    // produce a timezone and still look resolved.
    expect(cityToTimezone("Shoshone", "ID")).toBeNull();
  });

  it("does NOT claim Idaho County, which the Salmon River splits", () => {
    // 49 CFR 71.9(a) runs the Pacific boundary along the Idaho/Lemhi county
    // line and the Salmon River, so Idaho County is itself divided. Omitting
    // it costs nothing — an unlisted city just keeps today's Mountain answer.
    for (const city of [
      "Grangeville",
      "Riggins",
      "Cottonwood",
      "Ferdinand",
      "Stites",
      "White Bird",
      "Kamiah",
    ]) {
      expect(cityToTimezone(city, "ID")).toBeNull();
    }
  });
});

describe("the city table is deliberately narrow", () => {
  it("answers only for the states no area code can split", () => {
    // ID, NE, SD and ND have no second code on the far side of the line, so
    // the city is the only signal left. Every OTHER split state does have one
    // — 915 against 214, 850 against 305, 423 against 615 — and #511's
    // override table already reads it. Consulting a city there could only
    // fight a better signal, so the table stays silent.
    expect(cityToTimezone("El Paso", "TX")).toBeNull();
    expect(cityToTimezone("Pensacola", "FL")).toBeNull();
    expect(cityToTimezone("Knoxville", "TN")).toBeNull();
    expect(cityToTimezone("Gary", "IN")).toBeNull();
    expect(cityToTimezone("Bowling Green", "KY")).toBeNull();
    expect(cityToTimezone("Marquette", "MI")).toBeNull();
    // ...and it does answer for the four that need it.
    expect(cityToTimezone("Coeur d'Alene", "ID")).toBe(PACIFIC);
    expect(cityToTimezone("Rapid City", "SD")).toBe(MOUNTAIN);
    expect(cityToTimezone("Scottsbluff", "NE")).toBe(MOUNTAIN);
    expect(cityToTimezone("Dickinson", "ND")).toBe(MOUNTAIN);
  });

  it("returns null rather than guessing at an unknown Idaho city", () => {
    expect(cityToTimezone("Nowhereville", "ID")).toBeNull();
    expect(cityToTimezone("", "ID")).toBeNull();
    expect(cityToTimezone(null, "ID")).toBeNull();
    expect(cityToTimezone("Coeur d'Alene", null)).toBeNull();
    expect(cityToTimezone("Coeur d'Alene", "")).toBeNull();
  });
});

describe("city names arrive from free-text CSVs", () => {
  it("reads Coeur d'Alene however the punctuation lands", () => {
    for (const spelling of [
      "Coeur d'Alene",
      "Coeur D'Alene",
      "coeur d'alene",
      "Coeur d Alene",
      "Coeur dAlene",
      "CoeurdAlene",
      "  Coeur d'Alene  ",
      "Coeur d’Alene", // curly apostrophe, as Excel likes to produce
    ]) {
      expect(cityToTimezone(spelling, "ID")).toBe(PACIFIC);
    }
  });

  it("accepts St. Maries spelled out, and the state in either case", () => {
    expect(cityToTimezone("St. Maries", "ID")).toBe(PACIFIC);
    expect(cityToTimezone("St Maries", "ID")).toBe(PACIFIC);
    expect(cityToTimezone("Saint Maries", "ID")).toBe(PACIFIC);
    expect(cityToTimezone("Coeur d'Alene", "id")).toBe(PACIFIC);
    expect(cityToTimezone("Coeur d'Alene", "Idaho")).toBe(PACIFIC);
  });
});

describe("leadTimezoneFrom — the resolution an import actually runs", () => {
  // Extracted from import-actions.ts so the precedence is testable at all; it
  // had no coverage before. Order is most-specific-first: the city, where it
  // is the only thing that can split the state; then the phone, whose area
  // code carries the split-state overrides; then the state on its own.

  it("uses the city when Idaho gives one", () => {
    expect(
      leadTimezoneFrom({
        city: "Coeur d'Alene",
        state: "ID",
        phone: "2085550123",
      }),
    ).toBe(PACIFIC);
  });

  it("leaves southern Idaho on Mountain", () => {
    expect(
      leadTimezoneFrom({ city: "Boise", state: "ID", phone: "2085550123" }),
    ).toBe(MOUNTAIN);
  });

  it("still reaches the city when the state came from the phone", () => {
    // A CSV with a city column but no state column: the area code gives us ID,
    // and the city then splits it. Both halves of the old branch benefit.
    expect(
      leadTimezoneFrom({ city: "Sandpoint", state: null, phone: "9865550123" }),
    ).toBe(PACIFIC);
  });

  it("keeps every pre-existing resolution unchanged", () => {
    // No city, or a city in a state the table does not cover, must behave
    // exactly as it did before this function existed.
    expect(leadTimezoneFrom({ city: null, state: "CA", phone: null })).toBe(
      "America/Los_Angeles",
    );
    expect(
      leadTimezoneFrom({ city: "Buffalo", state: "NY", phone: null }),
    ).toBe("America/New_York");
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: "9155550123" }),
    ).toBe("America/Denver"); // El Paso, via the area-code override
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: "4165550123" }),
    ).toBe("America/New_York"); // Toronto, via the Canadian table
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: null }),
    ).toBeNull();
    expect(
      leadTimezoneFrom({ city: null, state: null, phone: "8005550123" }),
    ).toBeNull(); // toll-free has no geography
  });

  it("still prefers an explicit state over the phone's area code", () => {
    // Unchanged, and deliberately so: people keep numbers when they move, so a
    // stated address beats an area code. (See the note in the PR about the
    // split-state overrides this skips — a separate problem, not this one.)
    expect(
      leadTimezoneFrom({ city: null, state: "NY", phone: "2135550123" }),
    ).toBe("America/New_York");
  });
});

describe("the import actually uses it", () => {
  // A pure function nothing calls fixes nothing. import-actions.ts is a
  // "use server" module with Supabase at the top, so this checks the wiring at
  // the source level rather than mocking a database to prove one assignment.
  const importSrc = readFileSync("src/lib/leads/import-actions.ts", "utf8");

  it("resolves the timezone through leadTimezoneFrom", () => {
    expect(importSrc).toMatch(/leadTimezoneFrom\s*\(/);
  });

  it("passes the city, or the city table can never fire", () => {
    const call = importSrc.slice(
      importSrc.indexOf("leadTimezoneFrom({"),
      importSrc.indexOf("leadTimezoneFrom({") + 220,
    );
    expect(call).toMatch(/city:/);
    expect(call).toMatch(/state:/);
    expect(call).toMatch(/phone:/);
  });

  it("no longer derives the zone inline", () => {
    // The old branch called stateToTimezone/phoneToTimezone directly. If
    // either is imported here again the precedence has two homes and they will
    // drift, which is the exact failure #510 spent a PR undoing. Checking the
    // import list rather than the call site, so this cannot pass vacuously on
    // a reformat. stateFromPhone stays — it still backfills the state column.
    const imports = [...importSrc.matchAll(/^import[\s\S]*?from\s+"[^"]+";$/gm)]
      .map((m) => m[0])
      .join("\n");
    expect(imports).toContain("leadTimezoneFrom");
    expect(imports).toContain("stateFromPhone");
    expect(imports).not.toContain("stateToTimezone");
    expect(imports).not.toContain("phoneToTimezone");
  });

  it("passes the CSV's own state, not the one backfilled from the phone", () => {
    // The trap in this wiring. The old code backfilled fields.state from the
    // area code and THEN resolved; doing that here would make every state look
    // explicit, so leadTimezoneFrom would take the state default and the
    // split-state overrides (915 El Paso, 850 panhandle) would stop firing for
    // exactly the leads they were written for.
    const resolveAt = importSrc.indexOf("leadTimezoneFrom({");
    const backfillAt = importSrc.indexOf("stateFromPhone(");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(backfillAt);
  });
});

// --- The same defect in SD, ND and NE ---------------------------------------
// 605, 701 and 308 are statewide-ish codes spanning two zones, exactly like
// Idaho's. All three states default to CENTRAL, so unlike Idaho these tables
// list the MOUNTAIN minority — but the additive-safety property is identical:
// an unlisted city keeps the Central default, which is today's behaviour.
//
// Boundaries are 49 CFR 71.7; counties come from that text (plus, for North
// Dakota, the explicit list of wholly-mountain counties) and cities from each
// state's Wikipedia city list filtered to those counties.

describe("western Nebraska resolves to Mountain by city", () => {
  // 49 CFR 71.7(c) runs the line along the west boundaries of Thomas,
  // McPherson, Keith, Lincoln, Hayes and Hitchcock, leaving the eighteen
  // counties beyond it on Mountain. Three were checked against their own
  // infoboxes because the regulation's path reads least clearly there:
  // Ogallala (Keith), Imperial (Chase) and Mullen (Hooker) are all Mountain.
  const WESTERN_NEBRASKA: [city: string, county: string][] = [
    ["Scottsbluff", "Scotts Bluff"],
    ["Gering", "Scotts Bluff"],
    ["Mitchell", "Scotts Bluff"],
    ["Terrytown", "Scotts Bluff"],
    ["Minatare", "Scotts Bluff"],
    ["Morrill", "Scotts Bluff"],
    ["Lyman", "Scotts Bluff"],
    ["Henry", "Scotts Bluff"],
    ["Melbeta", "Scotts Bluff"],
    ["Alliance", "Box Butte"],
    ["Hemingford", "Box Butte"],
    ["Chadron", "Dawes"],
    ["Crawford", "Dawes"],
    ["Gordon", "Sheridan"],
    ["Rushville", "Sheridan"],
    ["Harrison", "Sioux"],
    ["Bridgeport", "Morrill"],
    ["Bayard", "Morrill"],
    ["Oshkosh", "Garden"],
    ["Lewellen", "Garden"],
    ["Hyannis", "Grant"],
    ["Mullen", "Hooker"],
    ["Arthur", "Arthur"],
    ["Kimball", "Kimball"],
    ["Dix", "Kimball"],
    ["Bushnell", "Kimball"],
    ["Sidney", "Cheyenne"],
    ["Potter", "Cheyenne"],
    ["Lodgepole", "Cheyenne"],
    ["Dalton", "Cheyenne"],
    ["Gurley", "Cheyenne"],
    ["Chappell", "Deuel"],
    ["Big Springs", "Deuel"],
    ["Ogallala", "Keith"],
    ["Paxton", "Keith"],
    ["Brule", "Keith"],
    ["Grant", "Perkins"],
    ["Madrid", "Perkins"],
    ["Venango", "Perkins"],
    ["Imperial", "Chase"],
    ["Wauneta", "Chase"],
    ["Benkelman", "Dundy"],
    ["Haigler", "Dundy"],
  ];

  it.each(WESTERN_NEBRASKA)("%s (%s County) is Mountain", (city) => {
    expect(cityToTimezone(city, "NE")).toBe(MOUNTAIN);
  });

  it("leaves central and eastern Nebraska on Central", () => {
    for (const city of [
      "Omaha",
      "Lincoln",
      "Grand Island",
      "Kearney",
      "Hastings",
      "North Platte", // Lincoln County — the line runs along its WEST edge
      "Columbus",
      "Norfolk",
      "McCook",
      "Lexington",
    ]) {
      expect(cityToTimezone(city, "NE")).toBeNull();
    }
  });
});

describe("west-river South Dakota resolves to Mountain by city", () => {
  // 49 CFR 71.7(b) follows the Missouri's main channel south to Pierre, then
  // runs along the west boundaries of Jones, Mellette and Todd — so those
  // three, and everything east of the river, stay Central.
  const WEST_RIVER: [city: string, county: string][] = [
    ["Rapid City", "Pennington"],
    ["Hill City", "Pennington"],
    ["Wall", "Pennington"],
    ["Keystone", "Pennington"],
    ["New Underwood", "Pennington"],
    ["Quinn", "Pennington"],
    ["Wasta", "Pennington"],
    ["Spearfish", "Lawrence"],
    ["Lead", "Lawrence"],
    ["Deadwood", "Lawrence"],
    ["Whitewood", "Lawrence"],
    ["Central City", "Lawrence"],
    ["Box Elder", "Meade"],
    ["Sturgis", "Meade"],
    ["Summerset", "Meade"],
    ["Piedmont", "Meade"],
    ["Faith", "Meade"],
    ["Belle Fourche", "Butte"],
    ["Newell", "Butte"],
    ["Nisland", "Butte"],
    ["Hot Springs", "Fall River"],
    ["Edgemont", "Fall River"],
    ["Oelrichs", "Fall River"],
    ["Custer", "Custer"],
    ["Hermosa", "Custer"],
    ["Pringle", "Custer"],
    ["Buffalo Gap", "Custer"],
    ["Fairburn", "Custer"],
    ["Philip", "Haakon"],
    ["Midland", "Haakon"],
    ["Buffalo", "Harding"],
    ["Camp Crook", "Harding"],
    ["Kadoka", "Jackson"],
    ["Interior", "Jackson"],
    ["Belvidere", "Jackson"],
    ["Lemmon", "Perkins"],
    ["Bison", "Perkins"],
    ["Eagle Butte", "Dewey"],
    ["Timber Lake", "Dewey"],
    ["Isabel", "Dewey"],
    ["Dupree", "Ziebach"],
    ["McLaughlin", "Corson"],
    ["McIntosh", "Corson"],
    ["Morristown", "Corson"],
  ];

  it.each(WEST_RIVER)("%s (%s County) is Mountain", (city) => {
    expect(cityToTimezone(city, "SD")).toBe(MOUNTAIN);
  });

  it("does NOT claim Fort Pierre, whose residents keep Central", () => {
    // De jure Mountain (Stanley County, west bank), but its own article says
    // "most residents of the city use Central Time because of close social and
    // economic ties with Pierre". Calling hours care about the clock people
    // actually keep, and omitting it yields Central — both safer and truer.
    expect(cityToTimezone("Fort Pierre", "SD")).toBeNull();
    expect(cityToTimezone("Pierre", "SD")).toBeNull();
  });

  it("leaves east-river South Dakota on Central", () => {
    for (const city of [
      "Sioux Falls",
      "Aberdeen",
      "Brookings",
      "Watertown",
      "Mitchell", // Davison County — the Nebraska city of this name IS Mountain
      "Yankton",
      "Huron",
      "Vermillion",
      "Mobridge", // Walworth County, east bank
      "Chamberlain",
      "Winner",
    ]) {
      expect(cityToTimezone(city, "SD")).toBeNull();
    }
  });
});

describe("southwest North Dakota resolves to Mountain by city", () => {
  // The eight counties lying wholly in the mountain zone. McKenzie, Dunn and
  // Sioux are SPLIT, and 49 CFR 71.7(a) draws the line through Mercer and
  // Morton, so all five are left out rather than guessed at.
  const SOUTHWEST_ND: [city: string, county: string][] = [
    ["Dickinson", "Stark"],
    ["Belfield", "Stark"],
    ["Richardton", "Stark"],
    ["Gladstone", "Stark"],
    ["South Heart", "Stark"],
    ["Taylor", "Stark"],
    ["Bowman", "Bowman"],
    ["Scranton", "Bowman"],
    ["Rhame", "Bowman"],
    ["Gascoyne", "Bowman"],
    ["Hettinger", "Adams"], // the CITY is in Adams; Hettinger is a county too
    ["Reeder", "Adams"],
    ["Haynes", "Adams"],
    ["Bucyrus", "Adams"],
    ["New England", "Hettinger"],
    ["Mott", "Hettinger"],
    ["Regent", "Hettinger"],
    ["Beach", "Golden Valley"],
    ["Golva", "Golden Valley"],
    ["Sentinel Butte", "Golden Valley"],
    ["Elgin", "Grant"],
    ["Carson", "Grant"],
    ["New Leipzig", "Grant"],
    ["Leith", "Grant"],
    ["Medora", "Billings"],
    ["Marmarth", "Slope"],
    ["Amidon", "Slope"],
  ];

  it.each(SOUTHWEST_ND)("%s (%s County) is Mountain", (city) => {
    expect(cityToTimezone(city, "ND")).toBe(MOUNTAIN);
  });

  it("leaves the rest of North Dakota, split counties included, on Central", () => {
    for (const city of [
      "Fargo",
      "Bismarck",
      "Grand Forks",
      "Minot",
      "Williston", // Williams County — western, but Central
      "Jamestown",
      "Mandan", // Morton — the boundary runs through it
      "Killdeer", // Dunn — split
      "Watford City", // McKenzie — split
      "Fort Yates", // Sioux — split
      "Beulah", // Mercer — the boundary runs through it
    ]) {
      expect(cityToTimezone(city, "ND")).toBeNull();
    }
  });
});

describe("the three new states behave the way Idaho does", () => {
  it("beats the area code, which says Central for all three", () => {
    expect(phoneToTimezone("6055550123")).toBe("America/Chicago"); // SD
    expect(phoneToTimezone("7015550123")).toBe("America/Chicago"); // ND
    expect(phoneToTimezone("3085550123")).toBe("America/Chicago"); // NE
    expect(
      leadTimezoneFrom({
        city: "Rapid City",
        state: "SD",
        phone: "6055550123",
      }),
    ).toBe(MOUNTAIN);
    expect(
      leadTimezoneFrom({ city: "Dickinson", state: "ND", phone: "7015550123" }),
    ).toBe(MOUNTAIN);
    expect(
      leadTimezoneFrom({
        city: "Scottsbluff",
        state: "NE",
        phone: "3085550123",
      }),
    ).toBe(MOUNTAIN);
  });

  it("still reaches the city when the state came from the phone", () => {
    expect(
      leadTimezoneFrom({
        city: "Rapid City",
        state: null,
        phone: "6055550123",
      }),
    ).toBe(MOUNTAIN);
  });

  it("leaves an unlisted city on the state default, as before", () => {
    expect(
      leadTimezoneFrom({
        city: "Sioux Falls",
        state: "SD",
        phone: "6055550123",
      }),
    ).toBe("America/Chicago");
    expect(
      leadTimezoneFrom({ city: "Fargo", state: "ND", phone: "7015550123" }),
    ).toBe("America/Chicago");
    expect(
      leadTimezoneFrom({ city: "Kearney", state: "NE", phone: "3085550123" }),
    ).toBe("America/Chicago");
  });

  it("never lets one state's city table answer for another", () => {
    // Mitchell is Mountain in Nebraska (Scotts Bluff) and Central in South
    // Dakota (Davison). Keying by state is what keeps those apart.
    expect(cityToTimezone("Mitchell", "NE")).toBe(MOUNTAIN);
    expect(cityToTimezone("Mitchell", "SD")).toBeNull();
    expect(cityToTimezone("Rapid City", "NE")).toBeNull();
    expect(cityToTimezone("Dickinson", "SD")).toBeNull();
    expect(cityToTimezone("Coeur d'Alene", "SD")).toBeNull();
  });
});
