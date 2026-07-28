# Connect rate & number management — Phase 1 design

**Date:** 2026-07-28
**Status:** approved, not yet implemented

## What we're building

Six changes that together raise the outbound connect rate by making each call
look like a local business calling, and stop the number pool from damaging
itself:

| #   | Change                                                                               | Type             |
| --- | ------------------------------------------------------------------------------------ | ---------------- |
| A   | Buying falls back across area codes (exact → metro → state), and supports Canada     | Code             |
| B   | A state-first buy planner that produces a real shopping list                         | Code             |
| C   | Number-health monitor judges a number against its _expected_ rate, not a fixed floor | SQL              |
| D   | Every call records which local-presence tier it was dialed on                        | Migration + code |
| E   | Per-number daily caps restored (80 mature / 20 warm-up start / 14 days)              | Config           |
| F   | Twilio Trust Hub playbook for the operator                                           | Doc              |

Phase 2 (not in this spec) is a **Numbers** tab in Reporting, built on the data D
starts collecting.

## The evidence this is based on

Measured against production on 2026-07-28 (337 outbound calls since the 07-27
reset; 33,472 leads). Samples are small — treat the call-level splits as
directional, not proven.

- **Connect rate 30.3%**, voicemail 62.6%, hard failures 6.5%. Of 102 connects,
  46 (45%) were `hung_up_immediately` — a caller-ID-trust signal.
- **Trust Hub is empty.** `GET /v1/CustomerProfiles` and `/v1/TrustProducts` on
  the live account both return zero results. No vetted business profile, no
  SHAKEN/STIR trust product, no Voice Integrity, no branded caller ID. Every call
  goes out with no verified business identity.
- **82.2% of calls use an out-of-state caller ID**; only 0.9% match the lead's
  area code exactly. Same-state numbers connected at 63.6% (n=11) vs 29.2%
  (n=325) out-of-state.
- **71.7% of leads are mobile** and hard-blocked by `pre_call_check`. The
  dialable universe is **9,475 leads** (7,768 US + 1,707 Canada) — about 32 days
  at the current 300/day campaign cap.
- **Canadian leads consumed 83% of the first 90 calls of the day** despite being
  5.1% of the list, because Atlantic time reaches "10:00 local" an hour before
  any US lead does. They connect at 13.1% vs 38–40% for US leads.
- **The 213 number was auto-rested for a false reason.** 88% of its 32 calls went
  to Canada (vs 18–20% for the other two numbers); its US sample is 4 calls. The
  health monitor read a lead-mix artifact as a reputation problem, rested a
  healthy number, and pushed its load onto the remaining two — which then ran
  ~150 calls/day each, over the carrier threshold.
- **There is no time-of-day effect in the US data.** 10:00 / 11:00 / 12:00
  lead-local are 38.7% / 40.4% / 38.8%. An apparent 10:00 penalty was entirely
  the Canadian leads sitting in that bucket. Calling hours are therefore **not**
  being changed.

### Why state-level presence, not area-code-level

Recomputed over dialable leads only. The largest single US area code (732 NJ) is
102 leads — the list is flat across 305 area codes:

| Numbers bought | Exact area-code match | Same-state match  |
| -------------- | --------------------- | ----------------- |
| 3 (today)      | 3.4%                  | —                 |
| 20             | 17.9%                 | 73.3% (20 states) |
| 25             | 21.5%                 | 81.0% (25 states) |
| 30             | 24.9%                 | 86.9% (30 states) |
| 100            | 60.2%                 | 94.7% (40 states) |

One number per state, placed in the area code where that state has the most
leads, buys ~81% same-state coverage at 25 numbers and doubles as an exact match
for each state's biggest pocket. Chasing exact coverage costs 100 numbers for
60%.

**Numbers are effectively free on this account.** The Twilio Pricing API reports
a negotiated US local rate of **$0.040/month** against a $1.15 list price, so 30
US numbers cost **~$1.20/month**. The `monthly_cost: 0.04` stored on existing
rows is correct, not a placeholder. **Canadian local numbers are not discounted —
$1.15/month**, so ~10 Canadian numbers is ~$11.50/month. Cost is not a constraint
on the US buy at any realistic size.

## Decisions

Each was chosen over a stated alternative.

**Fallback order is exact → same metro → same state/province.** The operator's
rule was "exact area code, else same state" (305 → 954). Plain same-state is too
coarse on its own: Florida spans Miami and Pensacola, 650 miles apart, so a
same-state fallback can hand a Miami lead a caller ID that is not plausibly
local. A compact metro table (~30 metros of overlay/adjacent area codes) sits
between the two tiers. Rejected: pure same-state (defeats the purpose for large
states); a full geographic distance model (needs lat/long per area code for
marginal gain over a metro table).

**The dial-time tier order already matches and is not changing.**
`pickPoolNumber` already does exact → same-state → any. The metro tier is added
there too so dial-time and buy-time agree.

**Canada is added to the NANP map rather than kept excluded.**
`nanp-states.ts` deliberately returns `null` for Canadian area codes, so the
same-state tier never fires for the 1,707 Canadian leads. Adding provinces makes
same-province selection work. This is a deliberate behavior change: Canadian
leads will start preferring same-province numbers once such numbers exist.

**Health monitoring switches to expected-rate comparison (indirect
standardization).** For each number, expected rate = the pool-wide connect rate
for each segment it dialed, weighted by how many calls it made into that segment.
Compare actual ÷ expected. Segment = destination country initially (extensible to
the local-match tier once D has data).

Applied to the 213 case: expected ≈ 0.88 × 0.13 + 0.12 × 0.38 ≈ 0.16, actual
0.107, ratio 0.67 — above the rest threshold, so the number is correctly left
alone. Rejected: pool-median comparison (213 was genuinely below the median — the
median doesn't know _why_); simply raising `rest_min_samples` (delays the false
positive rather than fixing it).

The absolute floor is kept as a backstop for when the pool is too small to
compute a trustworthy expectation (fewer than 3 numbers with `rest_min_samples`
calls).

**Caps go on after the numbers land, not before.** At 3 numbers, an 80/day cap
cuts throughput from 300 to ~156/day. At 25–30 numbers the same cap is entirely
non-binding against a 300/day campaign cap. Sequencing matters more than the
number itself.

**Mature cap 80, warm-up start 20, ramp 14 days.** Carriers flag above ~100/day
and filtering begins around 75–100; conservative operators stay under 50. 80
keeps headroom under the flag threshold. The current warm-up start of 50 is too
hot for a fresh number. Rejected: 100 (rides the threshold), 50 (needs 6 numbers
for today's volume for little extra safety).

**Calling hours, the mobile lock, and the retry cycle are untouched.** The mobile
lock is a TCPA control. The timing concern that would have justified changing
calling hours did not survive the confound check.

## Design

### A. Fallback buying (`src/lib/twilio/pool-actions.ts`, `numbers.ts`)

New pure helper `siblingAreaCodes(areaCode, country)` in a new
`src/lib/dialer/nanp-metros.ts`, returning candidates in order: metro peers, then
other area codes in the same state/province, excluding the input.

`addNumbersToPool` walks `[areaCode, ...siblingAreaCodes(...)]`, searching each
and accumulating candidates until it has `count`, then purchases. Per-number
best-effort is preserved. Return shape gains `byAreaCode: Record<string, number>`
so the UI can report "8 bought: 5 × 305, 3 × 786".

`searchAvailableNumbers` gains a `limit` parameter; `liveSearch` currently pins
`PageSize=10`, which is why a batch of up to `MAX_BATCH` (25) could never return
more than 10 candidates. Country becomes a parameter rather than a hardcoded
`"US"`.

**Canadian numbers require a validated local Canadian address** (P.O. boxes and
virtual addresses are rejected) and may require a regulatory bundle with ~2
business days of review. A purchase failing for this reason must surface a clear
message, not a generic "purchase failed".

### B. State-first planner (`src/lib/dialer/pool-plan.ts`)

`buildPoolPlan` suggests one entry per area code with any leads — 305 rows for
this list. Add `buildStatePlan`, grouping leads by state/province, and for each
recommending the area code holding the most leads in that state.

`suggestPoolPlan` returns `{ byState, byAreaCode }`. The buy dialog shows
`byState` by default; `byAreaCode` stays available for geo-concentrated campaigns
(the Miami case).

### C. Health monitor (`monitor_twilio_connect_rates()`)

Rewrite the rate comparison per the decision above. Thresholds move into the
existing `app_settings.number_pool_settings` jsonb:
`rest_expected_ratio` (default 0.5), `flag_expected_ratio` (default 0.25),
keeping `rest_min_samples`, `rest_abs_floor`, `rest_hours`.

Behavior preserved: rested numbers auto-return, flagged numbers wait for an
operator, nothing is ever auto-retired.

### D. Local-match recording

Migration adds two nullable columns to `calls`:

- `local_match text` — `'exact' | 'state' | 'none'`
- `dest_country text` — `'US' | 'CA'`

`selectPoolNumber` already knows which tier it selected inside `pickPoolNumber`;
it currently discards that. It returns the tier instead of recomputing, and
`tick.ts` stamps both columns at placement. Redials (`usableRedialNumber`) reuse
call 1's number, so they recompute the tier against the same lead.

Nullable and additive — no backfill, no read path depends on it yet.

### E. Caps (production data edit)

`app_settings.number_pool_settings` → `daily_cap: 80`, `warmup_start_cap: 20`,
`warmup_days: 14`. Verified live value on 2026-07-28:

```json
{
  "daily_cap": 0,
  "rest_hours": 24,
  "warmup_days": 14,
  "rest_abs_floor": 0.1,
  "rest_min_samples": 20,
  "warmup_start_cap": 50
}
```

`daily_cap: 0` is the sentinel for "uncapped" — `effectiveDailyCap` returns
`UNCAPPED` before consulting the warm-up ramp, which is why the ramp is currently
inert despite `warmup_started_at` being set on all three numbers.

Applied **after** the number buy, with the current row shown first and a guarded
write. Reverting is setting `daily_cap` back to 0.

### F. Trust Hub playbook (`docs/twilio-trust-hub-playbook.md`)

Operator-executed, no code. Business Profile (EIN, US address, authorized rep,
HTTPS site) → SHAKEN/STIR trust product → attach numbers → Voice Integrity
registration → branded caller ID display name. Includes the display-name decision
(which legal entity appears on caller ID) and the Canadian caveat that Canadian
numbers sit under a separate CRTC regime.

## Compliance note (not a legal opinion)

Canadian telemarketing made with an automatic dialing-announcing device requires
**express prior consent**, and the CRTC has explicitly declined to extend the
existing-business-relationship exemption to ADAD telemarketing calls.
Telemarketers must register with the National DNCL before calling, and penalties
reach $15,000 per call for corporations. Whether a conversational AI agent is an
"ADAD" is unsettled and is a question for counsel.

This spec **builds** Canadian number support because provisioning numbers does
not itself change exposure. It does not recommend scaling Canadian dial volume
until the consent question is answered. 1,707 Canadian leads are being dialed
today.

## Out of scope

- The Numbers tab in Reporting (Phase 2, depends on D).
- Automating Trust Hub registration via API — the underlying profile needs manual
  vetting first, so automation cannot be step one.
- The mobile lock (TCPA control), calling hours (no measured effect), and the
  retry cycle.
- The `pickNextBestWindow` helper in `best-time.ts` is dead code — nothing calls
  it, and cold leads are never scheduled into their best hour. Left alone: the
  heatmap needs ≥8 samples per bucket and there are only 337 calls, so wiring it
  today would change nothing. Worth revisiting once volume builds.
- A minor observation, not fixed here: 321 calls were placed on 2026-07-28
  against a 300/day cap. `pre_call_check` tests `>=` at claim time, so with
  concurrency 10 a small overshoot is expected.

## Testing

Pure functions get vitest units, matching the existing pool tests:
`siblingAreaCodes` (metro before state, exact excluded, Canada), `buildStatePlan`
(picks the densest area code per state), and the expected-rate calculation.

Playwright specs are the contract for UI behavior but run against the live
environment, so they are written and not run locally.

`addNumbersToPool` spends real money and is not exercised end-to-end in CI; the
first live buy happens with the operator present.

## Rollout order

Sequencing is load-bearing — E must not land before the numbers exist.

1. **PR 1** — A + B (+ Canada in `nanp-states.ts`, new `nanp-metros.ts`). No
   behavior change until someone buys.
2. **PR 2** — D (migration + stamping). Starts collecting evidence immediately.
3. **PR 3** — C (health monitor). Depends on D for the segment column.
4. **Operator step** — buy ~25–30 US numbers via the new planner, ~10 Canadian
   (pending the address/bundle requirement).
5. **Operator step** — E, the cap change, once the pool is large enough.
6. **F** — the playbook, executable in parallel at any point.
