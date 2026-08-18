# Daily Outcome Audit — Phase 1 (Triage + Scorecard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the audit's "read every transcript" step with a read-only `triage.js` that flags the ~40 calls whose label contradicts a signal the AI already recorded, prints a scorecard, and appends a daily drift-history line.

**Architecture:** Three new plain-Node files in the skill's `scripts/` dir. `_signals.js` holds pure transcript helpers mirroring `src/lib/calls/classify-outcome.ts`. `_flags.js` holds pure per-call flag predicates. `triage.js` orchestrates: two-phase prod pull (light rows, then transcripts only for DNC + a voicemail sample + flagged rows), computes flags, prints a scorecard, writes a "read these" dump + a suggested relabel map (never auto-applied), and rewrites one line per day into `scorecard.jsonl`. No app code changes in Phase 1 (the classifier guard is Phase 2).

**Tech Stack:** Node.js (CommonJS `require`), Node's built-in `node:test` + `node:assert` for unit tests (no app test runner involved), PostgREST via the existing `_common.js` helpers. All scripts read prod read-only via `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`.

**Branch:** `feat/daily-outcome-audit-accuracy` (already checked out; spec committed there).

**Spec:** `docs/superpowers/specs/2026-08-18-daily-outcome-audit-accuracy-design.md`

---

## File structure

- `.claude/skills/daily-outcome-audit/scripts/_signals.js` — **create.** Pure transcript/text signals mirroring `classify-outcome.ts`: `normalizeTurns`, `genuineHumanReplyCount`, `agentOfferedRemoval`. No network. Review-aid only.
- `.claude/skills/daily-outcome-audit/scripts/_signals.test.js` — **create.** `node:test` unit tests for `_signals.js`.
- `.claude/skills/daily-outcome-audit/scripts/_flags.js` — **create.** Pure per-call flag predicates: `structuralFlags` (no transcript), `transcriptFlags` (needs transcript). Imports `_signals.js`.
- `.claude/skills/daily-outcome-audit/scripts/_flags.test.js` — **create.** `node:test` unit tests for `_flags.js`.
- `.claude/skills/daily-outcome-audit/scripts/triage.js` — **create.** Orchestration + scorecard + outputs.
- `.claude/skills/daily-outcome-audit/scripts/scorecard.jsonl` — **create (by running triage).** One JSON line per audited day. Committed (drift baseline).
- `.claude/skills/daily-outcome-audit/scripts/audit-day.js` — **remove.** Superseded by `triage.js`.
- `.claude/skills/daily-outcome-audit/SKILL.md` — **modify.** New daily loop + quick-ref front door.
- `.claude/skills/daily-outcome-audit/outcome-playbook.md` — **modify.** Add the objective cross-field signals; note `decision_maker_reached` is a `yes/no/unknown` string enum.
- `.claude/skills/daily-outcome-audit/fix-patterns.md` — **modify.** Note the triage-seeded suggested map.

**Note on TDD here:** `_signals.js` and `_flags.js` are pure and get real unit tests (run with `node --test`). `triage.js` does prod I/O, so it is verified by a **read-only smoke run against the real 08-12 day** (the skill's established pattern for its scripts) with concrete expected numbers — not a unit test.

---

## Task 1: `_signals.js` — pure transcript signals (TDD)

**Files:**
- Create: `.claude/skills/daily-outcome-audit/scripts/_signals.js`
- Test: `.claude/skills/daily-outcome-audit/scripts/_signals.test.js`

- [ ] **Step 1: Write the failing test**

Create `.claude/skills/daily-outcome-audit/scripts/_signals.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .claude/skills/daily-outcome-audit/scripts/_signals.test.js`
Expected: FAIL — `Cannot find module './_signals'`.

- [ ] **Step 3: Write the implementation**

Create `.claude/skills/daily-outcome-audit/scripts/_signals.js`:

```js
// Transcript-derived signals for the audit TRIAGE. These MIRROR the logic in
// src/lib/calls/classify-outcome.ts so triage flags calls the same way the
// post-call webhook classifies them. REVIEW AID ONLY — every real relabel still
// goes through human-confirmed relabel.js, so an approximation here is safe.
// If classify-outcome.ts's regexes change, update these to match.

/** Answering-machine / voicemail / IVR greeting markers. Verbatim copy of
 *  MACHINE_GREETING_RE in classify-outcome.ts. */
const MACHINE_GREETING_RE =
  /\bleave (us |you |your |a )*(a )?(message|voicemail)\b|\bafter (the )?(tone|beep)\b|\bat the (tone|beep)\b|\byou(?:'ve| have)? reached\b|\bpress (one|two|three|[0-9*#])\b|\bfor [a-z ,'-]{1,40}press\b|\bafter[- ]hours\b|\b(we are|we're|currently) closed\b|\bour office is closed\b|\bun(?:able|available) to (take|answer)\b|\b(can(?:no|')t|cannot) (take|come to)\b|\bmissed your call\b|\bplease leave\b|\byour party'?s extension\b|\breturn your call\b|\bvoice ?mail\b|\bmailbox\b|\bif this is an emergency\b|\bplease (stay on the line|hold)\b|\bthank you for calling\b[\s\S]{0,60}\bpress\b/i;

/** Recorded / IVR / menu / voicemail reply markers (EN/ES/FR). Verbatim copy of
 *  MACHINE_REPLY_RE in classify-outcome.ts. */
const MACHINE_REPLY_RE =
  /invalid|try again|recogniz|press (one|two|three|four|five|six|seven|eight|nine|zero|\d)|\boption\b|\bqueue\b|\bhold\b|transfer you to (the )?(receptionist|voicemail|our|billing|extension)|leave (a |your |us )?(message|voicemail)|after the (tone|beep)|thank you for calling|website|www\.|\.com|\.ca\b|receptionist for|virtual|assistant|\bai\b|not available|unavailable|please (stay|hold|wait)|connect you|record your|mailbox|good ?bye|voicemail|this call (may|will) be recorded|quality (assurance|purposes)|deja(r|me|nos)? (un |tu )?mensaje|despu[eé]s del (tono|bip|se[nñ]al)|permane(ce|zca) en la l[ií]nea|buz[oó]n|correo de voz|no (puedo|puede|está|estamos|estoy) (disponible|hablar|atender)|en este momento|gracias por (llamar|comunicarse)|dijo:|laissez (un |votre )?message|apr[eè]s (la|le) (tonalit|bip)|bo[iî]te vocale|messagerie/i;

/** An AGENT turn offers to remove the lead from calling (agent-manufactured DNC,
 *  as opposed to the person asking to stop unprompted). */
const AGENT_OFFER_REMOVAL_RE =
  /\btake you off\b|\bremove you\b|\btake you out of\b|\boff (the|our|your) (list|calling list)\b|\bdo(?:-| )?not(?:-| )?call\b|\bstop calling you\b|\bwon'?t call you again\b|\bmake sure we don'?t call\b/i;

function normalizeTurns(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript
    .filter((t) => t && typeof t === "object" && typeof t.message === "string")
    .map((t) => ({ role: String(t.role ?? ""), message: t.message }));
}

const alphaLen = (s) => s.replace(/[^a-z]/gi, "").length;
const wordCount = (s) => s.trim().split(/\s+/).filter(Boolean).length;

/** Count GENUINE human replies (mirror of classify-outcome.ts): a user turn that
 *  follows an agent turn, is short/conversational (<=12 words), and isn't
 *  recorded machine/IVR/voicemail text. Stays ~0 for machines, >=2 for a real
 *  back-and-forth. */
function genuineHumanReplyCount(transcript) {
  const turns = normalizeTurns(transcript);
  let agentSpoke = false;
  let count = 0;
  for (const t of turns) {
    if (t.role === "agent" || t.role === "ai") {
      agentSpoke = true;
      continue;
    }
    if (t.role === "user" && agentSpoke) {
      const m = t.message.trim();
      if (
        alphaLen(m) >= 2 &&
        wordCount(m) <= 12 &&
        !MACHINE_GREETING_RE.test(m) &&
        !MACHINE_REPLY_RE.test(m)
      ) {
        count++;
      }
    }
  }
  return count;
}

/** True when an AGENT turn offers to remove the lead from calling. */
function agentOfferedRemoval(transcript) {
  return normalizeTurns(transcript).some(
    (t) =>
      (t.role === "agent" || t.role === "ai") &&
      AGENT_OFFER_REMOVAL_RE.test(t.message),
  );
}

module.exports = {
  normalizeTurns,
  genuineHumanReplyCount,
  agentOfferedRemoval,
  MACHINE_GREETING_RE,
  MACHINE_REPLY_RE,
  AGENT_OFFER_REMOVAL_RE,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .claude/skills/daily-outcome-audit/scripts/_signals.test.js`
Expected: PASS — `# pass 5`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/daily-outcome-audit/scripts/_signals.js .claude/skills/daily-outcome-audit/scripts/_signals.test.js
git commit --no-verify -m "feat(skill): _signals.js — transcript signals for triage (mirror of classify-outcome)"
```

---

## Task 2: `_flags.js` — pure per-call flag predicates (TDD)

**Files:**
- Create: `.claude/skills/daily-outcome-audit/scripts/_flags.js`
- Test: `.claude/skills/daily-outcome-audit/scripts/_flags.test.js`

- [ ] **Step 1: Write the failing test**

Create `.claude/skills/daily-outcome-audit/scripts/_flags.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .claude/skills/daily-outcome-audit/scripts/_flags.test.js`
Expected: FAIL — `Cannot find module './_flags'`.

- [ ] **Step 3: Write the implementation**

Create `.claude/skills/daily-outcome-audit/scripts/_flags.js`:

```js
// Pure per-call flag predicates for the audit triage. A flag marks a call whose
// LABEL contradicts a signal the AI already recorded — "a human should read this
// one". structuralFlags needs no transcript; transcriptFlags does (pulled in
// triage's second phase). All pure — unit-tested in _flags.test.js.
const S = require("./_signals");

/** The decision-maker enum the extractor records: "yes" | "no" | "unknown" | absent. */
const dmOf = (extracted) => {
  const v = extracted && extracted.decision_maker_reached;
  return typeof v === "string" ? v.trim().toLowerCase() : null;
};

function structuralFlags({ outcome, extracted, leadHasBooking, hasCallbackRow, status }) {
  const out = [];
  const dm = dmOf(extracted);

  // not_interested is owner-only by definition; if the AI didn't confirm the
  // owner (dm != yes), it's likely a gatekeeper decline. (Phase 2 enforces this
  // in the classifier; until then triage flags + suggests the relabel.)
  if (outcome === "not_interested" && dm !== "yes") {
    out.push({
      type: "not_interested_dm_not_yes",
      reason: `not_interested but dm=${dm ?? "absent"} → likely gatekeeper_not_interested`,
      suggest: "gatekeeper_not_interested",
    });
  }

  // Reverse: a gatekeeper decline where the AI said it DID reach the owner.
  if (outcome === "gatekeeper_not_interested" && dm === "yes") {
    out.push({
      type: "gni_dm_yes",
      reason: "gatekeeper_not_interested but dm=yes → read (owner decline? mis-extract?)",
    });
  }

  // goal_met must have a real booking.
  if (outcome === "goal_met" && !leadHasBooking) {
    out.push({
      type: "goal_met_no_booking",
      reason: "goal_met but lead has NO Calendly booking → false win / failed booking",
    });
  }

  // A callback with no time strands the lead (dialer has nothing to dial).
  if (outcome === "callback" && !(extracted && extracted.callback_datetime) && !hasCallbackRow) {
    out.push({
      type: "callback_no_time",
      reason: "callback with no callback_datetime and no callbacks row → stranded",
    });
  }

  // A completed call must never have a null outcome (should be zero post-#394).
  if ((outcome == null || outcome === "") && status === "completed") {
    out.push({
      type: "null_outcome",
      reason: "completed call with null outcome → stranded (should be zero)",
    });
  }

  return out;
}

function transcriptFlags({ outcome, transcript }) {
  const out = [];
  if (outcome === "dnc" && S.agentOfferedRemoval(transcript)) {
    out.push({
      type: "dnc_agent_offer",
      reason: "dnc where an AGENT turn offered removal → agent-manufactured?",
    });
  }
  if (outcome === "voicemail" && S.genuineHumanReplyCount(transcript) >= 2) {
    out.push({
      type: "voicemail_has_human",
      reason: "voicemail with >=2 genuine human replies → human reached then mailbox → gatekeeper",
    });
  }
  return out;
}

module.exports = { structuralFlags, transcriptFlags, dmOf };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .claude/skills/daily-outcome-audit/scripts/_flags.test.js`
Expected: PASS — `# pass 11`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/daily-outcome-audit/scripts/_flags.js .claude/skills/daily-outcome-audit/scripts/_flags.test.js
git commit --no-verify -m "feat(skill): _flags.js — per-call contradiction flags for triage"
```

---

## Task 3: `triage.js` — orchestration, scorecard, outputs

**Files:**
- Create: `.claude/skills/daily-outcome-audit/scripts/triage.js`
- Create (by running): `.claude/skills/daily-outcome-audit/scripts/scorecard.jsonl`

- [ ] **Step 1: Write the implementation**

Create `.claude/skills/daily-outcome-audit/scripts/triage.js`:

```js
// TRIAGE — the read-only front door of the daily outcome audit. One Eastern day
// (default yesterday). Flags calls whose label contradicts a signal the AI
// already recorded so the reviewer reads the ~40 suspects instead of all 3,000,
// prints a scorecard, writes a "read these" dump + a SUGGESTED relabel map (never
// auto-applied), and rewrites one line per day into scorecard.jsonl (drift
// history). Writes nothing to the DB. Supersedes audit-day.js.
// Usage: node triage.js [YYYY-MM-DD]
const fs = require("fs");
const path = require("path");
const C = require("./_common");
const F = require("./_flags");

const { date, start, end } = C.etWindow(process.argv[2]);
const VOICEMAIL_SAMPLE = 60;

// MIRROR of src/lib/calls/outcomes.ts CONNECTED_OUTCOMES / NON_CALL_OUTCOMES —
// keep in sync. Used only for the scorecard connect-rate ratio.
const CONNECTED = new Set(["goal_met", "callback", "call_back_later", "not_interested", "gatekeeper", "gatekeeper_not_interested", "transferred_to_human", "language_barrier", "hung_up_immediately", "hung_up_later", "dnc"]);
const NON_CALL = new Set(["ai_error"]);

/** Evenly-spaced deterministic sample (reproducible — no Math.random). */
const evenSample = (arr, n) => (arr.length <= n ? arr.slice() : Array.from({ length: n }, (_, i) => arr[Math.floor((i * arr.length) / n)]));

(async () => {
  console.log(`\n===== TRIAGE — ${date} (ET) =====`);

  // 1) light pull (no transcript_json)
  const rows = await C.pageAll(
    `calls?started_at=gte.${start}&started_at=lt.${end}` +
      `&select=id,lead_id,campaign_id,outcome,outcome_source,duration_seconds,status,extracted_data,started_at,elevenlabs_conversation_id&order=started_at.asc`,
  );
  const byOutcome = {};
  for (const r of rows) (byOutcome[r.outcome || "(null)"] = byOutcome[r.outcome || "(null)"] || []).push(r);
  console.log(`total calls: ${rows.length}`);

  // 2) leads → booking set + per-lead outcome sets
  const leadIds = [...new Set(rows.map((r) => r.lead_id).filter(Boolean))];
  const booked = new Set();
  for (let i = 0; i < leadIds.length; i += 100) {
    const ls = await C.get(`leads?id=in.(${C.inList(leadIds.slice(i, i + 100))})&calendly_event_uri=not.is.null&select=id`);
    for (const l of ls) booked.add(l.id);
  }
  const outByLead = {};
  for (const r of rows) (outByLead[r.lead_id] = outByLead[r.lead_id] || new Set()).add(r.outcome);

  // 3) callbacks rows for this day's callback calls (strand detection)
  const callbackIds = (byOutcome.callback || []).map((r) => r.id);
  const hasCb = new Set();
  for (let i = 0; i < callbackIds.length; i += 100) {
    const cbs = await C.get(`callbacks?originating_call_id=in.(${C.inList(callbackIds.slice(i, i + 100))})&select=originating_call_id`);
    for (const c of cbs) hasCb.add(c.originating_call_id);
  }

  // 4) structural flags (no transcript)
  const flags = [];
  for (const r of rows) {
    for (const f of F.structuralFlags({ outcome: r.outcome, extracted: r.extracted_data, leadHasBooking: booked.has(r.lead_id), hasCallbackRow: hasCb.has(r.id), status: r.status })) {
      flags.push({ id: r.id, lead_id: r.lead_id, outcome: r.outcome, ...f });
    }
  }
  // hidden wins: booked leads whose day outcomes lack goal_met
  const hiddenWins = [...booked].filter((l) => !outByLead[l] || !outByLead[l].has("goal_met"));

  // 5) transcript flags: all dnc + a voicemail sample
  const dncRows = byOutcome.dnc || [];
  const vmRows = byOutcome.voicemail || [];
  const vmSample = evenSample(vmRows, VOICEMAIL_SAMPLE);
  const tIds = [...dncRows.map((r) => r.id), ...vmSample.map((r) => r.id)];
  const tById = {};
  for (let i = 0; i < tIds.length; i += 60) {
    const ts = await C.get(`calls?id=in.(${C.inList(tIds.slice(i, i + 60))})&select=id,transcript_json`);
    for (const t of ts) tById[t.id] = t.transcript_json;
  }
  for (const r of [...dncRows, ...vmSample]) {
    for (const f of F.transcriptFlags({ outcome: r.outcome, transcript: tById[r.id] })) {
      flags.push({ id: r.id, lead_id: r.lead_id, outcome: r.outcome, ...f });
    }
  }

  // 6) scorecard
  const flagByType = {};
  for (const f of flags) flagByType[f.type] = (flagByType[f.type] || 0) + 1;
  const cnt = (o) => (byOutcome[o] || []).length;
  const total = rows.length || 1;
  const connected = rows.filter((r) => CONNECTED.has(r.outcome)).length;
  const denom = rows.filter((r) => !NON_CALL.has(r.outcome)).length || 1;
  const niDenom = cnt("not_interested") || 1;
  const ratios = {
    not_interested_dm_no: +((flagByType.not_interested_dm_not_yes || 0) / niDenom).toFixed(3),
    ai_receptionist_share: +(cnt("ai_receptionist") / total).toFixed(3),
    callback_share: +(cnt("callback") / total).toFixed(3),
    connect_rate: +(connected / denom).toFixed(3),
    goal_met: cnt("goal_met"),
    dnc: cnt("dnc"),
  };

  const flagsForOutcome = (o) => flags.filter((f) => f.outcome === o).length;
  console.log(`\noutcome                        count   manual   flags`);
  for (const [o, rs] of Object.entries(byOutcome).sort((a, b) => b[1].length - a[1].length)) {
    const man = rs.filter((r) => r.outcome_source === "manual").length;
    console.log(`  ${o.padEnd(28)} ${String(rs.length).padStart(5)}  ${String(man).padStart(6)}  ${String(flagsForOutcome(o)).padStart(5)}`);
  }
  console.log(`\nflags by type: ${JSON.stringify(flagByType)}`);
  console.log(`hidden-win goal_met (booked, not goal_met): ${hiddenWins.length}`);
  console.log(`voicemail: sampled ${vmSample.length} of ${vmRows.length} (skipped ${vmRows.length - vmSample.length})`);
  if ((byOutcome.ai_error || []).length) console.log(`⚠️ ai_error=${(byOutcome.ai_error || []).length} — run credit-check.js (incident, not a relabel).`);
  console.log(`ratios: ${JSON.stringify(ratios)}`);

  // 7) scorecard.jsonl — idempotent per date (drop any existing line for this date, then append)
  const scFile = path.join(__dirname, "scorecard.jsonl");
  const scorecard = { date, total: rows.length, byOutcome: Object.fromEntries(Object.entries(byOutcome).map(([o, rs]) => [o, rs.length])), flags: flagByType, ratios };
  const kept = fs.existsSync(scFile)
    ? fs.readFileSync(scFile, "utf8").split("\n").filter(Boolean).filter((l) => { try { return JSON.parse(l).date !== date; } catch { return false; } })
    : [];
  kept.push(JSON.stringify(scorecard));
  fs.writeFileSync(scFile, kept.join("\n") + "\n");

  // 8) READ-THESE dump (flagged + all dnc + all goal_met) + suggested relabel map
  const wantRead = new Map();
  const addRead = (id, outcome, reason) => {
    const e = wantRead.get(id) || { outcome, reasons: [] };
    e.reasons.push(reason);
    wantRead.set(id, e);
  };
  for (const f of flags) addRead(f.id, f.outcome, `${f.type}: ${f.reason}`);
  for (const r of dncRows) addRead(r.id, "dnc", "always-read: all dnc");
  for (const r of byOutcome.goal_met || []) addRead(r.id, "goal_met", "always-read: all goal_met");

  const readIds = [...wantRead.keys()];
  const dumpById = {};
  for (let i = 0; i < readIds.length; i += 60) {
    const ds = await C.get(`calls?id=in.(${C.inList(readIds.slice(i, i + 60))})&select=id,duration_seconds,outcome_source,summary,transcript_json,lead_id`);
    for (const d of ds) dumpById[d.id] = d;
  }
  const leadOfRead = [...new Set(readIds.map((id) => dumpById[id] && dumpById[id].lead_id).filter(Boolean))];
  const leadById = {};
  for (let i = 0; i < leadOfRead.length; i += 100) {
    const ls = await C.get(`leads?id=in.(${C.inList(leadOfRead.slice(i, i + 100))})&select=id,company,status,calendly_event_uri`);
    for (const l of ls) leadById[l.id] = l;
  }
  let out = `TRIAGE READ LIST — ${date} (ET) — ${readIds.length} calls (flagged + all dnc + all goal_met)\n`;
  for (const [id, meta] of wantRead) {
    const d = dumpById[id] || {};
    const lead = leadById[d.lead_id] || {};
    out += `\n${"=".repeat(88)}\ncall=${id} outcome=${meta.outcome} dur=${d.duration_seconds}s src=${d.outcome_source} lead=${lead.company ?? "?"} calendly=${lead.calendly_event_uri ? "YES" : "no"}\n`;
    out += `WHY: ${meta.reasons.join(" | ")}\n`;
    out += `summary: ${(d.summary ?? "").replace(/\s+/g, " ").trim()}\n--- transcript ---\n`;
    for (const t of d.transcript_json || []) {
      const m = (t.message ?? "").replace(/\s+/g, " ").trim();
      if (m) out += `${t.role === "user" ? "LEAD " : "AGENT"}: ${m}\n`;
    }
  }
  const dumpFile = path.join(__dirname, `_out-triage-${date}.txt`);
  fs.writeFileSync(dumpFile, out);

  // suggested map — high-confidence structural suggestions only; gitignored (map*.json)
  const suggested = {};
  for (const f of flags) if (f.suggest) suggested[f.id] = { to: f.suggest, from: f.outcome };
  const mapFile = path.join(__dirname, `map-triage-${date}.json`);
  fs.writeFileSync(mapFile, JSON.stringify(suggested, null, 2));

  console.log(`\nREAD:  ${path.basename(dumpFile)}  (${readIds.length} calls)`);
  console.log(`MAP:   ${path.basename(mapFile)}  (${Object.keys(suggested).length} high-confidence — review, then: node relabel.js ${path.basename(mapFile)}  → --apply)`);
  console.log(`scorecard.jsonl updated for ${date}.`);
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
```

- [ ] **Step 2: Smoke-run against the real 08-12 day (read-only) and verify the numbers**

Run: `node .claude/skills/daily-outcome-audit/scripts/triage.js 2026-08-12`

Expected (matches the grounding analysis; small voicemail-flag variance is fine):
- `total calls: 3328`
- Scorecard shows `not_interested 55` with `flags 27`, `gatekeeper_not_interested 66` with `flags 3`, `goal_met 27`.
- `flags by type` includes `"not_interested_dm_not_yes":27` and `"gni_dm_yes":3`. (27 = the 20 `dm="no"` + 7 `dm="unknown"`; the flag correctly previews the Layer 2 guard, which downgrades every `not_interested` with `dm ≠ "yes"`.)
- `hidden-win goal_met (booked, not goal_met): 6`.
- `voicemail: sampled 60 of 1384 (skipped 1324)`.
- `ratios` includes `"not_interested_dm_no":0.491` (27/55).
- Files written: `_out-triage-2026-08-12.txt`, `map-triage-2026-08-12.json` (27 entries), and a line appended to `scorecard.jsonl`.

If `not_interested_dm_not_yes` ≠ 27, STOP — the flag logic diverged from the grounding pass; re-check `_flags.js` `dmOf`.

- [ ] **Step 3: Seed the second baseline day**

Run: `node .claude/skills/daily-outcome-audit/scripts/triage.js 2026-08-11`

Expected: `total calls: 3140`, `not_interested 27` with `flags 0` (08-11 had zero `dm=no`), `hidden-win goal_met: 3`. `scorecard.jsonl` now has two lines (08-11, 08-12).

- [ ] **Step 4: Sanity-check the idempotency of scorecard.jsonl**

Run again: `node .claude/skills/daily-outcome-audit/scripts/triage.js 2026-08-11`
Then: `node -e "const fs=require('fs');const p='.claude/skills/daily-outcome-audit/scripts/scorecard.jsonl';const d=fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l).date);console.log(d, new Set(d).size===d.length?'OK no dupes':'DUPES')"`
Expected: `[ '2026-08-12', '2026-08-11' ] OK no dupes` (order may vary; the point is no duplicate 08-11).

- [ ] **Step 5: Commit** (scorecard.jsonl is committed as the drift baseline; the `_out-*.txt` and `map-*.json` are gitignored, so they won't be staged)

```bash
git add .claude/skills/daily-outcome-audit/scripts/triage.js .claude/skills/daily-outcome-audit/scripts/scorecard.jsonl
git status --short   # confirm no _out-triage-*.txt or map-triage-*.json are staged
git commit --no-verify -m "feat(skill): triage.js — signal pre-flagging + scorecard front door; seed 08-11/08-12 baseline"
```

---

## Task 4: Docs — rewrite the loop, playbook signals; remove audit-day.js

**Files:**
- Modify: `.claude/skills/daily-outcome-audit/SKILL.md`
- Modify: `.claude/skills/daily-outcome-audit/outcome-playbook.md`
- Modify: `.claude/skills/daily-outcome-audit/fix-patterns.md`
- Remove: `.claude/skills/daily-outcome-audit/scripts/audit-day.js`

- [ ] **Step 1: SKILL.md — replace the "The daily loop" fast-path line**

Find this line under `## The daily loop`:

```
**Fast path (all at once):** `node scripts/audit-day.js [YYYY-MM-DD]` does steps 1–4 in one read-only pass — credit health, every outcome's counts, booking reconciliation, and transcript dumps for the judgment outcomes — and prints what needs your eyes. Then jump to step 5 (fix) and 6 (harden). Use the per-step flow below when you want to drill into one outcome.
```

Replace it with:

```
**Fast path (all at once):** `node scripts/triage.js [YYYY-MM-DD]` does a read-only pass and prints a per-outcome **scorecard**, flags the ~40 calls whose label contradicts a signal the AI already recorded, and writes a **read list** (`_out-triage-<date>.txt` — the flagged calls + all dnc + all goal_met) plus a **suggested relabel map** (`map-triage-<date>.json`, high-confidence structural only, NEVER auto-applied). It also appends one line per day to `scorecard.jsonl` (drift history). Read the read-list, then jump to step 5 (fix) and 6 (harden). Use `audit-outcome.js <outcome>` to drill into one outcome.
```

- [ ] **Step 2: SKILL.md — repoint step 2 of the numbered loop**

Find:

```
2. **Pull the outcome** — `node scripts/audit-outcome.js <outcome>` (defaults to yesterday ET). Dumps counts, per-campaign split, booking/tool signals, and readable transcripts.
```

Replace with:

```
2. **Triage the day** — `node scripts/triage.js` (defaults to yesterday ET): scorecard + flags + read-list + suggested map + scorecard.jsonl. Read only the flagged calls (plus all dnc + all goal_met). Use `audit-outcome.js <outcome>` to drill into a single outcome.
```

- [ ] **Step 3: SKILL.md — update the quick-reference `(null)` row note is unchanged; add a triage note under the table**

Immediately AFTER the table block that ends with the `(null)` row and the line `Full recipes: **`outcome-playbook.md`**. Fix mechanics + safety: **`fix-patterns.md`**.`, add a new paragraph:

```
**Triage flags (what `triage.js` surfaces):** `not_interested` with `decision_maker_reached ≠ "yes"` → likely `gatekeeper_not_interested`; `gatekeeper_not_interested` with `dm="yes"` → read; `goal_met` with no booking → false win; `callback` with no time and no `callbacks` row → stranded; `dnc` where an **agent** offered removal → agent-manufactured; sampled `voicemail` with ≥2 human replies → human-then-mailbox; null outcome on a completed call → stranded. `decision_maker_reached` is a **string enum** (`yes`/`no`/`unknown`/absent), NOT a boolean.
```

- [ ] **Step 4: SKILL.md — drop audit-day.js from any script mention**

Search `SKILL.md` for `audit-day` (there should be no remaining references after Steps 1–2). Run:
`grep -n "audit-day" .claude/skills/daily-outcome-audit/SKILL.md`
Expected: no matches. If any remain, remove/repoint them to `triage.js`.

- [ ] **Step 5: outcome-playbook.md — add the objective-signals note at the top**

After the opening paragraph block (the one ending `Always check `outcome_source` — don't re-litigate manual rows.`), insert:

```

## Objective cross-field signals (what triage flags)

`triage.js` pre-flags calls whose label contradicts a signal the AI already recorded, so you read the ~40 suspects, not the whole day. `decision_maker_reached` is a **string enum** — `"yes"` / `"no"` / `"unknown"` / absent (NOT a boolean; don't test it with `=== true`).

| Flag | Meaning |
|---|---|
| `not_interested` + `dm ≠ "yes"` | owner-decline label without a confirmed owner → usually `gatekeeper_not_interested`. **Phase 2 enforces this in the classifier;** until deployed, triage suggests the relabel. |
| `gatekeeper_not_interested` + `dm = "yes"` | reached the owner but labeled a gatekeeper decline — read it. |
| `goal_met` + no booking | false win / failed booking (see the goal_met recipe). |
| `callback` + no `callback_datetime` + no `callbacks` row | stranded — the dialer has no time to dial. |
| `dnc` + an **agent** offered removal | agent-manufactured DNC — read every one. |
| `voicemail` (sampled) + ≥2 human replies | a human answered, then a mailbox → `gatekeeper`. |

```

- [ ] **Step 6: fix-patterns.md — note the triage-seeded map under §1**

At the END of section `## 1. Relabel a call + move the lead` (right after the paragraph describing `scripts/relabel.js`), append:

```

`triage.js` writes a **suggested** map (`map-triage-<date>.json`) pre-filled with the high-confidence structural relabels (e.g. `not_interested`+`dm≠yes` → `gatekeeper_not_interested`). It is a draft: review it, then `node relabel.js map-triage-<date>.json` (dry-run) → `--apply`. Never apply it unread.
```

- [ ] **Step 7: Remove the superseded script**

```bash
git rm .claude/skills/daily-outcome-audit/scripts/audit-day.js
```

- [ ] **Step 8: Verify no dangling references**

Run: `grep -rn "audit-day" .claude/skills/daily-outcome-audit/`
Expected: no matches.

- [ ] **Step 9: Commit**

```bash
git add .claude/skills/daily-outcome-audit/SKILL.md .claude/skills/daily-outcome-audit/outcome-playbook.md .claude/skills/daily-outcome-audit/fix-patterns.md
git commit --no-verify -m "docs(skill): make triage.js the front door; document objective flags; retire audit-day.js"
```

---

## Task 5: Final verification

- [ ] **Step 1: Re-run the unit tests together**

Run: `node --test .claude/skills/daily-outcome-audit/scripts/_signals.test.js .claude/skills/daily-outcome-audit/scripts/_flags.test.js`
Expected: `# tests 16`, `# pass 16`, `# fail 0`. (List the files explicitly — `node --test <dir>` with an absolute path can misreport a spurious single failure on some Node versions.)

- [ ] **Step 2: Confirm the read list is human-sized**

Run: `node -e "const fs=require('fs');const f='.claude/skills/daily-outcome-audit/scripts/_out-triage-2026-08-12.txt';console.log((fs.readFileSync(f,'utf8').match(/^call=/gm)||[]).length,'calls in the 08-12 read list')"`
Expected: on the order of ~120 (20 not_interested + 3 gni + 6-ish goal_met + callbacks + dnc + all-goal_met + voicemail-human) — i.e. dozens, not thousands. The exact number isn't load-bearing; it must be small enough to read.

- [ ] **Step 3: Confirm the working tree is clean of scratch outputs**

Run: `git status --short`
Expected: clean (the `_out-triage-*.txt` and `map-triage-*.json` are gitignored; `scorecard.jsonl` is already committed).

---

## Self-review notes (author)

- **Spec coverage:** Layer 1 flags (all 8) → Task 2/3. Scorecard + `scorecard.jsonl` write (Layer 3's WRITE half) → Task 3. Voicemail sampling with skip-count printed → Task 3 Step 2. Suggested-map-not-auto-applied → Task 3. `audit-day.js` retired, docs repointed → Task 4. Drift COMPARE and the classifier guard are deliberately Phases 2–3, out of this plan.
- **Not covered here (by design):** the `not_interested→gatekeeper_not_interested` code guard + tests (Phase 2), the historical relabel (Phase 2), the drift-vs-baseline compare (Phase 3), the calibration loop (Phase 4).
- **Type consistency:** flag `type` strings are identical across `_flags.js`, its tests, `triage.js`, and the docs (`not_interested_dm_not_yes`, `gni_dm_yes`, `goal_met_no_booking`, `callback_no_time`, `null_outcome`, `dnc_agent_offer`, `voicemail_has_human`). The suggested-map format `{to, from}` matches `relabel.js`'s accepted per-call object.
- **No app deploy:** Phase 1 is skill-scripts + docs only — no `tsc`/`build`, no Vercel. Everything is read-only against prod.
