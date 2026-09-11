const { test } = require("node:test");
const assert = require("node:assert");
const F = require("./_flags");

test("not_interested with dm=no is flagged and suggests gatekeeper_not_interested", () => {
  const f = F.structuralFlags({ outcome: "not_interested", extracted: { decision_maker_reached: "no" }, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.length, 1);
  assert.equal(f[0].type, "not_interested_dm_not_yes");
  assert.equal(f[0].suggest, "gatekeeper_not_interested");
});

test("not_interested with dm=unknown is flagged", () => {
  const f = F.structuralFlags({ outcome: "not_interested", extracted: { decision_maker_reached: "unknown" }, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.some((x) => x.type === "not_interested_dm_not_yes"), true);
});

test("not_interested with dm=yes is NOT flagged", () => {
  const f = F.structuralFlags({ outcome: "not_interested", extracted: { decision_maker_reached: "yes" }, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.length, 0);
});

test("gatekeeper_not_interested with dm=yes is flagged", () => {
  const f = F.structuralFlags({ outcome: "gatekeeper_not_interested", extracted: { decision_maker_reached: "yes" }, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.some((x) => x.type === "gni_dm_yes"), true);
});

test("goal_met without a booking is flagged", () => {
  const f = F.structuralFlags({ outcome: "goal_met", extracted: {}, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.some((x) => x.type === "goal_met_no_booking"), true);
});

test("goal_met WITH a booking is NOT flagged", () => {
  const f = F.structuralFlags({ outcome: "goal_met", extracted: {}, leadHasBooking: true, hasCallbackRow: false, status: "completed" });
  assert.equal(f.length, 0);
});

test("callback with no time and no callbacks row is flagged", () => {
  const f = F.structuralFlags({ outcome: "callback", extracted: { callback_datetime: null }, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.some((x) => x.type === "callback_no_time"), true);
});

test("callback WITH a callbacks row is NOT flagged", () => {
  const f = F.structuralFlags({ outcome: "callback", extracted: { callback_datetime: null }, leadHasBooking: false, hasCallbackRow: true, status: "completed" });
  assert.equal(f.length, 0);
});

test("null outcome on a completed call is flagged", () => {
  const f = F.structuralFlags({ outcome: null, extracted: {}, leadHasBooking: false, hasCallbackRow: false, status: "completed" });
  assert.equal(f.some((x) => x.type === "null_outcome"), true);
});

test("transcriptFlags: dnc with an agent removal offer is flagged", () => {
  const t = [{ role: "agent", message: "Want me to take you off our list?" }];
  const f = F.transcriptFlags({ outcome: "dnc", transcript: t });
  assert.equal(f.some((x) => x.type === "dnc_agent_offer"), true);
});

test("a dnc_entries row on a NON-dnc call is flagged (LGNDS, 2026-09-10)", () => {
  const f = F.structuralFlags({ outcome: "ai_receptionist", extracted: null, leadHasBooking: false, hasCallbackRow: false, status: "completed", hasDncEntry: true });
  assert.equal(f.some((x) => x.type === "dnc_entry_not_dnc"), true);
});

test("a dnc_entries row on a dnc-family call is NOT flagged", () => {
  for (const outcome of ["dnc", "invalid_number", "language_barrier"]) {
    const f = F.structuralFlags({ outcome, extracted: null, leadHasBooking: false, hasCallbackRow: false, status: "completed", hasDncEntry: true });
    assert.equal(f.some((x) => x.type === "dnc_entry_not_dnc"), false, outcome);
  }
});

test("a callback scheduled before it was created is flagged (Divine Warrior, 2026-09-11)", () => {
  const f = F.structuralFlags({ outcome: "callback", extracted: { callback_datetime: "2026-09-11T11:57:00Z" }, leadHasBooking: false, hasCallbackRow: true, status: "completed", callbackScheduledInPast: true });
  assert.equal(f.some((x) => x.type === "callback_in_past"), true);
});

test("an ordinary future callback is NOT flagged", () => {
  const f = F.structuralFlags({ outcome: "callback", extracted: { callback_datetime: "2026-09-14T16:30:00Z" }, leadHasBooking: false, hasCallbackRow: true, status: "completed", callbackScheduledInPast: false });
  assert.equal(f.length, 0);
});

test("transcriptFlags: an agent removal offer on a NON-dnc call is flagged", () => {
  const t = [
    { role: "user", message: "This is creepy." },
    { role: "agent", message: "If you want, I can just make sure we stop reaching out to this number." },
  ];
  const f = F.transcriptFlags({ outcome: "not_interested", transcript: t });
  assert.equal(f.some((x) => x.type === "agent_offer_not_dnc"), true);
  assert.equal(f.some((x) => x.type === "dnc_agent_offer"), false);
});

test("transcriptFlags: voicemail with >=2 human replies is flagged", () => {
  const t = [
    { role: "agent", message: "Hi, is the owner in?" },
    { role: "user", message: "Speaking, who is this?" },
    { role: "agent", message: "Tom from the team." },
    { role: "user", message: "Not interested, thanks." },
  ];
  const f = F.transcriptFlags({ outcome: "voicemail", transcript: t });
  assert.equal(f.some((x) => x.type === "voicemail_has_human"), true);
});
