import { test, expect } from "vitest";

import {
  MIN_LEAD_WORDS,
  applyNameRules,
  buildNote,
  countLeadWords,
  parseKnown,
  parseStatus,
  renderNote,
  resolveNames,
} from "../src/lib/openai/summary-note";

/**
 * The rolling call note's untrusted-output rules (see
 * docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md).
 *
 * These are the tests that make the name rule real. The prompt asks the model
 * not to invent names; prototyping against production transcripts showed the
 * same prompt on the same input leaking an unverified name on one run and not
 * the next, so the guarantee lives here instead.
 */

// ---------------------------------------------------------------- lead words

test("countLeadWords counts only what the LEAD said", () => {
  const transcript = [
    "Agent: Hi there, is the owner around today by any chance?",
    "Lead: No she's not, she's in tomorrow.",
    "Agent: Got it, thanks very much for your help.",
    "Lead: Sure thing.",
  ].join("\n");
  // "No she's not, she's in tomorrow." = 6, "Sure thing." = 2
  expect(countLeadWords(transcript)).toBe(8);
});

test("countLeadWords is 0 for an agent-only transcript", () => {
  expect(countLeadWords("Agent: Hello?\nAgent: Anyone there?")).toBe(0);
});

test("countLeadWords tolerates empty input", () => {
  expect(countLeadWords("")).toBe(0);
});

test("MIN_LEAD_WORDS is the measured threshold", () => {
  expect(MIN_LEAD_WORDS).toBe(15);
});

// ------------------------------------------------------------ name evidence

const RHAPSODY = [
  "Agent: Hi, is the owner around?",
  "Lead: Thank you for calling Rhapsody. This is Paula. Can I help you?",
  "Agent: Who's the owner there?",
  "Lead: Amanda, Amanda Ziegler.",
].join("\n");

test("a name with a real transcript quote is accepted, first name only", () => {
  const r = resolveNames(
    [{ name: "Amanda Ziegler", evidence: "Lead: Amanda, Amanda Ziegler." }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.rejected).toEqual([]);
  expect(r.allowed.has("amanda")).toBe(true);
  expect(r.allowed.has("ziegler")).toBe(false);
  expect(r.shorten).toEqual([{ from: "amanda ziegler", to: "amanda" }]);
});

test("a name whose quote is not in the transcript is rejected", () => {
  const r = resolveNames(
    [{ name: "Nadia", evidence: "Lead: You can speak to Nadia." }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("nadia")).toBe(false);
  expect(r.rejected[0].reason).toBe("quote not found in what the lead said");
});

test("our own agent's name is rejected even though it IS in the transcript", () => {
  // Observed against a real call: the agent opens with "my name's Jack", so the
  // quote is genuine — it just isn't someone who works at the business. Only
  // what the LEAD said can identify a contact there.
  const transcript = [
    "Agent: Hi there, my name's Jack, I'm calling out of the blue here.",
    "Lead: Okay, what's this about?",
  ].join("\n");
  const r = resolveNames(
    [
      {
        name: "Jack",
        evidence:
          "Agent: Hi there, my name's Jack, I'm calling out of the blue here.",
      },
    ],
    { transcript, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("jack")).toBe(false);
  expect(r.rejected[0].reason).toBe("quote not found in what the lead said");
});

test("evidence still matches when the model omits the speaker prefix", () => {
  const r = resolveNames(
    [{ name: "Amanda Ziegler", evidence: "Amanda, Amanda Ziegler." }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("amanda")).toBe(true);
});

test("a quote that does not contain the name is rejected", () => {
  const r = resolveNames(
    [{ name: "Nicole", evidence: "Lead: Thank you for calling Rhapsody." }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("nicole")).toBe(false);
  expect(r.rejected[0].reason).toBe("quote does not contain the name");
});

test("a name lifted from the business name is rejected (the Piggy case)", () => {
  const transcript = "Lead: Thanks for calling Piggy, how can I help?";
  const r = resolveNames(
    [
      {
        name: "Piggy",
        evidence: "Lead: Thanks for calling Piggy, how can I help?",
      },
    ],
    { transcript, company: "Piggy Wiggly Grooming", contacts: [] },
  );
  expect(r.allowed.has("piggy")).toBe(false);
  expect(r.rejected[0].reason).toBe("name is a word from the business name");
});

test("names on the lead record need no evidence and are also shortened", () => {
  const r = resolveNames([], {
    transcript: "",
    company: "Palace Spa",
    contacts: ["Michelle", "Rebecca Salcedo"],
  });
  expect(r.allowed.has("michelle")).toBe(true);
  expect(r.allowed.has("rebecca")).toBe(true);
  expect(r.allowed.has("salcedo")).toBe(false);
  expect(r.shorten).toEqual([{ from: "rebecca salcedo", to: "rebecca" }]);
});

test("matching ignores case and punctuation", () => {
  const r = resolveNames(
    [{ name: "amanda ziegler", evidence: "LEAD:  AMANDA — amanda ZIEGLER!!!" }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("amanda")).toBe(true);
});

// ------------------------------------------------ shortening + line dropping

const ALLOW = (
  names: string[],
  shorten: { from: string; to: string }[] = [],
) => ({
  allowed: new Set(names),
  shorten,
});

test("an accepted full name is shortened to its first name", () => {
  const r = ALLOW(["amanda"], [{ from: "amanda ziegler", to: "amanda" }]);
  expect(applyNameRules("Owner is Amanda Ziegler.", r)).toBe(
    "Owner is Amanda.",
  );
});

test("shortening preserves the leading capital", () => {
  const r = ALLOW(["amanda"], [{ from: "amanda ziegler", to: "amanda" }]);
  expect(applyNameRules("Callback set with Amanda Ziegler.", r)).toBe(
    "Callback set with Amanda.",
  );
});

test("a line naming someone unverified is dropped entirely", () => {
  expect(applyNameRules("They said the owner is Nicole.", ALLOW([]))).toBe("");
});

test("a stranded surname drops its line", () => {
  expect(applyNameRules("Owner asked for Ziegler.", ALLOW(["amanda"]))).toBe(
    "",
  );
});

test("an allowed name survives", () => {
  expect(
    applyNameRules("Staff Paula answered the phone.", ALLOW(["paula"])),
  ).toBe("Staff Paula answered the phone.");
});

test("non-name capitalised words are not treated as names", () => {
  const r = ALLOW([]);
  expect(applyNameRules("Owner is usually in on Wednesdays.", r)).toBe(
    "Owner is usually in on Wednesdays.",
  );
  expect(applyNameRules("They use Vagaro for booking.", r)).toBe(
    "They use Vagaro for booking.",
  );
  expect(applyNameRules("They do not answer the phone after closing.", r)).toBe(
    "They do not answer the phone after closing.",
  );
});

test("formatting noise is stripped", () => {
  expect(applyNameRules("  • - Open at 9:30", ALLOW([]))).toBe("Open at 9:30");
  expect(applyNameRules("• • First call to this business.", ALLOW([]))).toBe(
    "First call to this business.",
  );
});

test("an empty or blank line yields an empty string", () => {
  expect(applyNameRules("", ALLOW([]))).toBe("");
  expect(applyNameRules("   •  ", ALLOW([]))).toBe("");
});

// ------------------------------------------------- render / parse / compose

test("renderNote lays out status, pickup line and bullets", () => {
  expect(
    renderNote({
      status: "Interested, callback booked",
      leftOff: "Callback set with Amanda for Wednesday morning.",
      known: ["Owner is usually here on Wednesdays.", "Open at 9:30."],
      callbackNotes: "",
    }),
  ).toBe(
    [
      "Status: Interested, callback booked",
      "Left off: Callback set with Amanda for Wednesday morning.",
      "Known — don't re-ask:",
      "  • Owner is usually here on Wednesdays.",
      "  • Open at 9:30.",
    ].join("\n"),
  );
});

test("renderNote omits empty sections", () => {
  expect(
    renderNote({
      status: "Never got past the front desk",
      leftOff: "",
      known: [],
      callbackNotes: "",
    }),
  ).toBe("Status: Never got past the front desk");
});

test("parseKnown and parseStatus round-trip a rendered note", () => {
  const text = renderNote({
    status: "Not interested",
    leftOff: "",
    known: ["They prefer handling calls themselves.", "Open at 9:30."],
    callbackNotes: "",
  });
  expect(parseStatus(text)).toBe("Not interested");
  expect(parseKnown(text)).toEqual([
    "They prefer handling calls themselves.",
    "Open at 9:30.",
  ]);
});

test("parsing a legacy prose note yields no status and no bullets", () => {
  const legacy =
    "We reached an unnamed person who was not the owner. Already answered — don't re-ask: nothing yet.";
  expect(parseStatus(legacy)).toBe("");
  expect(parseKnown(legacy)).toEqual([]);
});

test("buildNote applies the name rules across every field", () => {
  const result = buildNote(
    {
      status: "Interested, callback booked",
      leftOff: "Callback set with Amanda Ziegler for Wednesday.",
      known: ["Owner is Amanda Ziegler.", "They said the owner is Nicole."],
      callbackNotes: "Call Amanda Ziegler back Wednesday morning.",
      names: [
        { name: "Amanda Ziegler", evidence: "Lead: Amanda, Amanda Ziegler." },
      ],
    },
    {
      transcript: "Lead: Amanda, Amanda Ziegler.",
      company: "Rhapsody Salon",
      contacts: [],
    },
    { previousStatus: "", previousKnown: [] },
  );
  expect(result.text).toContain(
    "Left off: Callback set with Amanda for Wednesday.",
  );
  expect(result.text).toContain("• Owner is Amanda.");
  // The Nicole line named someone with no evidence, so it is gone.
  expect(result.text).not.toContain("Nicole");
  expect(result.text).not.toContain("Ziegler");
  expect(result.callbackNotes).toBe("Call Amanda back Wednesday morning.");
});

test("buildNote keeps the previous facts when the model returns none", () => {
  const result = buildNote(
    {
      status: "Gatekeeper — owner not reached yet",
      leftOff: "",
      known: [],
      callbackNotes: "",
      names: [],
    },
    { transcript: "Lead: Not here.", company: "Palace Spa", contacts: [] },
    { previousStatus: "First call", previousKnown: ["Open at 9:30."] },
  );
  expect(result.text).toContain("• Open at 9:30.");
});

test("buildNote falls back to the previous status when the new one is dropped", () => {
  const result = buildNote(
    {
      status: "Reached Nicole at the front desk",
      leftOff: "",
      known: [],
      callbackNotes: "",
      names: [],
    },
    { transcript: "Lead: Hello.", company: "Palace Spa", contacts: [] },
    {
      previousStatus: "Gatekeeper — owner not reached yet",
      previousKnown: [],
    },
  );
  expect(result.text).toBe("Status: Gatekeeper — owner not reached yet");
});

test("buildNote drops bullets that are just our own prompt scaffolding", () => {
  // All three of these were produced against real production transcripts.
  const result = buildNote(
    {
      status: "Never got past the front desk",
      leftOff: "",
      known: [
        "No facts recorded yet.",
        "Contacts on file: owner Rhapsody, staff Paula",
        "They open at 9:30 tomorrow.",
        "First call to this business.",
      ],
      callbackNotes: "",
      names: [],
    },
    {
      transcript: "Lead: We open at 9:30.",
      company: "Palace Spa",
      contacts: [],
    },
    { previousStatus: "", previousKnown: [] },
  );
  expect(parseKnown(result.text)).toEqual(["They open at 9:30 tomorrow."]);
});

test("buildNote drops a bullet that only restates a contact we already hold", () => {
  const result = buildNote(
    {
      status: "Gatekeeper — owner not reached yet",
      leftOff: "",
      known: [
        "Owner Michelle",
        "The owner.",
        "Owner Michelle is in on Wednesdays.",
      ],
      callbackNotes: "",
      names: [],
    },
    {
      transcript: "Lead: She's in Wednesdays.",
      company: "Palace Spa",
      contacts: ["Michelle"],
    },
    { previousStatus: "", previousKnown: [] },
  );
  // The bare restatements go; the one that actually says something stays.
  expect(parseKnown(result.text)).toEqual([
    "Owner Michelle is in on Wednesdays.",
  ]);
});

test("buildNote keeps only the newest MAX_KNOWN_BULLETS facts", () => {
  const known = Array.from(
    { length: 11 },
    (_, i) => `They mentioned detail number ${i}.`,
  );
  const result = buildNote(
    { status: "Ongoing", leftOff: "", known, callbackNotes: "", names: [] },
    { transcript: "Lead: Sure.", company: "Acme", contacts: [] },
    { previousStatus: "", previousKnown: [] },
  );
  expect(parseKnown(result.text)).toHaveLength(8);
  expect(parseKnown(result.text)[0]).toBe("They mentioned detail number 3.");
});
