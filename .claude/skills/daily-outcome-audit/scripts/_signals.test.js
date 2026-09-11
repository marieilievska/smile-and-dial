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

test("agentOfferedRemoval: an agent CONFIRMING after the lead asked is NOT an offer (2026-09-02 false alarm)", () => {
  const t = [
    { role: "agent", message: "You wouldn't happen to be the owner, would ya?" },
    { role: "user", message: "No, we're not interested. Thank you. You can take us off your list." },
    { role: "agent", message: "Totally understood, and I've got you taken off the list. Have a good one." },
  ];
  assert.equal(S.agentOfferedRemoval(t), false);
});

test("agentOfferedRemoval: an agent offer BEFORE the lead asks still counts", () => {
  const t = [
    { role: "agent", message: "Want me to take you off our list?" },
    { role: "user", message: "Yeah, take us off." },
    { role: "agent", message: "Done, you're off the list." },
  ];
  assert.equal(S.agentOfferedRemoval(t), true);
});

// 2026-09-10: the Daily HireAI Webinar agent's own offer phrasings — verbatim
// agent lines from the 10 calls where it raised removal first. The old pattern
// caught none of these directly.
test("agentOfferedRemoval: catches the 2026-09-10 agent's offer phrasings", () => {
  const offers = [
    "If you want, I can make sure this number doesn’t get called again.",
    "I’ll let you get back to it. If you want, I can make sure we don’t bug you again.",
    "Understood. If you’d like, I can make sure we don’t reach out again.",
    "If it’s not a fit right now, I won’t push it. If you’d like, I can make sure we don’t keep reaching out about it.",
    "If it’s not a fit, no worries at all. If you do want me to stop reaching out, just let me know.",
    "Since you’re not the owner there anymore, would you want me to stop callin’ this number about that old gym?",
    "Thanks for letting me know—would you like me to make sure we don’t call this number again?",
    "Yep. Alright, totally hear you. I’ve got you removed so you won’t be contacted again.",
  ];
  for (const message of offers) {
    const t = [
      { role: "user", message: "Um, I’m not interested, but I appreciate you offering." },
      { role: "agent", message },
      { role: "user", message: "Yes, please." },
    ];
    assert.equal(S.agentOfferedRemoval(t), true, message);
  }
});

test("agentOfferedRemoval: catches 'so we don't keep bugging you' (2026-09-11)", () => {
  // Verbatim: Divine Warrior Ninjutsu, after the lead said we'd called 3 times.
  // "(bug|bother)(ing)?" missed "bugging" — the double g.
  const t = [
    { role: "user", message: "It has not been 20 minutes. You just called me three times in a row." },
    { role: "agent", message: "that’s totally on us and I’m sorry about that. I can back off here—if you want, I can just mark this number so we don’t keep bugging you. Would you like me to do that?" },
    { role: "user", message: "Yeah, do that. Don't call." },
  ];
  assert.equal(S.agentOfferedRemoval(t), true);
});

test("agentOfferedRemoval: a curly-apostrophe confirmation after 'erase our number' is NOT an offer", () => {
  // Verbatim: Arrichion Hot Yoga, 2026-09-10 — a real self-request.
  const t = [
    { role: "user", message: "I don't want anything to do with AI, honestly. So you can just erase our number from your, uh, Rolodex there, my little computerized friend." },
    { role: "agent", message: "All good, I’ve removed you from the list and you won’t be contacted again. Take care." },
  ];
  assert.equal(S.agentOfferedRemoval(t), false);
});

test("agentOfferedRemoval: an ordinary decline with no removal talk is NOT an offer", () => {
  const t = [
    { role: "agent", message: "Would you be totally against me savin’ you a seat?" },
    { role: "user", message: "No, thank you." },
    { role: "agent", message: "Totally fair, I appreciate it. Have a good one." },
  ];
  assert.equal(S.agentOfferedRemoval(t), false);
});

test("normalizeTurns: ignores non-object / non-string-message turns", () => {
  assert.equal(S.normalizeTurns(null).length, 0);
  assert.equal(S.normalizeTurns([{ role: "user" }, "x", { role: "user", message: "hi" }]).length, 1);
});
