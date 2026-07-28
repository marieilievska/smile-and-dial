# Call Summary Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rolling per-campaign call note with a short structured note whose person-names are limited to first names that are either on the lead record or backed by a verbatim transcript quote verified in code.

**Architecture:** All the untrusted-output handling moves into a new pure module, `src/lib/openai/summary-note.ts` — no network, no database, fully unit-testable with vitest. `summary-merger.ts` keeps orchestration only: read prior note, decide whether the call is worth summarising, call OpenAI, hand the result to the pure module, persist. Two small independent changes ride along: the post-call webhook stops writing ASR-heard identity fields onto the lead, and the Close handoff stops splitting the note on a string that no longer exists.

**Tech Stack:** TypeScript, Next.js 16 App Router, Supabase (service role), OpenAI `gpt-5.4-mini` with a strict JSON schema, vitest for unit tests, Playwright for end-to-end.

**Spec:** `docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md`

**Before you start:** this repo runs a version of Next.js with breaking changes. No task here touches routing, rendering, or React, so no Next docs are needed — but if you find yourself editing anything under `src/app/`, read the relevant guide in `node_modules/next/dist/docs/` first.

**Verify with (there is no CI gate):**

```bash
npx tsc --noEmit && npx eslint && npm run test:unit && npm run build
```

**Every test in Tasks 1–4 and 8 was executed against a standalone copy of this
module before the plan was written — 52 assertions, all passing.** If one fails
during implementation, the implementation has drifted from the code in this
plan; re-read the step rather than adjusting the assertion.

Playwright specs run against the live environment and **cannot** be run locally. Write them; do not attempt to execute them.

---

## File Structure

| File                                        | Responsibility                                                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/lib/openai/summary-note.ts` (new)      | Pure. Note types, lead-word counter, name resolution + evidence check, first-name shortening, line dropping, render, re-parse. |
| `tests/summary-note.unit.test.ts` (new)     | Vitest coverage of every rule in the module above. Runs locally.                                                               |
| `src/lib/openai/summary-merger.ts` (modify) | Orchestration: prior note, skip decision, prompt, OpenAI call, persist.                                                        |
| `src/lib/elevenlabs/post-call-webhook.ts`   | Delete `autoFillLeadFromExtraction` and its call site.                                                                         |
| `src/lib/close/actions.ts`                  | Stop splitting the note on `"Already answered"`.                                                                               |
| `tests/openai-summary.spec.ts` (modify)     | End-to-end: name rules and the skip, against the real database.                                                                |

---

### Task 1: Pure module — constants, types, lead-word counter

**Files:**

- Create: `src/lib/openai/summary-note.ts`
- Create: `tests/summary-note.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/summary-note.unit.test.ts`:

```ts
import { test, expect } from "vitest";

import { MIN_LEAD_WORDS, countLeadWords } from "../src/lib/openai/summary-note";

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: FAIL — `Failed to resolve import "../src/lib/openai/summary-note"`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/openai/summary-note.ts`:

```ts
/**
 * Pure helpers for the rolling call note.
 * See docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md.
 *
 * Everything here is deterministic and side-effect free — no network, no DB.
 * The model's output is untrusted input: the prompt *asks* for the name rule,
 * this module is what *enforces* it. Prototyping showed the same prompt on the
 * same transcript emitting an unverified name on one run and not the next, so
 * nothing here may rely on the model having behaved.
 */

/** Minimum words the LEAD must speak before a call is worth summarising. Below
 *  this there is nothing to learn, so the note is left untouched and no model
 *  call is made. Measured over 61 production calls: skips 15% of them, and none
 *  whose outcome was callback / goal_met / not_interested / call_back_later. */
export const MIN_LEAD_WORDS = 15;

/** Maximum fact bullets a note carries. Oldest are dropped first. */
export const MAX_KNOWN_BULLETS = 8;

/** A person-name the model wants to record, with the transcript line it claims
 *  states it. The quote is verified against the real transcript. */
export type ClaimedName = { name: string; evidence: string };

export type NoteParts = {
  status: string;
  leftOff: string;
  known: string[];
  callbackNotes: string;
};

/** Exactly what the model returns, before any of it is trusted. */
export type ModelNote = NoteParts & { names: ClaimedName[] };

/** How many words the LEAD spoke, from the "Agent:/Lead:" transcript text that
 *  `transcriptToText` produces in the post-call webhook. */
export function countLeadWords(transcript: string): number {
  return (transcript ?? "")
    .split(/\r?\n/)
    .filter((line) => /^\s*lead:/i.test(line))
    .map((line) => line.replace(/^\s*lead:\s*/i, ""))
    .join(" ")
    .split(/\s+/)
    .filter(Boolean).length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-note.ts tests/summary-note.unit.test.ts
git commit -m "feat(summary): pure note module with the lead-word threshold"
```

---

### Task 2: Name resolution and the evidence check

**Files:**

- Modify: `src/lib/openai/summary-note.ts`
- Modify: `tests/summary-note.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Extend the existing import at the top of `tests/summary-note.unit.test.ts` to:

```ts
import {
  MIN_LEAD_WORDS,
  countLeadWords,
  resolveNames,
} from "../src/lib/openai/summary-note";
```

Then append to the same file:

```ts
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
  // "Jack" is our own agent's name — the model tried to record it as a contact.
  const r = resolveNames(
    [{ name: "Jack", evidence: "Lead: You can speak to Jack." }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("jack")).toBe(false);
  expect(r.rejected[0].reason).toBe("quote not found in the transcript");
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
    [{ name: "amanda ziegler", evidence: "lead amanda amanda ziegler" }],
    { transcript: RHAPSODY, company: "Rhapsody Salon", contacts: [] },
  );
  expect(r.allowed.has("amanda")).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: FAIL — `resolveNames is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/summary-note.ts`:

```ts
export type NameContext = {
  /** The call transcript as "Agent:/Lead:" text. */
  transcript: string;
  /** The business name from the lead record — never from the transcript. */
  company: string;
  /** Contact names already on the lead record (i.e. from the CSV). */
  contacts: string[];
};

export type ResolvedNames = {
  /** First-name tokens the note is allowed to mention, lower-cased. */
  allowed: Set<string>;
  /** Multi-word names to shorten wherever they appear, normalized. */
  shorten: { from: string; to: string }[];
  rejected: { name: string; reason: string }[];
};

/** Case-, punctuation- and whitespace-insensitive form used for all matching. */
export function normalizeForMatch(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Decide which person-names the note may mention.
 *
 * A name is allowed when it is already on the lead record, or when the model
 * supplies a transcript line that (a) really appears in the transcript and
 * (b) actually contains the name. A name sharing a word with the business name
 * is rejected outright — that is the mishearing pattern ("Piggy", "Repz").
 * Only the FIRST name is ever allowed through.
 */
export function resolveNames(
  claimed: ClaimedName[],
  ctx: NameContext,
): ResolvedNames {
  const haystack = normalizeForMatch(ctx.transcript);
  const companyTokens = new Set(
    normalizeForMatch(ctx.company).split(" ").filter(Boolean),
  );
  const allowed = new Set<string>();
  const shorten: { from: string; to: string }[] = [];
  const rejected: { name: string; reason: string }[] = [];

  const accept = (normalized: string): void => {
    const parts = normalized.split(" ").filter(Boolean);
    if (parts.length === 0) return;
    allowed.add(parts[0]);
    if (parts.length > 1 && !shorten.some((s) => s.from === normalized)) {
      shorten.push({ from: normalized, to: parts[0] });
    }
  };

  // Names from the lead record need no evidence — the CSV is the source of truth.
  for (const contact of ctx.contacts) accept(normalizeForMatch(contact));
  const onFile = new Set(allowed);

  for (const { name, evidence } of claimed ?? []) {
    const normalized = normalizeForMatch(name);
    if (!normalized) continue;
    const first = normalized.split(" ")[0];
    // Same person as an on-file contact, possibly with a surname the CSV lacked.
    if (onFile.has(first)) {
      accept(normalized);
      continue;
    }
    const quote = normalizeForMatch(evidence);
    if (!quote || !haystack.includes(quote)) {
      rejected.push({ name, reason: "quote not found in the transcript" });
      continue;
    }
    if (!quote.includes(first)) {
      rejected.push({ name, reason: "quote does not contain the name" });
      continue;
    }
    if (normalized.split(" ").some((w) => companyTokens.has(w))) {
      rejected.push({ name, reason: "name is a word from the business name" });
      continue;
    }
    accept(normalized);
  }

  return { allowed, shorten, rejected };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-note.ts tests/summary-note.unit.test.ts
git commit -m "feat(summary): verify claimed names against the transcript"
```

---

### Task 3: First-name shortening and dropping unverified lines

**Files:**

- Modify: `src/lib/openai/summary-note.ts`
- Modify: `tests/summary-note.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Add `applyNameRules` to the existing import at the top of
`tests/summary-note.unit.test.ts`, then append:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: FAIL — `applyNameRules is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/summary-note.ts`:

```ts
/**
 * Capitalised words that are never a person's name in a call note. Any other
 * capitalised word gets its line dropped unless the name was verified, so this
 * list is what keeps real facts ("Wednesdays", "Vagaro") from being thrown out.
 *
 * Deliberately excludes words that are also common first names (Jane, May,
 * Bill): letting one through would allow an unverified name to survive, which
 * is the failure this whole module exists to prevent. Losing a booking-software
 * mention is the cheaper mistake.
 */
const NOT_NAMES = new Set(
  (
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday " +
    "Mondays Tuesdays Wednesdays Thursdays Fridays Saturdays Sundays " +
    "January February March April June July August September October November December " +
    "Morning Afternoon Evening Tonight Today Tomorrow Yesterday Weekday Weekend " +
    "They Their There The This That These Those Them She Her His Him " +
    "Owner Owners Manager Managers Staff Front Desk Receptionist Business Lead Agent " +
    "Call Calls Called Caller Callback Callbacks Phone Voicemail Voicemails " +
    "Open Opens Opened Close Closes Closed Closing Hours " +
    "After Before When While During Since Because Also Both Each Every Some Most Many " +
    "Not Never None Yes Maybe Hello Hi Thanks Thank Please Sure " +
    "First Second Third Next Last Another " +
    "Status Known Left Interested Gatekeeper Unclear Unknown " +
    "Ask Asked Try Tried Reach Reached Send Sent Said Says Told Mentioned Gave Fact Facts " +
    "Wants Needs Prefers Uses Used Handles Answers Answered Booked Booking Scheduled " +
    "Someone Somebody Nobody Everyone Person People Detail Details Best Better Good " +
    "Just Only Still Right Wrong Same Other Another New Old " +
    "AI CRM LLC Inc Spa Salon Studio Center Centre Clinic Wellness Beauty Hair Nails Med " +
    "Google Calendly Vagaro Mindbody Booksy Acuity Zenoti Phorest Fresha Schedulicity " +
    "Boulevard GlossGenius Setmore Square Yelp Facebook Instagram"
  )
    .split(/\s+/)
    .map((w) => w.toLowerCase()),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace each accepted multi-word name with just its first name, preserving
 *  the original capitalisation of the match. */
function shortenToFirstNames(
  line: string,
  shorten: { from: string; to: string }[],
): string {
  let out = line;
  for (const { from, to } of shorten) {
    // Tolerate whatever punctuation/whitespace sat between the name's words.
    const pattern = from.split(" ").map(escapeRegExp).join("[^A-Za-z]+");
    out = out.replace(new RegExp(pattern, "gi"), (match) =>
      /^[A-Z]/.test(match) ? to.charAt(0).toUpperCase() + to.slice(1) : to,
    );
  }
  return out;
}

/**
 * Shorten accepted names to first names, strip formatting noise, then drop the
 * whole line if it still mentions a name we could not verify.
 *
 * The line is dropped rather than the word excised: removing "Nicole" from
 * "The owner is Nicole and she is in tomorrow" leaves a sentence that still
 * asserts we know who the owner is. Losing a fact is recoverable; asserting a
 * false one is not.
 *
 * Returns "" for a dropped or empty line.
 */
export function applyNameRules(
  line: string,
  { allowed, shorten }: Pick<ResolvedNames, "allowed" | "shorten">,
): string {
  const out = shortenToFirstNames(line ?? "", shorten)
    .replace(/^[\s•\-–—*]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return "";

  for (const word of out.split(/\s+/)) {
    const bare = word.replace(/[^A-Za-z'-]/g, "");
    if (!/^[A-Z][a-z']{2,}$/.test(bare)) continue;
    if (NOT_NAMES.has(bare.toLowerCase())) continue;
    if (allowed.has(bare.toLowerCase())) continue;
    return "";
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-note.ts tests/summary-note.unit.test.ts
git commit -m "feat(summary): first names only, drop lines with unverified names"
```

---

### Task 4: Render the note, read it back, and compose

**Files:**

- Modify: `src/lib/openai/summary-note.ts`
- Modify: `tests/summary-note.unit.test.ts`

- [ ] **Step 1: Write the failing test**

Add `buildNote`, `parseKnown`, `parseStatus` and `renderNote` to the existing
import at the top of `tests/summary-note.unit.test.ts`, then append:

```ts
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
    { previousStatus: "Gatekeeper — owner not reached yet", previousKnown: [] },
  );
  expect(result.text).toBe("Status: Gatekeeper — owner not reached yet");
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: FAIL — `renderNote is not exported`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/openai/summary-note.ts`:

```ts
/** The heading that introduces the fact bullets. Also the marker `parseKnown`
 *  looks for, so the two can never drift apart. */
const KNOWN_HEADING = "Known — don't re-ask:";

/** Lay the note out as the text stored in `lead_campaign_summaries.ai_summary`
 *  and shown, unchanged, to the next AI caller, the lead page and the closer. */
export function renderNote(parts: NoteParts): string {
  const lines: string[] = [];
  if (parts.status) lines.push(`Status: ${parts.status}`);
  if (parts.leftOff) lines.push(`Left off: ${parts.leftOff}`);
  if (parts.known.length > 0) {
    lines.push(KNOWN_HEADING);
    for (const bullet of parts.known) lines.push(`  • ${bullet}`);
  }
  return lines.join("\n");
}

/** Read the status line back out of a stored note. "" for a legacy prose note. */
export function parseStatus(note: string): string {
  const match = /^[ \t]*Status:[ \t]*(.+)$/m.exec(note ?? "");
  return match ? match[1].trim() : "";
}

/** Read the fact bullets back out of a stored note, so the next call can carry
 *  them forward verbatim. [] for a legacy prose note. */
export function parseKnown(note: string): string[] {
  const lines = (note ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === KNOWN_HEADING);
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*•\s*(.+)$/.exec(line);
    if (!match) break;
    out.push(match[1].trim());
  }
  return out;
}

/**
 * Turn one untrusted model response into the note we store.
 *
 * `previous` guards against the model wiping accumulated context: if it returns
 * no bullets at all, or its status line is dropped by the name rules, we keep
 * what we already had rather than persisting a regression.
 */
export function buildNote(
  model: ModelNote,
  ctx: NameContext,
  previous: { previousStatus: string; previousKnown: string[] },
): {
  text: string;
  callbackNotes: string;
  rejected: { name: string; reason: string }[];
} {
  const resolved = resolveNames(model.names, ctx);
  const clean = (value: string): string => applyNameRules(value, resolved);

  const known = (model.known ?? []).map(clean).filter(Boolean);
  const parts: NoteParts = {
    status: clean(model.status) || previous.previousStatus,
    leftOff: clean(model.leftOff),
    known: (known.length > 0 ? known : previous.previousKnown).slice(
      -MAX_KNOWN_BULLETS,
    ),
    callbackNotes: clean(model.callbackNotes),
  };

  return {
    text: renderNote(parts),
    callbackNotes: parts.callbackNotes,
    rejected: resolved.rejected,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/summary-note.unit.test.ts`
Expected: PASS, 28 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-note.ts tests/summary-note.unit.test.ts
git commit -m "feat(summary): render, re-parse and compose the structured note"
```

---

### Task 5: Rewrite the merger to use the new prompt and module

**Files:**

- Modify: `src/lib/openai/summary-merger.ts`

This task has no new unit test of its own — Task 1–4 cover the logic, and the
database behaviour is covered by the Playwright spec in Task 8. Verify with
`npx tsc --noEmit` and the existing suite.

- [ ] **Step 1: Replace the file header, imports and constants**

In `src/lib/openai/summary-merger.ts`, replace the block from `import { createClient }`
down to and including the `export const SUMMARY_MODEL = ...` declaration with:

```ts
import { createClient } from "@supabase/supabase-js";

import { priceOpenAiTokens } from "@/lib/costs/rates";

import {
  MIN_LEAD_WORDS,
  buildNote,
  countLeadWords,
  parseKnown,
  parseStatus,
  type ModelNote,
} from "./summary-note";
import { openAiKey } from "./live";

/**
 * Rolling call-context generator (BUILD_PLAN §13, rewritten 2026-07-28 — see
 * docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md).
 *
 * After each connected call we regenerate, in ONE model pass over the call
 * TRANSCRIPT:
 *
 *   1. the rolling per-campaign note (lead_campaign_summaries.ai_summary) — a
 *      short "Status / Left off / Known — don't re-ask" note for whoever calls
 *      this business next, and
 *   2. this call's pickup note (calls.callback_notes), surfaced when the call
 *      scheduled a callback.
 *
 * The model's output is UNTRUSTED. Person-names are limited to first names that
 * are either already on the lead record or backed by a transcript quote we
 * verify ourselves — see summary-note.ts, which does the enforcing. A call the
 * lead barely spoke on is skipped entirely: the note is left alone and no model
 * call is made.
 *
 * Facts-only by design: it records what happened and lets the next caller
 * decide. Cost is priced from real token usage. Live whenever an OpenAI key is
 * configured; deterministic mock otherwise (tests never hit the network).
 */

/** The model that writes the note. gpt-5.4-mini is a reasoning model — we send
 *  neither temperature nor max_tokens (it only accepts the defaults), matching
 *  how the Call Reviewer calls it. Because output is not stabilisable that way,
 *  the name rules are enforced in code rather than by prompt wording. */
export const SUMMARY_MODEL =
  process.env.SUMMARY_MODEL?.trim() || "gpt-5.4-mini";
```

- [ ] **Step 2: Replace the body of `mergeLeadSummary`**

Replace the whole `export async function mergeLeadSummary(...)` declaration
(signature through its closing brace) with:

```ts
export async function mergeLeadSummary(input: {
  leadId: string;
  campaignId: string;
  /** The call whose pickup note we store on calls.callback_notes. Omit to only
   *  update the rolling per-campaign summary (e.g. unit tests). */
  callId?: string;
  /** Preferred source: the full call transcript as "Agent:/Lead:" text. */
  transcript?: string | null;
  /** Fallback source when we have no transcript (the terse per-call recap). */
  latestSummary?: string | null;
}): Promise<{
  newSummary: string | null;
  callbackNotes: string | null;
  cost: number;
  mode: "mock" | "live" | "skipped";
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceKey) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }
  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const transcript = (input.transcript ?? "").trim();
  const latest = (input.latestSummary ?? "").trim();
  if (!transcript && !latest) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "mock" };
  }

  // A call the LEAD barely spoke on has nothing to teach us. Leave the note
  // exactly as it was and spend nothing. Only applies when we actually have a
  // transcript — the terse-recap fallback has no speaker labels to count.
  if (transcript && countLeadWords(transcript) < MIN_LEAD_WORDS) {
    return { newSummary: null, callbackNotes: null, cost: 0, mode: "skipped" };
  }

  // The note so far, split back into the parts the prompt carries forward.
  const { data: existingRow } = await supabase
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId)
    .maybeSingle();
  const existing = (existingRow?.ai_summary ?? "").trim();
  const previousStatus = parseStatus(existing);
  const previousKnown = parseKnown(existing);

  // The lead's REAL business name and the contact names we already hold. ASR
  // routinely mis-hears the company name on the call, so the note is anchored
  // to the lead record, never to whatever the transcript picked up.
  const { data: leadRow } = await supabase
    .from("leads")
    .select("company, owner_name, manager_name, employee_name")
    .eq("id", input.leadId)
    .maybeSingle();
  const company = (leadRow?.company ?? "").trim();
  const contacts = [
    leadRow?.owner_name,
    leadRow?.manager_name,
    leadRow?.employee_name,
  ]
    .map((c) => (c ?? "").trim())
    .filter(Boolean);

  const apiKey = openAiKey();
  let newSummary: string;
  let callbackNotes: string;
  let cost = 0;
  if (apiKey) {
    const result = await callOpenAi(apiKey, {
      previousStatus,
      previousKnown,
      transcript,
      latest,
      company,
      contacts,
    });
    const note = buildNote(
      result.note,
      { transcript, company, contacts },
      { previousStatus, previousKnown },
    );
    newSummary = note.text;
    callbackNotes = note.callbackNotes;
    cost = priceOpenAiTokens(
      result.promptTokens,
      result.completionTokens,
      SUMMARY_MODEL,
    );
  } else {
    newSummary = mockMerge(existing, latest || transcript);
    callbackNotes = "";
  }

  // The per-campaign row is authoritative — the next outbound call for this
  // campaign reads it back as {{last_call_summary}}.
  await supabase.from("lead_campaign_summaries").upsert(
    {
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      ai_summary: newSummary,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_id,campaign_id" },
  );

  if (input.callId) {
    await supabase
      .from("calls")
      .update({ callback_notes: callbackNotes.trim() || null })
      .eq("id", input.callId);
  }

  return {
    newSummary,
    callbackNotes,
    cost,
    mode: apiKey ? "live" : "mock",
  };
}
```

- [ ] **Step 3: Replace the prompt, schema and OpenAI call**

Replace everything from `const SYSTEM_PROMPT =` to the end of the file with:

```ts
/** System prompt. The name rule is stated here AND enforced in summary-note.ts;
 *  the prompt alone is not reliable enough to depend on.
 *
 *  Examples use <ANGLE_BRACKET> placeholders on purpose. An earlier draft whose
 *  example read "the owner is Nicole, she's usually in Wednesdays" made the
 *  model emit "Owner is usually in on Wednesdays" for a business whose
 *  transcript said tomorrow — it copied the example instead of reading the
 *  call. Never put a sample value in here. */
const SYSTEM_PROMPT = `You keep a short, factual running note about a business our team is cold-calling, for whoever calls them next.

NAMES — the rule you are most likely to get wrong. Phone transcription mishears names constantly, and the usual failure is ADOPTING a name nobody actually gave: mishearing a business's greeting and treating it as a person, or turning the company name into a person's name.

You may write a person's name in exactly two situations:
  1. It appears in the "Contacts on file" list you are given, or
  2. A speaker EXPLICITLY identified that person by name — patterns like "the owner is <NAME>", "you'd want to talk to <NAME>", "this is <NAME> speaking", "ask for <NAME>".

For case 2 you must supply the verbatim transcript line that states it, in "evidence". The line is checked against the real transcript; if it does not appear there word for word, the name is thrown away along with every line that mentions it.

Use FIRST NAMES only. Never write a surname.

Everything else is a ROLE, never a name: "the person who answered", "the front desk", "the owner", "a staff member". In particular:
  - A name you got from how they ANSWERED the phone is not an explicit identification. A greeting like "thanks for calling <SOMETHING>" names no person — that is the business name, probably misheard. Do not turn it into a person.
  - Never infer a person's name from the company name.
  - Our own caller's name is never recorded. Only people at the business.
  - The business is ALWAYS the name on file. Never repeat a business name heard on the call, not even to correct it.
When you cannot record the name, keep the useful FACT and drop the name: "the owner is <NAME>, she's usually in on <DAY>" becomes "Owner is usually in on <DAY>" with the real day.

The angle-bracket placeholders above illustrate a PATTERN. Never copy them, and never copy a day, time or detail out of them — every fact you write must come from the transcript you are given.

Every call is between OUR agent and the business. The agent's own pitch, questions and talking points are NOT the lead's views — record only what the LEAD said. Past tense, third person, plain English. Never quote the transcript in a bullet. Invent nothing. Don't tell the next caller what to do. When in doubt, leave it out.`;

/** Strict JSON output. `names` carries the evidence we verify in code. */
const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "left_off", "known", "callback_notes", "names"],
  properties: {
    status: { type: "string" },
    left_off: { type: "string" },
    known: { type: "array", items: { type: "string" } },
    callback_notes: { type: "string" },
    names: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "evidence"],
        properties: {
          name: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

type PromptArgs = {
  previousStatus: string;
  previousKnown: string[];
  transcript: string;
  latest: string;
  company: string;
  contacts: string[];
};

function buildUserPrompt(args: PromptArgs): string {
  const priorStatus = args.previousStatus
    ? `Where we stood: ${args.previousStatus}`
    : "This is the first call to this business.";
  const priorKnown =
    args.previousKnown.length > 0
      ? `Facts already recorded (these are the exact strings you must carry forward):\n${args.previousKnown
          .map((k) => `  ${k}`)
          .join("\n")}`
      : "No facts recorded yet.";
  const source = args.transcript
    ? `Transcript of the call that just happened:\n${args.transcript}`
    : `Recap of the call that just happened:\n${args.latest}`;

  return `Business on file: "${args.company}".
Contacts on file: ${args.contacts.join(", ") || "NONE — you may not write any personal name at all."}

${priorStatus}
${priorKnown}

${source}

Return JSON:

"status" — at most 10 words for where we stand with this business overall, counting all calls so far. Examples of the SHAPE: "Gatekeeper — owner not reached yet", "Interested, callback booked", "Not interested", "Asked to be removed", "Never got past the front desk".

"left_off" — ONE short sentence naming a concrete thing waiting to be picked up: an agreed callback, permission to send something, a time they told us to try. If there is no such thing, return an empty string. "They weren't the owner" and "they hung up" are NOT pickup points — that belongs in status, so return empty.

"known" — bullets recording what the LEAD has told us, so the next caller never re-asks. Rules, in order of importance:
  - Copy every string under "Facts already recorded" through EXACTLY as written. Do not reword, merge, or reorder them.
  - Then add up to 5 new bullets for things the LEAD said on this call. Prioritise concrete operational facts over impressions: the booking/scheduling/CRM software they named, their hours, who handles new leads, the best time to reach the decision-maker, how they handle missed calls.
  - A bullet is at most 10 words, third person, plain English. Never a quote or a first-person sentence from the transcript.
  - NEVER write a bullet about what we failed to learn. Absence of information is not a fact. If this call taught us nothing, add nothing and return only the carried-forward bullets.
  - Never restate what "status" already says.
  - Never write a bullet that just repeats something in "Contacts on file" or the business name. We already have those. Record what the lead TOLD us.
  - Max 8 bullets; if you would exceed that, drop the oldest.

"callback_notes" — 1-2 sentences ONLY if this call left a concrete pickup point. Otherwise empty string.

"names" — one entry for every person-name you used anywhere above that is NOT in "Contacts on file". Each entry needs the name and, in "evidence", the transcript line that explicitly identified that person, copied word for word from the transcript above. Empty array if you used no such names. A name whose evidence does not match the transcript is deleted along with every line that mentions it, so do not guess.`;
}

/** Live mode: one gpt-5.4-mini pass returning the note parts plus the names it
 *  wants to use. Plain fetch (no SDK dependency for a single call). On any
 *  failure we return an empty note and charge nothing — buildNote then falls
 *  back to the previous status and facts, so an outage never wipes the note. */
async function callOpenAi(
  apiKey: string,
  args: PromptArgs,
): Promise<{
  note: ModelNote;
  promptTokens: number;
  completionTokens: number;
}> {
  const empty: ModelNote = {
    status: "",
    leftOff: "",
    known: [],
    callbackNotes: "",
    names: [],
  };
  const fallback = { note: empty, promptTokens: 0, completionTokens: 0 };

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(args) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "call_note",
            strict: true,
            schema: SUMMARY_SCHEMA,
          },
        },
      }),
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  if (!content) return { ...fallback, promptTokens, completionTokens };

  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
    const note: ModelNote = {
      status: str(parsed.status),
      leftOff: str(parsed.left_off),
      known: Array.isArray(parsed.known)
        ? parsed.known.filter((k): k is string => typeof k === "string")
        : [],
      callbackNotes: str(parsed.callback_notes),
      names: Array.isArray(parsed.names)
        ? parsed.names
            .filter(
              (n): n is { name: string; evidence: string } =>
                !!n &&
                typeof n === "object" &&
                typeof (n as { name?: unknown }).name === "string" &&
                typeof (n as { evidence?: unknown }).evidence === "string",
            )
            .map((n) => ({ name: n.name, evidence: n.evidence }))
        : [],
    };
    return { note, promptTokens, completionTokens };
  } catch {
    return { ...fallback, promptTokens, completionTokens };
  }
}
```

**Keep** the existing `mockMerge`, `stripWeKnow`, `strip` and `clampWords`
helpers exactly as they are — they serve the no-API-key path that offline tests
depend on. They currently sit between `mergeLeadSummary` and `SYSTEM_PROMPT`, so
they are untouched by the two replacements above.

- [ ] **Step 4: Verify it compiles and nothing else broke**

Run: `npx tsc --noEmit && npx eslint src/lib/openai && npm run test:unit`
Expected: no type errors, no lint errors, all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-merger.ts
git commit -m "feat(summary): structured note prompt with verified names"
```

---

### Task 6: Stop writing ASR-heard identity fields onto the lead

**Files:**

- Modify: `src/lib/elevenlabs/post-call-webhook.ts`

- [ ] **Step 1: Delete the call site**

Around line 1080, delete these six lines:

```ts
// Identity/contact details are always worth filling: a name or email the
// agent heard is real whether or not the call became a full conversation
// (someone saying "this is Wilson" then hanging up still tells us the owner).
// autoFillLeadFromExtraction only writes non-blank values into empty lead
// fields, so it's safe to run on every call.
await autoFillLeadFromExtraction(supabase, call.lead_id, payload);
```

and replace them with:

```ts
// NOTE: we deliberately do NOT copy heard names or emails onto the lead.
// Transcription mishears them (Jin -> "Jinmi", a business greeting heard as a
// person's name), and the lead's identity fields are owned by the imported
// CSV. The captured values stay on calls.extracted_data and are visible in
// the call detail; the rolling note may record one when a speaker explicitly
// stated it, verified against the transcript. See
// docs/superpowers/specs/2026-07-28-call-summary-rewrite-design.md.
```

- [ ] **Step 2: Delete the function**

Delete the whole `autoFillLeadFromExtraction` declaration together with its
doc comment — the block starting at the comment `/**\n * Auto-populate currently-empty lead contact fields ...`
and ending with the closing brace of the function (originally lines 1327–1369).

- [ ] **Step 3: Delete the now-unused type alias**

At line 30, delete:

```ts
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];
```

It was referenced only inside the function just deleted.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/elevenlabs/post-call-webhook.ts`
Expected: clean. If `Database` or any other import is now unused, eslint will
say so — remove exactly what it names and nothing else.

Do **not** touch `IDENTITY_EXTRACTION_KEYS` or `sanitizeExtraction`: they decide
what is stored on `calls.extracted_data`, which we are keeping.

- [ ] **Step 5: Commit**

```bash
git add src/lib/elevenlabs/post-call-webhook.ts
git commit -m "fix(leads): stop copying ASR-heard names and emails onto the lead"
```

---

### Task 7: Stop splitting the note in the Close handoff

**Files:**

- Modify: `src/lib/close/actions.ts:394-415`

- [ ] **Step 1: Replace the splitter**

Replace:

```ts
// Rolling per-campaign summary — the richest "what the lead said / is
// interested in" digest we have (facts-only, cross-call). Prefer the summary
// for the packaged call's campaign; else the most recently updated one. Strip
// the trailing "Already answered — don't re-ask…" list, which is guidance for
// the next AI caller, not for the closer.
```

with:

```ts
// Rolling per-campaign summary — the richest "what the lead said / is
// interested in" digest we have (facts-only, cross-call). Prefer the summary
// for the packaged call's campaign; else the most recently updated one.
//
// Sent WHOLE. This used to strip everything after the literal string
// "Already answered", which the note no longer contains — so the split would
// have silently stopped matching anyway. The note's fact bullets are exactly
// what a closer wants (their hours, their booking software, their objection)
// and "don't re-ask" is good advice for a human closer too.
```

and replace:

```ts
const contextSummary = rawSummary
  ? rawSummary.split(/\bAlready answered\b/)[0].trim() || null
  : null;
```

with:

```ts
const contextSummary = rawSummary ? rawSummary.trim() || null : null;
```

- [ ] **Step 2: Update the stale doc comment on the consumer**

In `src/lib/close/handoff.ts`, at the `contextSummary` field (around line 28),
replace:

```ts
/** The rolling, cross-call digest of what the lead actually said / wants (from
 *  lead_campaign_summaries.ai_summary), already trimmed of any AI-facing tail.
 *  Null when we have no summary. This is the closer's main context. */
```

with:

```ts
/** The rolling, cross-call digest of what the lead actually said / wants (from
 *  lead_campaign_summaries.ai_summary), sent whole. Null when we have no
 *  summary. This is the closer's main context. */
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/close`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/close/actions.ts src/lib/close/handoff.ts
git commit -m "refactor(close): send the whole rolling note to the closer"
```

---

### Task 8: End-to-end spec, full verification, ship

**Files:**

- Modify: `tests/openai-summary.spec.ts`

- [ ] **Step 1: Add the end-to-end cases**

In `tests/openai-summary.spec.ts`, change the import at the top to:

```ts
import { mergeLeadSummary, mockMerge } from "../src/lib/openai/summary-merger";
import {
  buildNote,
  countLeadWords,
  parseKnown,
} from "../src/lib/openai/summary-note";
```

Then add these tests inside the existing `test.describe("OpenAI summary merger (mock)", ...)`
block, after the last existing test:

```ts
test("a call the lead barely spoke on leaves the stored note untouched", async () => {
  // Seed a note we can prove was not overwritten.
  await admin.from("lead_campaign_summaries").upsert(
    {
      lead_id: leadId,
      campaign_id: campaignId,
      ai_summary: "Status: Gatekeeper — owner not reached yet",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "lead_id,campaign_id" },
  );

  const result = await mergeLeadSummary({
    leadId,
    campaignId,
    transcript: "Agent: Is the owner in?\nLead: Nope.\nAgent: Thanks.",
  });
  expect(result.mode).toBe("skipped");
  expect(result.cost).toBe(0);
  expect(result.newSummary).toBeNull();

  const { data: row } = await admin
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", leadId)
    .eq("campaign_id", campaignId)
    .maybeSingle();
  expect(row?.ai_summary).toBe("Status: Gatekeeper — owner not reached yet");
});

test("a name with a real transcript quote survives, shortened to its first name", () => {
  const transcript = "Lead: The owner is Amanda Ziegler, she's in Wednesdays.";
  const note = buildNote(
    {
      status: "Gatekeeper — owner not reached yet",
      leftOff: "",
      known: ["Owner is Amanda Ziegler.", "Owner is in on Wednesdays."],
      callbackNotes: "",
      names: [
        {
          name: "Amanda Ziegler",
          evidence: "Lead: The owner is Amanda Ziegler, she's in Wednesdays.",
        },
      ],
    },
    { transcript, company: "Rhapsody Salon", contacts: [] },
    { previousStatus: "", previousKnown: [] },
  );
  expect(parseKnown(note.text)).toEqual([
    "Owner is Amanda.",
    "Owner is in on Wednesdays.",
  ]);
  expect(note.text).not.toContain("Ziegler");
});

test("a name the model invented never reaches the stored note", () => {
  const transcript = "Lead: She's not in today, try tomorrow morning please.";
  const note = buildNote(
    {
      status: "Gatekeeper — owner not reached yet",
      leftOff: "Call back for Nicole tomorrow morning.",
      known: ["Owner is Nicole.", "Try again tomorrow morning."],
      callbackNotes: "",
      // No such line exists in the transcript.
      names: [{ name: "Nicole", evidence: "Lead: The owner is Nicole." }],
    },
    { transcript, company: "Palace Spa", contacts: [] },
    { previousStatus: "", previousKnown: [] },
  );
  expect(note.text).not.toContain("Nicole");
  expect(parseKnown(note.text)).toEqual(["Try again tomorrow morning."]);
  expect(note.rejected[0].reason).toBe("quote not found in the transcript");
});

test("countLeadWords ignores the agent's half of the call", () => {
  expect(
    countLeadWords("Agent: A long question from us here.\nLead: Two words"),
  ).toBe(2);
});
```

- [ ] **Step 2: Run the full local verification**

```bash
npx tsc --noEmit && npx eslint && npm run test:unit && npm run build
```

Expected: all four clean. Playwright is not runnable locally — do not try.

- [ ] **Step 3: Commit and open the PR**

```bash
git add tests/openai-summary.spec.ts
git commit -m "test(summary): cover the skip and the name rules end to end"
git push -u origin feat/call-summary-rewrite
```

Open a PR describing: the structured note replacing the prose paragraph; names
limited to verified first names; the identity-field write removed from the
post-call webhook; and the Close splitter removed. Link the spec.

- [ ] **Step 4: Merge and confirm the deploy**

Merge to `main` (Vercel auto-deploys). No migration — nothing in this change
touches the schema.

- [ ] **Step 5: Confirm against production after the next few calls**

Re-run the design-time inspection: median note length well under the 117-word
baseline, and every personal name in a note is either on its lead record or
quoted in that call's transcript.

---

## Notes for the implementer

- **No migration.** `lead_campaign_summaries.ai_summary` stays a text column;
  only the text inside it changes shape.
- **Existing notes are left alone** on purpose. They self-heal the next time
  each lead is called. `parseStatus` / `parseKnown` return `""` / `[]` for the
  legacy prose format, so the first call after deploy simply starts a fresh
  structured note rather than crashing or half-parsing.
- **This system places real phone calls.** Nothing in this plan changes dialing,
  scheduling, or outcomes. If a step seems to, stop and re-read the spec.
- **Failing safe means dropping a line, never rewriting one.** If you are
  tempted to excise a name from mid-sentence instead of dropping the line, don't
  — the spec explains why.
