import { describe, it, expect } from "vitest";

import {
  authorizeHumanDial,
  parseClientIdentity,
  rankHumanCallCampaigns,
} from "../src/lib/twilio/human-call-policy";

const ALICE = "0f6b1a2c-3d4e-4f50-8a61-72b3c4d5e6f7";
const BOB = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

/**
 * Twilio's `From=client:<identity>` is the only caller-related field the
 * browser cannot forge: identity is the user id mintVoiceToken put in the
 * access token. Everything else on the dial POST (leadId, userId, target) is
 * whatever device.connect() sent.
 */
describe("parseClientIdentity", () => {
  it("returns the user id behind a client: identity", () => {
    expect(parseClientIdentity(`client:${ALICE}`)).toBe(ALICE);
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseClientIdentity(`  client:${ALICE.toUpperCase()} `)).toBe(ALICE);
  });

  it("rejects a PSTN From, a bare id, and garbage", () => {
    expect(parseClientIdentity("+16505551234")).toBeNull();
    expect(parseClientIdentity(ALICE)).toBeNull();
    expect(parseClientIdentity("client:alice")).toBeNull();
    expect(parseClientIdentity(`client:${ALICE}; DROP`)).toBeNull();
  });

  it("rejects a missing From", () => {
    expect(parseClientIdentity(undefined)).toBeNull();
    expect(parseClientIdentity(null)).toBeNull();
    expect(parseClientIdentity("")).toBeNull();
  });
});

describe("authorizeHumanDial", () => {
  const member = { role: "member", active: true };
  const admin = { role: "admin", active: true };

  it("lets a member dial their own lead", () => {
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: member,
        leadOwnerId: ALICE,
      }),
    ).toEqual({ ok: true, isAdmin: false });
  });

  it("refuses a member dialing someone else's lead", () => {
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: member,
        leadOwnerId: BOB,
      }),
    ).toEqual({ ok: false, reason: "not_lead_owner" });
  });

  it("lets an admin dial any lead", () => {
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: admin,
        leadOwnerId: BOB,
      }),
    ).toEqual({ ok: true, isAdmin: true });
  });

  it("refuses when the browser's userId disagrees with Twilio's identity", () => {
    // Even for the lead's real owner: the row would be attributed to BOB.
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: BOB,
        caller: admin,
        leadOwnerId: ALICE,
      }),
    ).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  it("refuses a deactivated account, admin or not", () => {
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: { role: "admin", active: false },
        leadOwnerId: ALICE,
      }),
    ).toEqual({ ok: false, reason: "inactive_user" });
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: { role: "member", active: false },
        leadOwnerId: ALICE,
      }),
    ).toEqual({ ok: false, reason: "inactive_user" });
  });

  it("refuses an identity with no profile row", () => {
    expect(
      authorizeHumanDial({
        callerUserId: ALICE,
        claimedUserId: ALICE,
        caller: null,
        leadOwnerId: ALICE,
      }),
    ).toEqual({ ok: false, reason: "unknown_user" });
  });
});

describe("rankHumanCallCampaigns", () => {
  const campaigns = [
    { id: "c-bob", owner_id: BOB },
    { id: "c-alice-2", owner_id: ALICE },
    { id: "c-alice-1", owner_id: ALICE },
  ];

  it("a member only sees their own campaigns, owning campaign first", () => {
    expect(
      rankHumanCallCampaigns(campaigns, {
        userId: ALICE,
        isAdmin: false,
        preferredCampaignId: "c-alice-1",
      }).map((c) => c.id),
    ).toEqual(["c-alice-1", "c-alice-2"]);
  });

  it("an admin sees every campaign, owning campaign first", () => {
    expect(
      rankHumanCallCampaigns(campaigns, {
        userId: ALICE,
        isAdmin: true,
        preferredCampaignId: "c-bob",
      }).map((c) => c.id),
    ).toEqual(["c-bob", "c-alice-2", "c-alice-1"]);
  });

  it("a member never borrows a caller ID from the owning campaign if it isn't theirs", () => {
    expect(
      rankHumanCallCampaigns(campaigns, {
        userId: ALICE,
        isAdmin: false,
        preferredCampaignId: "c-bob",
      }).map((c) => c.id),
    ).toEqual(["c-alice-2", "c-alice-1"]);
  });

  it("keeps the given order when there is no owning campaign", () => {
    expect(
      rankHumanCallCampaigns(campaigns, {
        userId: BOB,
        isAdmin: true,
        preferredCampaignId: null,
      }).map((c) => c.id),
    ).toEqual(["c-bob", "c-alice-2", "c-alice-1"]);
  });
});
