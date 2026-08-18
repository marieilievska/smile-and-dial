const { test } = require("node:test");
const assert = require("node:assert");
const S = require("./_signals");

test("genuineHumanReplyCount: a machine greeting yields 0", () => {
  const t = [
    { role: "agent", message: "Hi, this is Tom calling for the owner." },
    { role: "user", message: "Please leave a message after the tone." },
  ];
  assert.equal(S.genuineHumanReplyCount(t), 0);
});

test("genuineHumanReplyCount: two short human replies yield 2", () => {
  const t = [
    { role: "agent", message: "Hi, is the owner in?" },
    { role: "user", message: "Speaking, who's this?" },
    { role: "agent", message: "It's Tom from the webinar team." },
    { role: "user", message: "No thanks, we're good." },
  ];
  assert.equal(S.genuineHumanReplyCount(t), 2);
});

test("agentOfferedRemoval: an agent offer to remove is detected", () => {
  const t = [
    { role: "agent", message: "No problem — want me to take you off our list?" },
    { role: "user", message: "Sure." },
  ];
  assert.equal(S.agentOfferedRemoval(t), true);
});

test("agentOfferedRemoval: a LEAD asking to stop is NOT an agent offer", () => {
  const t = [
    { role: "user", message: "Take me off your list and stop calling." },
    { role: "agent", message: "Understood, done." },
  ];
  assert.equal(S.agentOfferedRemoval(t), false);
});

test("normalizeTurns: ignores non-object / non-string-message turns", () => {
  assert.equal(S.normalizeTurns(null).length, 0);
  assert.equal(S.normalizeTurns([{ role: "user" }, "x", { role: "user", message: "hi" }]).length, 1);
});
