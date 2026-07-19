# Local-Presence Number Pool — Design

**Date:** 2026-07-18
**Status:** Design — pending user review, then implementation plan
**Owner context:** Enables high-volume outbound (target ~150k calls/month) without
burning carrier reputation, and lifts answer rates via local-presence caller ID.

---

## 1. Problem & goal

Today the platform dials every call in a campaign from **one** phone number. That
caps safe volume hard: carriers flag a number as "Scam Likely" within days once it
sustains high outbound volume, and the connect rate collapses. To dial ~5,000
calls/day (150k/month) we must spread calls across **many** numbers, keep each one
under a reputation-safe daily volume, retire numbers that get flagged, and — to lift
answer rates — show each callee a number in **their own area code** (local presence).

**Goal:** a campaign draws from a **pool** of owned numbers. For each call we pick a
healthy, under-cap number whose area code matches the lead's, dialing from it via the
existing ElevenLabs outbound path. Health is monitored continuously; degraded numbers
auto-rest; new numbers warm up gradually; inbound callbacks to any pool number reach
the campaign's agent.

Non-goal for this spec: reducing per-call cost (covered separately by the voicemail
fix) and changing the retry/backoff cadence.

---

## 2. Platform facts — VERIFIED (do not re-litigate in the plan)

These were confirmed against the live ElevenLabs workspace + code on 2026-07-18:

1. **An outbound call sets the "from" number per call.** `placeAgentCall`
   (`src/lib/twilio/place-call.ts`) calls `POST /v1/convai/twilio/outbound-call`
   with **both** `agent_id` and `agent_phone_number_id`. The from-number is a
   per-call parameter, independent of any inbound assignment. This is exactly how
   production dials today.
2. **A live agent can hold multiple assigned numbers.** Reversible API test:
   assigned a spare number to the live "Speed to Lead" agent (which already had 1) →
   HTTP 200, agent then showed 2 numbers; unassigned it → back to 1. No 1-number cap,
   no limit error. (The "2 numbers per agent" seen earlier in the raw list were stale
   references to _deleted_ agents — ignore those.)
3. **Therefore the pool works with a SINGLE agent** — no agent cloning. Every pool
   number is imported to EL and (per the inbound decision below) assigned to the
   campaign's agent, so outbound-from-any-pool-number is valid even under the
   strictest "from-number must be assigned to the agent" reading.

**Residual to confirm with ElevenLabs (not a blocker):** I proved 2 numbers/agent, not
50–100. The exact per-agent number ceiling on the current EL plan is unverified — get a
one-line confirmation from EL before provisioning a large pool. If a hard ceiling
exists below the needed pool size, fallback options are in §16.

Optional final proof: a single live outbound smoke test from a non-primary pool number
to a phone the operator controls. Not required for the design; offered separately.

---

## 3. Product decisions (from brainstorm, 2026-07-18)

- **Scope:** Local presence **from the start** (area-code matched), built on a
  pool whose number-picking rule is pluggable.
- **Inbound:** callbacks to a pool number **route to the campaign's agent** (assign
  the agent to every pool number).
- **New numbers:** **warm up** (ramp daily cap over ~2 weeks).
- **Spend control:** keep the **existing** daily/monthly spend caps (no new governor).

---

## 4. Current state (what exists, grounded in code)

- **1 number ↔ 1 campaign.** `campaigns.twilio_number_id` (single) and
  `twilio_numbers.attached_campaign_id` (single) are a bidirectional 1:1 link.
- **`pre_call_check`** (`supabase/migrations/20260619140000_*`) validates the
  campaign's single `twilio_number_id` exists, is attached to the campaign, then
  enforces DNC, in-flight guard, calling hours, hourly/daily call caps (AI outbound,
  `status<>'failed'`), owner-wide concurrency cap, and ET-windowed spend caps.
- **`dial_queue`** view (`20260611090000_*`) surfaces one candidate row per eligible
  (lead × active autopilot campaign), carrying the campaign's single
  `twilio_number_id`; requires `c.twilio_number_id is not null`.
- **Dialer tick** (`src/lib/dialer/tick.ts` → `placeLiveDialerCall`) inserts a `calls`
  row with the queue's `twilio_number_id`, then `resolveAndPlaceAgentCall`
  (`agent-dial.ts`) imports the number to EL and places the call **from that number**.
- **`twilio_numbers`** columns: `id, phone_number, friendly_name, country,
monthly_cost, twilio_sid, elevenlabs_phone_number_id, attached_campaign_id,
purchased_at, released_at, flagged_for_rotation (bool), last_calls_count_24h,
last_connect_rate_24h, last_connect_rate_check_at, status_webhook_url,
voice_webhook_url`.
  - **The health fields (`last_calls_count_24h`, `last_connect_rate_24h`,
    `last_connect_rate_check_at`) are declared but NEVER written by any code** — health
    tracking is stubbed. `flagged_for_rotation` is likewise an unused stub.
- **Provisioning** (`src/lib/twilio/number-actions.ts`): `searchNumbers`,
  `purchaseNumber` (single), `renameNumber`, `releaseNumber`, `deleteTwilioNumber`,
  `syncFromTwilio`, `connectNumberToElevenLabs` exist. No bulk buy, no pool concept.
- **Inbound** (`src/lib/twilio/inbound-webhook.ts`, EL-native): resolves the lead by
  the caller's number; independent of which of our numbers was called.

---

## 5. Data model changes

Reuse `twilio_numbers.attached_campaign_id` as **pool membership** — a number belongs
to exactly one campaign's pool (branding stays per-campaign). Drop the assumption that
a campaign has only one number: **a campaign's pool = all `twilio_numbers` where
`attached_campaign_id = campaign.id` and `released_at is null`.**

### New columns on `twilio_numbers`

| Column               | Type                             | Purpose                                                                                           |
| -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `area_code`          | `text`                           | 3-digit NANP area code parsed from `phone_number`. Indexed for local matching.                    |
| `region`             | `text null`                      | 2-letter US state, for same-state fallback. Derived from `area_code` via a static NANP→state map. |
| `pool_status`        | `text not null default 'active'` | `active` \| `retired` (manual, permanent-until-unretired).                                        |
| `rested_until`       | `timestamptz null`               | Auto-rest cool-off end; excluded from selection while in the future.                              |
| `warmup_started_at`  | `timestamptz null`               | When the number entered service (defaults to attach time). Drives the ramp.                       |
| `daily_cap_override` | `int null`                       | Optional per-number override of the global daily cap.                                             |

- **Repurpose** existing `flagged_for_rotation` as the **manual "rotate this number
  out"** flag (operator-set) → excluded from selection (distinct from `pool_status`:
  `flagged_for_rotation` is a soft "prefer not to use / phasing out" while
  `pool_status='retired'` fully removes it). _(If simpler in build, collapse the two —
  decide in the plan; the spec treats "excluded" = `retired` OR `flagged_for_rotation`
  OR `rested_until > now`.)_
- Keep `campaigns.twilio_number_id` as a **legacy/primary fallback** (a pool of 1 for
  campaigns that never add more numbers → **fully backward compatible**). New pooled
  campaigns may leave it null.

### New settings (`public.app_settings`, single-row config)

| Setting                   | Default | Purpose                                                              |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `number_daily_cap`        | `100`   | Mature per-number daily dial cap (reputation-safe).                  |
| `number_warmup_days`      | `14`    | Ramp length for a fresh number.                                      |
| `number_warmup_start_cap` | `20`    | Day-1 cap of a fresh number.                                         |
| `number_rest_min_samples` | `20`    | Min 24h dials before a connect-rate rest decision.                   |
| `number_rest_rate_factor` | `0.5`   | Rest if connect rate < factor × pool median (and < absolute floor).  |
| `number_rest_abs_floor`   | `0.08`  | Absolute connect-rate floor below which a well-sampled number rests. |
| `number_rest_hours`       | `24`    | Auto-rest cool-off length.                                           |

### Indexes / migration notes

- Index `twilio_numbers (attached_campaign_id, pool_status)` and
  `twilio_numbers (attached_campaign_id, area_code)` for fast pool selection.
- Backfill: set `area_code`/`region` from existing `phone_number`; set
  `warmup_started_at = purchased_at` for existing numbers (they're already "warm", so
  the ramp is effectively over). Existing `attached_campaign_id` values already form
  pools of 1 → no behavior change until numbers are added.
- **Migration sequencing:** additive columns + settings ship and deploy BEFORE any
  code reads them; the selection/`pre_call_check` changes read them only after. No
  column is dropped. (See `feedback_migration_sequencing`.)

---

## 6. Number selection — `selectPoolNumber(supabase, campaignId, leadPhone)`

New pure-ish helper in `src/lib/dialer/number-pool.ts`. Returns
`{ numberId, elevenlabsPhoneNumberId } | null`.

**Algorithm:**

1. **Load the pool:** `twilio_numbers` where `attached_campaign_id = campaignId`,
   `released_at is null`, `pool_status = 'active'`, `flagged_for_rotation = false`,
   `(rested_until is null or rested_until <= now())`,
   `elevenlabs_phone_number_id is not null` (must be imported).
2. **Live 24h usage per number:** count `calls` grouped by `twilio_number_id` for the
   pool where `direction='outbound' and call_mode='ai' and status<>'failed' and
created_at >= now()-24h` (mirrors `pre_call_check`'s cap counting; one grouped
   query, cached within a tick).
3. **Effective daily cap per number** (warm-up, §7). Exclude numbers whose 24h count
   ≥ effective cap (**capped**).
4. **Local-presence tiering** on the remaining eligible numbers, best tier that is
   non-empty:
   - **Tier A:** `area_code == leadAreaCode`.
   - **Tier B:** `region == leadRegion` (same state).
   - **Tier C:** any eligible number (guarantees a call still goes out).
5. **Within the chosen tier:** pick the **least-used-today** (lowest 24h count);
   tie-break by highest `last_connect_rate_24h` (nulls last); final tie-break by a
   deterministic-but-spread key (e.g. hash of `callId`) so load spreads evenly.
6. **Exhausted:** if every eligible number is capped (tiers all empty at step 4),
   return **null**.

`leadAreaCode`/`leadRegion` derive from `leadPhone` (E.164 → NANP area code → state
map). Non-US / unparseable → skip Tier A/B, use Tier C.

**Soft cap:** two concurrent placements may both pick the current least-used number and
push it slightly over cap. Acceptable — the cap carries reputation margin; we do not
lock/lease numbers (keeps the hot path fast).

---

## 7. New-number warm-up

`effectiveDailyCap(number, now)`:

- `mature = daily_cap_override ?? number_daily_cap`.
- `ageDays = (now - warmup_started_at) / 1 day`. If `warmup_started_at` null or
  `ageDays >= number_warmup_days` → return `mature`.
- Else linear ramp: `round(start + (mature - start) * ageDays / warmup_days)` where
  `start = number_warmup_start_cap`, floored at `start`.

Pure function; unit-tested with an injected clock. A brand-new number thus starts at
~20/day and reaches full cap (~100) over 14 days — protecting its reputation during the
riskiest window.

---

## 8. Health monitoring & auto-rest

New cron endpoint `POST /api/numbers/health` (secret-gated by `DIALER_TICK_SECRET`,
mirroring the dialer/review ticks; see `reference_dialer_tick_secret`), scheduled via
`pg_cron` every ~30 min. Runs `refreshNumberHealth(supabase)`:

For each `pool_status='active'`, non-released number:

1. `calls_24h` = outbound AI calls from this number in the last 24h
   (`status<>'failed'`).
2. `connected_24h` = those with `outcome ∈ CONNECTED_OUTCOMES`
   (`src/lib/calls/outcomes.ts`). `connect_rate = connected_24h / calls_24h`.
3. Write `last_calls_count_24h`, `last_connect_rate_24h`, `last_connect_rate_check_at`.
4. **Auto-rest decision:** if `calls_24h >= number_rest_min_samples` AND
   `connect_rate < max(number_rest_abs_floor, number_rest_rate_factor × poolMedianRate)`
   → set `rested_until = now + number_rest_hours` and emit `system_events`
   `kind='number_rested'` (payload: number, rate, pool median). Numbers auto-return to
   rotation when `rested_until` passes (no unrest job needed; selection checks it).
5. **Pool-exhaustion signal:** if a campaign's whole pool is capped/rested during its
   calling hours, emit a rate-limited `system_events` `kind='pool_exhausted'`
   (payload: campaign, pool size) so the UI can surface "add numbers".

`CONNECTED_OUTCOMES` is the app-wide "reached a human/gatekeeper" set (goal_met,
callback, call_back_later, not_interested, gatekeeper, transferred_to_human,
language_barrier, hung_up_immediately) — the same signal the best-time heatmap uses, so
a spam-flagged number (few pickups) rests, while a healthy one that just hits voicemails
is judged by pickups, not answers. _(Windowing note: 24h is responsive; if small pools
produce noisy rates, the plan may widen to 72h with the same min-sample guard.)_

---

## 9. Inbound routing (decision: route to the campaign's agent)

- **On attach / import:** after `ensureNumberImportedToElevenLabs`, call
  `assignAgentToNumber(elevenlabsPhoneNumberId, campaign.agent.elevenlabs_agent_id)`
  (`place-call.ts`) so inbound to that number is answered by the campaign's agent.
- **On campaign agent change:** the campaign-save resync (`src/lib/campaigns/actions.ts`)
  re-asserts the agent assignment across **all** pool numbers (idempotent per EL).
- Verified feasible in §2.2 (agent holds multiple numbers). Inbound webhook is
  unchanged — it resolves the lead by the caller's number regardless of which pool
  number was called.
- **Ceiling caveat** (§2 residual): if EL caps numbers-per-agent below the pool size,
  inbound routing for the overflow needs the §16 fallback; **outbound is unaffected**
  (from-number is per-call).

---

## 10. Provisioning + UI

All new provisioning actions are **admin-gated + service-role**, matching the existing
`number-actions.ts` and `close/actions.ts` patterns; the health cron is secret-gated.

### Bulk purchase by area code

Extend `number-actions.ts`:

- `bulkPurchaseNumbers({ campaignId, areaCode, count })`: `searchNumbers(areaCode)` →
  buy up to `count` available → for each: create `twilio_numbers` row
  (`attached_campaign_id=campaignId`, `area_code`, `region`, `warmup_started_at=now`),
  `ensureNumberImportedToElevenLabs`, `assignAgentToNumber`. Best-effort per number
  (one failure doesn't abort the batch); report per-number results.
- `detachNumberFromPool(numberId)` / `retireNumber(numberId)` (sets
  `pool_status='retired'`; keeps history; excluded from selection).

### Area-code planner

`suggestPoolPlan(campaignId)`: read the campaign's leads' `business_phone` area codes,
bucket by area code, and recommend numbers-to-buy per area code so local coverage
tracks lead geography (e.g. `ceil(leads_in_area / (number_daily_cap × workdays))`,
min 1). Presented as a table the operator can act on.

### UI

- **Campaign settings → "Phone numbers" pool panel:** table of pool numbers with
  `area_code`, 24h volume, connect rate, status (active / warming / rested / retired /
  flagged), effective daily cap; actions: **Buy numbers** (area-code + count, with the
  planner's suggestion prefilled), **Retire**, **Flag/Unflag**, manual **Rest**.
- **Pool-exhaustion banner** when `pool_exhausted` events are recent: "Your pool is at
  capacity — buy more numbers to dial faster."
- Existing Twilio-numbers admin page gains the health columns.

---

## 11. Capacity / caps (item 4 — config + verify, no new governor)

- **Raise campaign caps** (config): `concurrency_cap_per_user` 5 → ~**12–15**;
  `calls_per_hour_cap` / `calls_per_day_cap` to target. Keep `daily_spend_cap` /
  `monthly_spend_cap` (the operator's chosen guardrail — unchanged).
  - **Concurrency nuance:** `pre_call_check` counts **owner-wide** live calls
    (`queued/dialing/ringing/in_progress`) and compares to the _dialing campaign's_
    `concurrency_cap_per_user`. Set the cap **consistently across all of a user's
    campaigns**, or the effective ceiling flips depending on which campaign's tick
    runs. (No code change — just set them equal.)
- **Effective daily ceiling** = `min(campaign.calls_per_day_cap, Σ pool effective caps)`.
  At ~100/day/number, **5,000/day needs ~50–60 mature numbers** (more while warming).
- **Confirm the ElevenLabs plan's concurrency limit** (external hard ceiling); keep the
  app concurrency cap under it.
- **Reliability at scale** (harden, verify by load test):
  - The dialer tick is sequential, `limit 50`/tick. At ~7 dials/min it has headroom,
    but load-test at target concurrency; if it can't keep slots full, make in-tick
    placements concurrent (bounded pool) and/or raise cron cadence + `limit`.
  - `closeStaleActiveCalls` (`src/lib/dialer/stale-calls.ts`) must reliably reap
    stuck in-flight calls so a dropped post-call webhook never permanently consumes a
    concurrency slot — stress-test it.

---

## 12. Wiring / impact surface (every touchpoint)

| File / object                                                                            | Change                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **migration** (new)                                                                      | `twilio_numbers` columns (§5) + indexes; `app_settings` number-pool settings; backfill `area_code`/`region`/`warmup_started_at`.                                                                                                                                                                       |
| `supabase/migrations/*pre_call_check*` (new version)                                     | Replace the single-number validation with **"campaign has ≥1 usable pool number"** (active, non-released, imported, not retired/flagged); add reason `campaign_has_no_numbers`. Per-number cap/rest exhaustion is handled in selection (returns null → defer), not here. Everything else identical.    |
| `dial_queue` view (new version)                                                          | Replace `c.twilio_number_id is not null` filter with `exists (… pool number …)`; drop `c.twilio_number_id` from the projection (selection happens at placement).                                                                                                                                       |
| `src/lib/dialer/number-pool.ts` (new)                                                    | `selectPoolNumber`, `effectiveDailyCap`, area-code/region parsing. Pure where possible.                                                                                                                                                                                                                |
| `src/lib/dialer/tick.ts` → `placeLiveDialerCall`                                         | Call `selectPoolNumber(campaign, leadPhone)`; **insert the `calls` row with the SELECTED number's id** (so health attributes correctly); pass its `elevenlabs_phone_number_id` to placement. If null → **defer**: don't insert a call, leave the claim lease (retries in 2 min), log `pool_exhausted`. |
| `src/lib/dialer/agent-dial.ts` / `place-call.ts`                                         | Already take the number per call — pass the selected one. No structural change.                                                                                                                                                                                                                        |
| `src/lib/dialer/call-now.ts`, `src/lib/twilio/human-call.ts`                             | Use `selectPoolNumber` (or the campaign primary) instead of a fixed number.                                                                                                                                                                                                                            |
| `src/lib/twilio/number-actions.ts`                                                       | Add `bulkPurchaseNumbers`, `retireNumber`, `detachNumberFromPool`, `suggestPoolPlan`; on attach, import + assign agent.                                                                                                                                                                                |
| `src/lib/review/... n/a`                                                                 | —                                                                                                                                                                                                                                                                                                      |
| `src/lib/campaigns/actions.ts`                                                           | On agent change, re-assert `assignAgentToNumber` across the whole pool.                                                                                                                                                                                                                                |
| `src/app/api/numbers/health/route.ts` (new) + `pg_cron`                                  | Health refresh + auto-rest (§8).                                                                                                                                                                                                                                                                       |
| UI: campaign settings pool panel, Twilio-numbers admin health columns, exhaustion banner | §10.                                                                                                                                                                                                                                                                                                   |
| `src/lib/analytics/costs.ts` (or Costs page)                                             | Surface pool number **rental** (Σ `monthly_cost`) so scaling the pool is visible.                                                                                                                                                                                                                      |
| `inbound-webhook.ts`                                                                     | **No change** (resolves lead by caller).                                                                                                                                                                                                                                                               |

---

## 13. Data flow (end to end)

Tick reads `dial_queue` (campaign has a usable pool) → `pre_call_check` (DNC, hours,
caps, ≥1 pool number) → `claim_lead_for_dial` (atomic) → `selectPoolNumber(campaign,
leadPhone)` picks a healthy, under-cap, area-matched number → insert `calls` row with
**that** `twilio_number_id` → `resolveAndPlaceAgentCall` places via EL from that number →
post-call webhook logs outcome/cost → the health cron later rolls each number's 24h
volume + connect rate and rests any that crater.

---

## 14. Edge cases & failure modes

- **Pool exhausted (all capped):** selection returns null → lead defers on its claim
  lease (retries ~2 min) → `pool_exhausted` event → UI banner. Volume self-throttles to
  what the pool can safely support; the fix is "buy more numbers", never over-dialing.
- **Number flagged mid-day:** connect rate craters → auto-rest at next health run
  (≤30 min). Faster detection = shorter cron interval (tunable).
- **Fresh number:** warm-up ramp caps its first ~2 weeks (§7).
- **Import/assign failure:** number lacks `elevenlabs_phone_number_id` → excluded from
  selection until fixed; bulk-buy reports the failure per number.
- **Concurrency race on least-used:** minor cap overshoot; acceptable (soft cap).
- **Released / retired / flagged number:** excluded from selection; in-flight calls
  finish normally.
- **Backward compatibility:** existing single-number campaigns = a pool of 1 →
  identical behavior until numbers are added.
- **No local match:** Tier B (state) then Tier C (any) guarantee a call still goes out.
- **Shared lead lists (multiple campaigns on one list):** each campaign has its own
  pool; a lead is dialed under exactly one campaign (existing ownership/claim model), so
  it uses that campaign's pool. Two campaigns dialing the same region need their own
  local numbers (more numbers, but branding preserved) — documented, acceptable.
- **DNC / mobile-lock / calling-hours / concurrency / spend caps:** all unchanged —
  `pre_call_check` still enforces them; the pool only changes _which number_ dials.
- **Cost visibility:** pool rental (Σ `monthly_cost`) surfaced so a 50–100 number pool
  isn't an invisible cost.

---

## 15. Operational prerequisites (NOT code — required for it to actually connect)

At 150k/month with local presence these are mandatory or the numbers get flagged
regardless of rotation:

- **Twilio A2P / brand + campaign registration** and **STIR/SHAKEN attestation** for
  the number pool (so calls carry proper attestation and aren't marked "Scam Likely").
- **Compliance for local presence:** use only numbers you own; honor DNC (already
  enforced); keep AI disclosure (already in the agent); mind state-level restrictions on
  caller-ID practices. Legal sign-off recommended before scaling.
- **Confirm the EL plan's per-agent number ceiling and concurrency limit** (§2, §11).

---

## 16. Fallbacks if the EL per-agent number ceiling is hit

Only relevant to **inbound** (outbound is per-call, unaffected). If EL caps
numbers-per-agent below the pool size:

- **Preferred:** route inbound for all pool numbers to a small number of shared inbound
  agents (clones of Danny used only for inbound greeting/handoff), OR
- Advertise a single dedicated inbound line and leave pool numbers outbound-only
  (revisit the inbound decision).
  This is a contained change to §9 only; the outbound pool design is unchanged.

---

## 17. Testing

- **Vitest (pure):** `selectPoolNumber` (Tier A/B/C selection, cap exclusion, rested/
  retired/flagged exclusion, least-used + tie-break, exhaustion→null), `effectiveDailyCap`
  (warm-up ramp curve incl. boundaries), the auto-rest decision (min-samples, factor vs
  absolute floor, pool-median), area-code/region parsing. All with injected number lists
  - clock.
- **Playwright (live-env):** pool panel renders; buy/retire/flag actions; not-connected
  and no-pool contracts. (Live dialing isn't exercised in CI.)
- **Manual smoke:** buy a number → confirm import + agent assignment; place one call →
  confirm the caller ID is the selected pool number and health updates.

---

## 18. Rollout phases

1. **Migration + selection core:** columns/settings/indexes, `number-pool.ts`,
   `pre_call_check` + `dial_queue` changes, tick wiring (select-at-placement, record the
   number). Backward compatible (pools of 1). Ship behind real use with a tiny pool.
2. **Health + warm-up:** health cron, auto-rest, warm-up ramp, `pool_exhausted` events.
3. **Provisioning + UI:** bulk buy, area-code planner, pool panel, exhaustion banner,
   cost surfacing.
4. **Capacity tuning:** raise caps, load-test the tick + stale-reaper at target
   concurrency; confirm EL tiers.

Validate on a **small pool (5–10 numbers)** end to end before scaling to 50+.

---

## 19. Open questions / external dependencies

- EL per-agent number ceiling (2 proven; 50–100 unconfirmed) — confirm with EL.
- EL plan concurrent-call limit — confirm with EL; set app concurrency under it.
- Twilio A2P/SHAKEN registration status for the pool — ops.
- `flagged_for_rotation` vs `pool_status='retired'`: keep both (soft vs hard) or
  collapse — decide in the plan.
- Health window (24h vs 72h) for small pools — start 24h, revisit if noisy.

---

## 20. Non-goals (YAGNI)

- Per-call cost reduction (separate voicemail work).
- Changing retry/backoff cadence or the shared-list ownership model.
- Numbers shared across multiple campaigns' pools (branding = campaign-owned numbers).
- Auto-purchasing numbers without operator action (planner suggests; operator buys).
- Dynamic per-lead agent selection (one agent per campaign, many numbers).
