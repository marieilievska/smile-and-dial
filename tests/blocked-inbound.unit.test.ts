import { describe, expect, it } from "vitest";

import { resolveBlockedInbound } from "@/lib/elevenlabs/blocked-inbound";

import { makeFakeDb } from "./helpers/fake-supabase";

/**
 * Who gets hung up on before the agent ever answers.
 *
 * The rule has to be narrow in one direction and generous in the other: block
 * ONLY a caller the dialed number's own campaign owner has listed, and let
 * everything else through. DNC has been enforced per person since
 * 20260906020000, so a teammate's list must not silence this owner's callers.
 */
const OUR_NUMBER = "+15109837276";
const TROLL = "+15109258221";

function seed() {
  return makeFakeDb({
    twilio_numbers: [
      { id: "num1", phone_number: OUR_NUMBER, attached_campaign_id: "camp1" },
    ],
    campaigns: [{ id: "camp1", owner_id: "owner1", agent_id: "agentdb1" }],
    dnc_entries: [{ id: "d1", phone: TROLL, owner_id: "owner1" }],
  });
}

describe("resolveBlockedInbound", () => {
  it("blocks a caller on the dialed campaign owner's DNC list", async () => {
    const db = seed();

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: OUR_NUMBER,
        callerNumber: TROLL,
      }),
    ).toEqual({ blocked: true, campaignId: "camp1", ownerId: "owner1" });
  });

  it("does NOT block when the entry belongs to a different owner (DNC is per person)", async () => {
    const db = seed();
    db.tables.dnc_entries[0].owner_id = "someone-else";

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: OUR_NUMBER,
        callerNumber: TROLL,
      }),
    ).toEqual({ blocked: false });
  });

  it("does not block an ordinary caller", async () => {
    const db = seed();

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: OUR_NUMBER,
        callerNumber: "+15715550000",
      }),
    ).toEqual({ blocked: false });
  });

  it("does not block when the dialed number isn't ours", async () => {
    const db = seed();

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: "+12025550123",
        callerNumber: TROLL,
      }),
    ).toEqual({ blocked: false });
  });

  it("does not block when the number has no campaign attached", async () => {
    const db = seed();
    db.tables.twilio_numbers[0].attached_campaign_id = null;

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: OUR_NUMBER,
        callerNumber: TROLL,
      }),
    ).toEqual({ blocked: false });
  });

  it("does not block a withheld / empty caller id", async () => {
    const db = seed();

    expect(
      await resolveBlockedInbound(db.client, {
        agentNumber: OUR_NUMBER,
        callerNumber: "",
      }),
    ).toEqual({ blocked: false });
  });
});
