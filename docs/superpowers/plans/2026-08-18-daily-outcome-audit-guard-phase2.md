# Daily Outcome Audit — Phase 2 (not_interested source guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop `not_interested` from over-claiming at the source: a call stays `not_interested` only when the AI confirmed it reached the owner; otherwise it becomes `gatekeeper_not_interested`.

**Architecture:** A deterministic guard at the end of `classifyCallOutcome` (pure, unit-tested), fed the extractor's `decision_maker_reached` value threaded from the post-call webhook. It mirrors `decision-maker.ts`'s existing `OUTCOME_EXCLUDES_DM` veto — the symmetric move. After it, a downgraded call is `gatekeeper_not_interested` (15d rest, not DM-implying) instead of `not_interested` (30d rest, DM-implying).

**Tech Stack:** TypeScript, Vitest (`tests/*.unit.test.ts`), Next.js App Router (the webhook is a route handler — the change there is a single added argument, no framework surface touched).

**Spec:** `docs/superpowers/specs/2026-08-18-daily-outcome-audit-accuracy-design.md` (Layer 2).

**Branch:** `feat/audit-not-interested-guard-phase2` (off `origin/main`, which has Phase 1 + #398).

---

## Key design decision — treat MISSING dm as "leave alone"

The guard downgrades **only when a dm value is present and isn't `"yes"`** (i.e. explicitly `"no"`/`"unknown"`). A missing/undefined dm leaves `not_interested` unchanged. Why:
- It catches 100% of the real cases — on 08-12, `not_interested` had `dm` ∈ {yes:28, no:20, unknown:7, **absent:0**}. The extractor always populates it for a real `not_interested`.
- It only acts on **positive non-owner evidence**, never on missing data.
- It keeps every existing `classify-outcome.unit.test.ts` case green (those pass `not_interested` with no dm → no downgrade).

## Files

- Modify: `src/lib/calls/classify-outcome.ts` — add optional `decisionMakerReached?: unknown` to the input; add the guard before the `reachedHuman` computation.
- Modify: `src/lib/elevenlabs/post-call-webhook.ts:853` — pass `decisionMakerReached: extractedDataOf(payload.analysis)?.decision_maker_reached`.
- Modify: `tests/classify-outcome.unit.test.ts` — add a `not_interested owner guard` describe block.
- Modify: `scripts/backfill-dm-not-interested.mjs` — update the header comment for the new invariant (still functions; post-guard `not_interested` is `dm="yes"`).

---

## Task 1: The guard + tests (TDD)

- [ ] **Step 1: Baseline — run the existing suite green first**

Run: `npx vitest run tests/classify-outcome.unit.test.ts tests/decision-maker-derivation.unit.test.ts`
Expected: all pass (establishes the change didn't regress anything).

- [ ] **Step 2: Add the failing tests**

In `tests/classify-outcome.unit.test.ts`, before the final closing `});` of the top `describe`, add:

```ts
  describe("not_interested owner guard", () => {
    const reached = t(
      ["agent", "Hi, is the owner around?"],
      ["user", "This is the front desk, who's calling?"],
      ["agent", "It's Tom from HireAI..."],
      ["user", "We're not interested, thanks."],
    );
    const base = {
      transcript: reached,
      disposition: "not_interested",
      terminationReason: "Call ended by remote party",
      callDurationSecs: 40,
    };

    it("keeps not_interested when the AI reached the owner (dm=yes)", () => {
      const r = classifyCallOutcome({ ...base, decisionMakerReached: "yes" });
      expect(r.outcome).toBe("not_interested");
      expect(r.reachedHuman).toBe(true);
    });

    it("downgrades to gatekeeper_not_interested when dm=no", () => {
      const r = classifyCallOutcome({ ...base, decisionMakerReached: "no" });
      expect(r.outcome).toBe("gatekeeper_not_interested");
      expect(r.reachedHuman).toBe(true);
    });

    it("downgrades when dm=unknown (or padded/upper-cased)", () => {
      expect(classifyCallOutcome({ ...base, decisionMakerReached: "unknown" }).outcome).toBe("gatekeeper_not_interested");
      expect(classifyCallOutcome({ ...base, decisionMakerReached: " No " }).outcome).toBe("gatekeeper_not_interested");
    });

    it("leaves not_interested unchanged when dm is missing (backward compatible)", () => {
      expect(classifyCallOutcome(base).outcome).toBe("not_interested");
    });

    it("only touches not_interested — a gatekeeper with dm=no stays gatekeeper", () => {
      const r = classifyCallOutcome({ ...base, disposition: "gatekeeper", decisionMakerReached: "no" });
      expect(r.outcome).toBe("gatekeeper");
    });
  });
```

- [ ] **Step 3: Run tests to verify the new ones fail**

Run: `npx vitest run tests/classify-outcome.unit.test.ts -t "not_interested owner guard"`
Expected: the `dm=no` / `dm=unknown` cases FAIL (currently return `not_interested`); the `dm=yes` / missing / gatekeeper cases pass.

- [ ] **Step 4: Add the input field**

In `src/lib/calls/classify-outcome.ts`, change the `classifyCallOutcome` input type and destructuring:

```ts
export function classifyCallOutcome(input: {
  transcript: unknown;
  disposition: string;
  terminationReason: string;
  callDurationSecs: number;
  decisionMakerReached?: unknown;
}): { outcome: CallOutcome | null; reachedHuman: boolean } {
  const {
    transcript,
    disposition,
    terminationReason,
    callDurationSecs,
    decisionMakerReached,
  } = input;
```

- [ ] **Step 5: Add the guard**

In the same file, immediately AFTER the `if (outcome == null) { ... }` final-fallback block and BEFORE the `// A real two-way human conversation?` / `const reachedHuman =` block, insert:

```ts
  // not_interested is owner-only by definition — it rests the lead 30d and implies
  // decision_maker_reached (OUTCOME_IMPLIES_DM). If the extractor itself reported it
  // did NOT reach the owner (decision_maker_reached "no"/"unknown"), the decliner was
  // never established as the owner: downgrade to a firm gatekeeper decline (15d rest,
  // NOT DM-implying). Mirrors OUTCOME_EXCLUDES_DM's veto of a stray dm="yes" on a
  // gatekeeper. A MISSING value is left alone — we act only on positive non-owner
  // evidence, and the extractor always populates this for a real not_interested.
  const dm =
    typeof decisionMakerReached === "string"
      ? decisionMakerReached.trim().toLowerCase()
      : "";
  if (outcome === "not_interested" && dm !== "" && dm !== "yes") {
    outcome = "gatekeeper_not_interested";
  }
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `npx vitest run tests/classify-outcome.unit.test.ts tests/decision-maker-derivation.unit.test.ts`
Expected: all pass (new guard block + every pre-existing case).

- [ ] **Step 7: Commit**

```bash
git add src/lib/calls/classify-outcome.ts tests/classify-outcome.unit.test.ts
git commit --no-verify -m "feat(calls): not_interested requires a reached owner, else gatekeeper_not_interested"
```

---

## Task 2: Thread dm from the webhook + fix the backfill comment

- [ ] **Step 1: Pass the value at the call site**

In `src/lib/elevenlabs/post-call-webhook.ts` (~line 853), add the argument:

```ts
  const { outcome: outcomeFromDisposition, reachedHuman } = classifyCallOutcome({
    transcript: payload.transcript,
    disposition,
    terminationReason,
    callDurationSecs,
    decisionMakerReached: extractedDataOf(payload.analysis)?.decision_maker_reached,
  });
```

- [ ] **Step 2: Confirm no other caller needs the arg**

Run: `grep -rn "classifyCallOutcome(" src/ | grep -v "export function"`
Expected: only the webhook call site (the arg is optional, so any other caller still compiles).

- [ ] **Step 3: Update the backfill script's header comment**

In `scripts/backfill-dm-not-interested.mjs`, the top comment asserts "any lead with a `not_interested` call always reached the decision-maker." Append one line after that rationale:

```
// NOTE (Phase 2, 2026-08-18): the classifier now downgrades a not_interested whose
// extractor said decision_maker_reached != "yes" to gatekeeper_not_interested, so
// going forward a surviving not_interested IS dm=yes — this backfill stays valid,
// but it only matters for PRE-guard history.
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/elevenlabs/post-call-webhook.ts scripts/backfill-dm-not-interested.mjs
git commit --no-verify -m "feat(webhook): feed decision_maker_reached to the classifier; note the new not_interested invariant"
```

---

## Task 3: Verify, PR, merge, deploy

- [ ] **Step 1: Type-check, lint, targeted tests**

```bash
npx tsc --noEmit
npx eslint src/lib/calls/classify-outcome.ts src/lib/elevenlabs/post-call-webhook.ts tests/classify-outcome.unit.test.ts
npx vitest run tests/classify-outcome.unit.test.ts tests/decision-maker-derivation.unit.test.ts tests/elevenlabs-post-call.spec.ts
```
Expected: tsc clean, eslint clean, all tests pass. (If `elevenlabs-post-call.spec.ts` asserts a `not_interested` outcome with a dm≠yes payload, update that expectation to `gatekeeper_not_interested` — it's the intended behavior.)

- [ ] **Step 2: Build**

Run: `npx next build`
Expected: build succeeds. (Consult `node_modules/next/dist/docs/` only if the build surfaces a framework issue — this change adds one function argument, no routing/RSC/caching surface.)

- [ ] **Step 3: Push + PR**

```bash
git push -u origin feat/audit-not-interested-guard-phase2
gh pr create --repo marieilievska/smile-and-dial --base main --title "Daily outcome audit — Phase 2: not_interested owner guard" --body "<summary + test plan + the metric consequence>"
```

- [ ] **Step 4: Merge + let Vercel deploy**

`gh pr merge <N> --repo marieilievska/smile-and-dial --squash`. Vercel auto-deploys `main`. **This is a real behavior change** — new calls classify differently from the moment it deploys.

---

## Task 4: Historical relabel (SEPARATE, GATED — do after deploy)

The guard fixes the future. The 08-11/08-12 data (old agents) is still mislabeled. This is a one-time, bounded correction that **writes to prod**, so it runs only after Marija's explicit OK.

- [ ] **Step 1: Regenerate the suggested map** — `node .claude/skills/daily-outcome-audit/scripts/triage.js 2026-08-12` → `map-triage-2026-08-12.json` (the 27 `not_interested`+dm≠yes → gatekeeper_not_interested).
- [ ] **Step 2: Surface the campaign-merge interaction.** The old campaign was ended + merged into the new draft (EL workspace switch). Confirm the affected leads' current campaign/state before moving them, and confirm the 15d-rest change is what we want for leads now under the new draft. Present the dry-run counts to Marija.
- [ ] **Step 3: Dry-run** — `node .claude/skills/daily-outcome-audit/scripts/relabel.js map-triage-2026-08-12.json` (prints current outcome + planned lead state; refuses any call not currently `not_interested`).
- [ ] **Step 4: Apply on Marija's OK** — `... --apply`. Then re-run `triage.js 2026-08-12` and confirm `not_interested_dm_not_yes` flags drop to 0.

---

## Notes

- **No migration.** Pure code + tests; nothing changes the DB schema.
- **Sequencing:** ship + deploy the guard (Tasks 1–3) BEFORE the historical relabel (Task 4) — the house rule for a scheduling-affecting change.
- **Calibration tie-in:** once the new agent (`agent_8801…`) dials, Phase 4's control sample confirms whether the guard still fits its `decision_maker_reached` behavior.
