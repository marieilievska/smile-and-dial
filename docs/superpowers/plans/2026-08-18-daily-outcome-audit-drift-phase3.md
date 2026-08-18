# Daily Outcome Audit — Phase 3 (Drift Watch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Each triage run compares the day's scorecard ratios to a trailing baseline and prints a DRIFT warning when a watched metric moves beyond its threshold — catching a behavioral shift (agent/campaign change) the day it happens.

**Architecture:** A new pure `_drift.js` (`driftReport(today, history)` → flags, mirroring the `_signals.js`/`_flags.js` pattern; unit-tested with `node:test`) wired into `triage.js` section 7, which already reads/writes `scorecard.jsonl`. No app code; the scorecard write from Phase 1 already supplies the history.

**Spec:** `docs/superpowers/specs/2026-08-18-daily-outcome-audit-accuracy-design.md` (Layer 3).

**Branch:** `feat/audit-drift-watch-phase3` (off `origin/main`, which has Phases 1 + 2).

---

## Design

- **Baseline** = median of each watched ratio across the last `lookback=5` prior audited days (by date, excluding today). Median is robust to a single outlier day.
- **Minimum history** = 2 prior days; with fewer, print "baseline building" (no flags).
- **Watches** (per-metric thresholds):
  - shares (fraction 0..1): flag when `|today − baseline| ≥ threshold`.
    - `not_interested_dm_no` 0.15 · `ai_receptionist_share` 0.01 · `callback_share` 0.10 · `connect_rate` 0.15
  - counts (`goal_met`, `dnc`): flag when `baseline ≥ 3` and today ≥ 2×baseline or ≤ 0.5×baseline (a doubling/halving on a non-trivial base; avoids noise on tiny counts).
- Would have caught: `not_interested_dm_no` 0→0.49 (Δ0.49 ≥ 0.15) and `ai_receptionist_share` 0.002→0.017 (Δ0.015 ≥ 0.01).

## Files

- Create: `.claude/skills/daily-outcome-audit/scripts/_drift.js` + `_drift.test.js`.
- Modify: `.claude/skills/daily-outcome-audit/scripts/triage.js` — section 7 prints drift before the idempotent write.
- Modify: `.claude/skills/daily-outcome-audit/SKILL.md` — one line noting the drift check.

---

## Task 1: `_drift.js` (TDD)

**Files:** Create `_drift.js`, `_drift.test.js`.

- [ ] **Step 1: Write the failing test** — create `_drift.test.js`:

```js
const { test } = require("node:test");
const assert = require("node:assert");
const D = require("./_drift");

const day = (date, ratios) => ({ date, ratios });

test("median: odd, even, empty", () => {
  assert.equal(D.median([3, 1, 2]), 2);
  assert.equal(D.median([1, 2, 3, 4]), 2.5);
  assert.equal(D.median([]), null);
});

test("baseline building with <2 prior days", () => {
  const r = D.driftReport({ today: day("2026-08-12", { not_interested_dm_no: 0.49 }), history: [day("2026-08-11", { not_interested_dm_no: 0 })] });
  assert.equal(r.baselineBuilding, true);
  assert.equal(r.flags.length, 0);
});

test("flags a big share jump (not_interested_dm_no 0.02 baseline -> 0.49)", () => {
  const hist = [day("d1", { not_interested_dm_no: 0.02 }), day("d2", { not_interested_dm_no: 0.03 }), day("d3", { not_interested_dm_no: 0.01 })];
  const r = D.driftReport({ today: day("d4", { not_interested_dm_no: 0.49 }), history: hist });
  assert.equal(r.baselineBuilding, false);
  const f = r.flags.find((x) => x.key === "not_interested_dm_no");
  assert.ok(f && f.direction === "up");
});

test("does NOT flag a small share wobble", () => {
  const hist = [day("d1", { callback_share: 0.06 }), day("d2", { callback_share: 0.07 })];
  const r = D.driftReport({ today: day("d3", { callback_share: 0.09 }), history: hist });
  assert.equal(r.flags.find((x) => x.key === "callback_share"), undefined);
});

test("flags a tiny ai_receptionist share jump (0.002 -> 0.017)", () => {
  const hist = [day("d1", { ai_receptionist_share: 0.002 }), day("d2", { ai_receptionist_share: 0.002 }), day("d3", { ai_receptionist_share: 0.003 })];
  const r = D.driftReport({ today: day("d4", { ai_receptionist_share: 0.017 }), history: hist });
  assert.ok(r.flags.find((x) => x.key === "ai_receptionist_share"));
});

test("flags a count halving (goal_met 21 baseline -> 4) but not on a tiny base", () => {
  const big = D.driftReport({ today: day("d4", { goal_met: 4 }), history: [day("d1", { goal_met: 20 }), day("d2", { goal_met: 22 }), day("d3", { goal_met: 21 })] });
  assert.ok(big.flags.find((x) => x.key === "goal_met" && x.direction === "down"));
  const tiny = D.driftReport({ today: day("d4", { goal_met: 6 }), history: [day("d1", { goal_met: 1 }), day("d2", { goal_met: 2 }), day("d3", { goal_met: 1 })] });
  assert.equal(tiny.flags.find((x) => x.key === "goal_met"), undefined);
});

test("uses only the last `lookback` prior days and excludes today's own date", () => {
  const hist = [
    day("2026-08-05", { connect_rate: 0.9 }), // old, outside lookback=5
    day("2026-08-06", { connect_rate: 0.4 }),
    day("2026-08-07", { connect_rate: 0.4 }),
    day("2026-08-08", { connect_rate: 0.4 }),
    day("2026-08-09", { connect_rate: 0.4 }),
    day("2026-08-10", { connect_rate: 0.4 }),
    day("2026-08-11", { connect_rate: 0.41, }),
  ];
  // today re-runs an existing date; its own prior line must be excluded.
  const r = D.driftReport({ today: day("2026-08-11", { connect_rate: 0.41 }), history: hist });
  // baseline from the 5 most recent non-today days (all ~0.4), today 0.41 → no drift.
  assert.equal(r.flags.find((x) => x.key === "connect_rate"), undefined);
});
```

- [ ] **Step 2: Run — expect failure** — `node --test .claude/skills/daily-outcome-audit/scripts/_drift.test.js` → `Cannot find module './_drift'`.

- [ ] **Step 3: Implement** — create `_drift.js`:

```js
// Trailing-baseline drift detector for the audit scorecard. PURE — unit-tested.
// Compares today's ratios to the median of the last N prior audited days and
// flags any watched metric that moved beyond its threshold. Read aid only; it
// never changes data — it points the reviewer at a behavioral shift.

const DEFAULT_WATCHES = [
  { key: "not_interested_dm_no", kind: "share", threshold: 0.15, label: "not_interested with dm≠yes" },
  { key: "ai_receptionist_share", kind: "share", threshold: 0.01, label: "ai_receptionist share" },
  { key: "callback_share", kind: "share", threshold: 0.1, label: "callback share" },
  { key: "connect_rate", kind: "share", threshold: 0.15, label: "connect rate" },
  { key: "goal_met", kind: "count", label: "goal_met count" },
  { key: "dnc", kind: "count", label: "dnc count" },
];

function median(xs) {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** flag → human string, count vs share formatted. */
function fmt(f) {
  const v = f.kind === "count" ? (x) => String(x) : (x) => Number(x).toFixed(3);
  return `${f.label} ${v(f.today)} vs baseline ${v(f.baseline)} (${f.direction})`;
}

function driftReport({ today, history, watches = DEFAULT_WATCHES, lookback = 5, minHistory = 2 }) {
  const prior = (history || [])
    .filter((h) => h && h.date && h.date !== today.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // newest first
    .slice(0, lookback);
  if (prior.length < minHistory) {
    return { baselineBuilding: true, priorDays: prior.length, flags: [] };
  }
  const flags = [];
  for (const w of watches) {
    const todayVal = today.ratios?.[w.key];
    if (typeof todayVal !== "number") continue;
    const baseline = median(prior.map((h) => h.ratios?.[w.key]));
    if (baseline == null) continue;
    let flagged = false;
    if (w.kind === "share") {
      flagged = Math.abs(todayVal - baseline) >= w.threshold;
    } else {
      flagged = baseline >= 3 && (todayVal >= 2 * baseline || todayVal <= 0.5 * baseline);
    }
    if (flagged) {
      flags.push({ key: w.key, label: w.label, kind: w.kind, today: todayVal, baseline, direction: todayVal >= baseline ? "up" : "down" });
    }
  }
  return { baselineBuilding: false, priorDays: prior.length, flags };
}

module.exports = { driftReport, median, fmt, DEFAULT_WATCHES };
```

- [ ] **Step 4: Run — expect pass** — `node --test .claude/skills/daily-outcome-audit/scripts/_drift.test.js` → all pass.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/daily-outcome-audit/scripts/_drift.js .claude/skills/daily-outcome-audit/scripts/_drift.test.js
git commit --no-verify -m "feat(skill): _drift.js — trailing-baseline drift detector for the scorecard"
```

---

## Task 2: Wire drift into `triage.js`

**Files:** Modify `triage.js`.

- [ ] **Step 1: Replace section 7** — swap the existing block (the `// 7) scorecard.jsonl — idempotent...` comment through the `fs.writeFileSync(scFile, ...)` line) with:

```js
  // 7) drift check vs trailing baseline, then idempotent scorecard write
  const D = require("./_drift");
  const scFile = path.join(__dirname, "scorecard.jsonl");
  const scorecard = { date, total: rows.length, byOutcome: Object.fromEntries(Object.entries(byOutcome).map(([o, rs]) => [o, rs.length])), flags: flagByType, ratios };
  const priorLines = fs.existsSync(scFile) ? fs.readFileSync(scFile, "utf8").split("\n").filter(Boolean) : [];
  const priorScorecards = priorLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const drift = D.driftReport({ today: scorecard, history: priorScorecards });
  console.log(`\ndrift vs trailing baseline (${drift.priorDays} prior day${drift.priorDays === 1 ? "" : "s"}):`);
  if (drift.baselineBuilding) {
    console.log(`  baseline building — need ≥2 prior audited days for a drift check.`);
  } else if (!drift.flags.length) {
    console.log(`  ✓ no watched metric moved beyond its threshold.`);
  } else {
    for (const f of drift.flags) console.log(`  ⚠️ DRIFT: ${D.fmt(f)} — check for an agent/campaign change.`);
  }
  // idempotent write: drop any existing line for this date, then append.
  const kept = priorLines.filter((l) => { try { return JSON.parse(l).date !== date; } catch { return false; } });
  kept.push(JSON.stringify(scorecard));
  fs.writeFileSync(scFile, kept.join("\n") + "\n");
```

- [ ] **Step 2: Smoke run (08-12)** — `node .claude/skills/daily-outcome-audit/scripts/triage.js 2026-08-12`
  Expected: prints `drift vs trailing baseline (1 prior day): baseline building — need ≥2 prior audited days...` (only 08-11 precedes it). Scorecard still written; no crash.

- [ ] **Step 3: Synthetic multi-day check** — prove the DRIFT path fires with ≥2 prior days:
  `node -e "const D=require('./.claude/skills/daily-outcome-audit/scripts/_drift');const h=[{date:'a',ratios:{not_interested_dm_no:0.02}},{date:'b',ratios:{not_interested_dm_no:0.03}}];console.log(JSON.stringify(D.driftReport({today:{date:'c',ratios:{not_interested_dm_no:0.49}},history:h}).flags))"`
  Expected: a JSON array with a `not_interested_dm_no` flag, `direction:"up"`.

- [ ] **Step 4: Confirm scorecard.jsonl unchanged in content** — after the smoke run, `scorecard.jsonl` still has exactly the 08-11 and 08-12 lines (re-running 08-12 replaces its own line). `git diff --stat` should show no change to `scorecard.jsonl` (same content).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/daily-outcome-audit/scripts/triage.js
git commit --no-verify -m "feat(skill): triage prints drift vs trailing baseline before writing the scorecard"
```

---

## Task 3: Docs, verify, PR, merge

- [ ] **Step 1: SKILL.md** — in the fast-path paragraph, change "appends one line per day to `scorecard.jsonl` (drift history)" to "appends one line per day to `scorecard.jsonl` and **flags drift** vs the trailing baseline (a metric that jumped since prior days)."

- [ ] **Step 2: Run all skill unit tests** — `node --test .claude/skills/daily-outcome-audit/scripts/_signals.test.js .claude/skills/daily-outcome-audit/scripts/_flags.test.js .claude/skills/daily-outcome-audit/scripts/_drift.test.js` → all pass.

- [ ] **Step 3: Commit docs** — `git add .claude/skills/daily-outcome-audit/SKILL.md && git commit --no-verify -m "docs(skill): note the drift check in the daily loop"`.

- [ ] **Step 4: PR + merge** — push; `gh pr create ... --title "Daily outcome audit — Phase 3: drift watch"`; squash-merge. Skill-only; nothing deploys.

## Notes

- Read-only: drift only prints; it never writes data. The scorecard write is unchanged behavior from Phase 1 (still idempotent per date).
- With calling stopped, real drift output stays "baseline building" until ≥2 audited days accrue again — the value lands when calling resumes (and feeds Phase 4 calibration).
