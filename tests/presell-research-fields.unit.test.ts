import { describe, expect, it } from "vitest";

import {
  BASE_DATA_COLLECTION_IDS,
  normalizeDataCollection,
  toElevenLabsDataCollectionObject,
  CUSTOMER_ONLY_CLAUSE,
} from "@/lib/agents/data-collection";
import { isWarm, sentimentRank } from "@/lib/agent-analytics/field-detect";

// The seed script is the single source of truth for these definitions — this
// test asserts against exactly what gets written to the agent.
import { PRESELL_RESEARCH_FIELDS } from "../scripts/seed-presell-research-fields.mjs";

const fields = normalizeDataCollection(PRESELL_RESEARCH_FIELDS);
const stance = fields.find((f) => f.id === "ai_answering_stance")!;
const reason = fields.find((f) => f.id === "ai_answering_reason")!;

describe("presell research data-collection fields", () => {
  it("survives normalization intact (no base-id collision, nothing dropped)", () => {
    expect(fields).toHaveLength(2);
    for (const f of fields) {
      expect(BASE_DATA_COLLECTION_IDS.has(f.id)).toBe(false);
    }
    expect(stance).toBeDefined();
    expect(reason).toBeDefined();
  });

  it("neither field is named for a positive outcome", () => {
    // The whole point of the rename: a recorded "no" is a real answer, so the
    // field names must not imply interest. Guards against a future rename back.
    for (const f of fields) {
      expect(f.id).not.toMatch(/interest/);
    }
  });

  // Reporting auto-detects the sentiment field by its value set and matches on
  // these literal strings. If they drift, Voice of Customer loses its colours
  // and Hot Leads silently returns nothing.
  it("pins the stance values Reporting's sentiment lexicon recognizes", () => {
    expect(stance.enumValues).toEqual(["yes", "maybe", "no"]);
    for (const v of stance.enumValues) {
      expect(sentimentRank(v)).toBeLessThan(3);
    }
    expect(stance.enumValues.filter(isWarm)).toEqual(["yes", "maybe"]);
    // 2–6 distinct values is what detectCampaignFields looks for.
    expect(stance.enumValues.length).toBeGreaterThanOrEqual(2);
    expect(stance.enumValues.length).toBeLessThanOrEqual(6);
  });

  it("keeps the reason field free text so it reads as the notes field", () => {
    expect(reason.enumValues).toEqual([]);
    expect(reason.type).toBe("string");
  });

  it("tells the extractor a negative answer still gets recorded", () => {
    // Both descriptions have to say this explicitly — the failure mode we're
    // fixing is an extractor treating "no" as nothing worth writing down.
    expect(stance.description).toMatch(/never leave it blank/i);
    expect(reason.description).toMatch(
      /as valuable as a reason for saying yes/i,
    );
  });

  it("ships to ElevenLabs with the customer-only clause and the enum", () => {
    const out = toElevenLabsDataCollectionObject(fields);
    expect(out.ai_answering_stance.enum).toEqual(["yes", "maybe", "no"]);
    expect(out.ai_answering_reason.enum).toBeUndefined();
    for (const key of ["ai_answering_stance", "ai_answering_reason"] as const) {
      expect(out[key].description.endsWith(CUSTOMER_ONLY_CLAUSE)).toBe(true);
    }
  });
});
