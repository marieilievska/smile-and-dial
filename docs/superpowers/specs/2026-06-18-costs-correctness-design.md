# Costs correctness (Phase 1 of the Costs overhaul)

**Date:** 2026-06-18
**Status:** Design — awaiting review
**Author:** Marija + Claude

This is **Phase 1** of a two-phase effort. Phase 1 makes the cost _numbers_
correct and centralizes the rates (no visual change). **Phase 2 (the visual
redesign — "2026 AI, not 2016 SaaS") is a separate spec** built on top of the
corrected data.

## Background — what the audit found

The Costs page already has the right structure (vendor breakdown, per-campaign /
list / day / call views, KPIs), but some numbers feeding it are wrong:

| Line item                    | Status today  | Source                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ElevenLabs total             | ✅ correct    | `metadata.cost` credits × `$0.000198`/credit ([post-call-webhook.ts](../../../src/lib/elevenlabs/post-call-webhook.ts))                                                                                                                                       |
| ElevenLabs voice / LLM split | ❌ impossible | ElevenLabs sends ONE bundled credit number ([EL docs](https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks))                                                                                                                                 |
| Twilio calls                 | ⚠️ broken     | Computed only for `call_mode = 'human'` in the recording webhook ($0.0185/min); **AI calls get `twilio: 0`** ([recording/route.ts](../../../src/app/api/twilio/recording/route.ts), [post-call-webhook.ts](../../../src/lib/elevenlabs/post-call-webhook.ts)) |
| Twilio number                | ✅ correct    | flat `$0.04`/mo per active number, scaled to range ([numbers.ts](../../../src/lib/twilio/numbers.ts))                                                                                                                                                         |
| Twilio lookup                | ✅ correct    | `$0.005`/lookup at import ([import-fields.ts](../../../src/lib/leads/import-fields.ts))                                                                                                                                                                       |
| OpenAI                       | ⚠️ rough      | flat `$0.001`/call guess, not real tokens ([summary-merger.ts](../../../src/lib/openai/summary-merger.ts))                                                                                                                                                    |

Rates are also scattered across ≥5 files with inconsistent values.

## Decisions (locked in)

- **ElevenLabs: show total only.** We cannot split voice vs LLM — ElevenLabs
  doesn't give us the breakdown. The page keeps one ElevenLabs line. (#2)
- **Twilio on AI calls: forward-only.** New calls get a real Twilio cost; past
  AI-call rows are left as they are (no historical data edit). (#1)
- **Twilio voice rate: `$0.0185`/min**, matching the rate already used for manual
  calls, stored as an env-overridable default. (#1)
- **OpenAI: real token-based cost.** (#3)
- **Centralize all rates** in one module. (#4)

## Design

### 1. One rates module — `src/lib/costs/rates.ts` (#4)

A single source of truth for every price, each with an env override and a
sensible default. Pure module (no `"use server"`), importable anywhere.

Rates it owns:

- `twilioVoiceUsdPerMinute()` — default `0.0185` (env `TWILIO_VOICE_USD_PER_MINUTE`)
- `elevenLabsUsdPerCredit()` — default `0.000198` (env `ELEVENLABS_USD_PER_CREDIT`)
- `twilioLookupUsd()` — default `0.005` (env `TWILIO_LOOKUP_USD`)
- `twilioNumberMonthlyUsd()` — default `0.04` (env `TWILIO_NUMBER_MONTHLY_COST`)
- `whisperUsdPerMinute()` — default `0.006` (env `OPENAI_WHISPER_USD_PER_MINUTE`)
- gpt-4o-mini token rates — input default `0.15`/1M, output `0.60`/1M
  (env `OPENAI_GPT4OMINI_USD_PER_1M_INPUT` / `_OUTPUT`)

Helpers it exposes:

- `priceTwilioCall(durationSeconds)` → USD, billed by the **whole minute rounded
  up** (`ceil(seconds/60) × rate`), matching how Twilio bills.
- `priceOpenAiTokens(promptTokens, completionTokens)` → USD.

Every existing call site is refactored to import from here, so the scattered
constants (`COST_PER_LOOKUP`, `DEFAULT_NUMBER_MONTHLY_COST`,
`ELEVENLABS_USD_PER_CREDIT`, the inline `0.0185` / `0.006` / `0.001`) come from
one place. Existing constant names that other modules import (e.g.
`COST_PER_LOOKUP`) are re-exported from their current location so nothing breaks.

### 2. Twilio cost on AI calls (#1)

The ElevenLabs post-call webhook already finalizes the call and writes
`cost_breakdown` (the `mergedCost` block). At that point the call's duration is
known (`metadata.call_duration_secs`, falling back to the call row's
`duration_seconds`). We compute `priceTwilioCall(duration)` and put it into the
breakdown instead of `twilio: 0`, and include it in `total`.

Guard: only fill `twilio` when it isn't already set (`prevCost.twilio || computed`)
so a human-call path that already wrote a Twilio cost is never double-counted.

The human-call recording webhook keeps computing Twilio cost but switches to
`priceTwilioCall(...)` / the shared rate so both paths agree.

### 3. Real OpenAI cost (#3)

`summary-merger.ts` calls gpt-4o-mini and currently hardcodes `cost = 0.001`.
Instead it reads `usage.prompt_tokens` / `usage.completion_tokens` from the API
response and prices them with `priceOpenAiTokens(...)`. Mock mode stays `0`.

The recording webhook's OpenAI line (transcription + summary) is recomputed from
the shared rates: audio transcription at the Whisper per-minute rate, and any
text-summary call priced from its token usage where the API returns it (else the
existing per-minute estimate as a documented fallback).

### 4. ElevenLabs total (#2)

No data change — already a single total. Constant moves to the rates module. The
page keeps one ElevenLabs line (Phase 2 may relabel it "ElevenLabs (voice + LLM)"
to make the bundle explicit; that's a presentation detail for Phase 2).

## What does NOT change

- The Costs page UI, queries, rollups, and CSV export (`src/lib/analytics/costs.ts`,
  `src/app/(app)/costs/*`) are untouched in Phase 1 — they already read
  `cost_breakdown`, which simply becomes more accurate. The visual work is Phase 2.
- No database migration. `cost_breakdown` shape (`{ twilio, elevenlabs, openai,
lookup, total }`) is unchanged.
- No historical data edits (forward-only).

## Safety & rollout

- **No migration, no data edits** — purely code changes to how new calls compute
  cost. Existing rows are left intact.
- **Rates are env-overridable**, so the live values can be corrected without a
  code change if any default is off.
- **Contract test:** extend the ElevenLabs post-call webhook test so a finalized
  AI call with a known duration ends up with `cost_breakdown.twilio` equal to
  `priceTwilioCall(duration)` and `total` including it. (Specs run live only.)
- **Local verification:** `npx tsc --noEmit`, `npx eslint` on changed files, and
  `npm run build` clean before merge.
- **Deploy:** feature branch `feat/costs-correctness` → PR → merge to main
  (Vercel auto-deploys). No `supabase db push` needed.

## Out of scope (Phase 2)

- The visual redesign of the Costs page.
- Relabeling / regrouping vendor lines (ElevenLabs bundle label, etc.).
- Any per-call ElevenLabs voice/LLM estimate — explicitly dropped (#2 = total only).
