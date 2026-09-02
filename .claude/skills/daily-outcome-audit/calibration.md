# Calibration Loop

Triage is a **heuristic**. Before trusting its flags for daily use, prove them over the first few real operating days — and keep proving them periodically. Each calibration day measures the triage two ways and feeds what it learns back into the flags. Accuracy should visibly climb.

- **Precision** — of the calls triage *flagged*, how many were genuine mislabels? (a flag that cries wolf gets tightened)
- **Recall** — did triage *miss* any? Read a random spread of calls it did **not** flag. (a miss = a blind spot → add or widen a flag)

Without the recall check, a triage that flags too little looks "clean" while quietly missing errors. That's the whole point of this loop.

## Run a calibration day

1. **Audit as normal** — `node scripts/triage.js [YYYY-MM-DD]`, read the flagged read-list, build + apply the relabel map (dry-run → `--apply`).
2. **Precision** — as you read the flagged calls, tally how many were genuine vs false alarms. A flag type that's mostly false alarms: tighten its rule in `scripts/_flags.js` (or its threshold).
3. **Recall (the key step)** — `node scripts/control-sample.js [YYYY-MM-DD] [N]` (default N=25). It dumps a spread of CONNECTED conversation calls triage did **not** flag. Read them. **Any mislabel you find is a blind spot** → design a new flag or widen an existing one in `_flags.js`, re-run triage, confirm it now catches it.
4. **Tune** — adjust the drift thresholds in `scripts/_drift.js` and the voicemail sample size in `triage.js` against what the day showed.
5. **Log it** — add a row to the table below: date, #flagged, flag precision, control-sample size + misses found, and the concrete change you made.

## When it's calibrated

After **~3 days** where the control sample turns up **≈0 new misses** and flag precision is stable, calibration ends — the skill is trusted for daily use. Then keep a lighter cadence: a weekly control sample. Each day should need fewer new flags than the last; that's the convergence signal.

## Where to start

- **Day 0 is available now:** 08-12 is a full raw ~3k-call day — `control-sample.js 2026-08-12` already works (pool ~924, sample 25).
- **The first 3 *live* days** (once outbound resumes on `agent_8801…`) confirm and extend it. The new agent may extract `decision_maker_reached` differently from the old ones this skill was tuned on, so the guard + flags must be re-confirmed against it — that is exactly what these days are for.

## Log

| Date | Flagged | Flag precision | Control N | Misses found | Change made |
|---|---|---|---|---|---|
| _(2026-08-12, day 0 — run when ready)_ | | | 25 | | |
| 2026-09-02 (live day 1 on agent_8801, run same day) | 5 (4 gni_dm_yes, 1 dnc_agent_offer) | 0/5 genuine — all 5 correctly labeled (gni_dm_yes = extractor stamps dm=yes for non-owner managers, veto contains it; dnc_agent_offer fired on the agent CONFIRMING a lead-initiated removal) | 15 | 0 | none to flags; noted dnc_agent_offer should ignore agent turns AFTER the lead already asked |
