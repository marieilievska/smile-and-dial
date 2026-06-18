# Costs Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Costs page numbers correct — capture Twilio cost on AI calls, price OpenAI from real tokens, keep ElevenLabs as a single total — and centralize every rate in one env-overridable module.

**Architecture:** A new pure `src/lib/costs/rates.ts` owns every price and the pricing helpers. The ElevenLabs post-call webhook (which finalizes AI calls and writes `cost_breakdown`) starts filling `twilio` from the call's duration. The OpenAI summary merge and the human-call recording webhook switch from flat guesses to token/duration-based pricing via the rates module. No schema change, no historical data edits, no UI change (that's Phase 2).

**Tech Stack:** TypeScript, Next.js (App Router route handlers + server libs), Supabase, Playwright (contract tests, run live only).

---

## Conventions for this plan

- **No CI gate / Playwright runs live only.** You **cannot** run `npx playwright test` locally. "Verify" for every task means `npx tsc --noEmit` + `npx eslint <files>` clean, and `npm run build` clean at the end. The Playwright spec is the written contract.
- **Branch:** all work lands on `feat/costs-correctness` (already created off main). Stage only the files each task names.
- **No migration, no data edits.** Forward-only behavior change.
- Rates default to today's values and are env-overridable; defaults assumed in tests.

---

### Task 1: The rates module

**Files:**

- Create: `src/lib/costs/rates.ts`

- [ ] **Step 1: Write the module**

Create `src/lib/costs/rates.ts`:

```ts
/**
 * Single source of truth for every per-unit cost in the product. Each rate has
 * an env-overridable default so a live value can be corrected without a deploy.
 * Pure module (no "use server") — importable from server libs, route handlers,
 * and the analytics layer alike.
 */

/** Read a non-negative number from an env var, falling back to `fallback`. */
function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Twilio outbound voice, USD per minute (Twilio bills per whole minute). */
export function twilioVoiceUsdPerMinute(): number {
  return envNum("TWILIO_VOICE_USD_PER_MINUTE", 0.0185);
}

/** ElevenLabs Conversational AI, USD per credit. The credit figure bundles
 *  voice (TTS/ASR) + LLM + telephony — ElevenLabs does not break it out. */
export function elevenLabsUsdPerCredit(): number {
  return envNum("ELEVENLABS_USD_PER_CREDIT", 0.000198);
}

/** Twilio Lookup (Line Type Intelligence), USD per lookup. */
export function twilioLookupUsd(): number {
  return envNum("TWILIO_LOOKUP_USD", 0.005);
}

/** Twilio phone-number rental, USD per month. */
export function twilioNumberMonthlyUsd(): number {
  return envNum("TWILIO_NUMBER_MONTHLY_COST", 0.04);
}

/** OpenAI Whisper transcription, USD per minute of audio. */
export function whisperUsdPerMinute(): number {
  return envNum("OPENAI_WHISPER_USD_PER_MINUTE", 0.006);
}

/** gpt-4o-mini input tokens, USD per 1,000,000 tokens. */
export function gpt4oMiniInputUsdPerMillion(): number {
  return envNum("OPENAI_GPT4OMINI_USD_PER_1M_INPUT", 0.15);
}

/** gpt-4o-mini output tokens, USD per 1,000,000 tokens. */
export function gpt4oMiniOutputUsdPerMillion(): number {
  return envNum("OPENAI_GPT4OMINI_USD_PER_1M_OUTPUT", 0.6);
}

/** Price a Twilio voice call from its duration. Twilio bills per whole minute,
 *  rounded UP, so a 61-second call is 2 minutes. Returns USD rounded to 4 dp. */
export function priceTwilioCall(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, Math.floor(durationSeconds ?? 0));
  if (secs === 0) return 0;
  const minutes = Math.ceil(secs / 60);
  return Number((minutes * twilioVoiceUsdPerMinute()).toFixed(4));
}

/** Price a gpt-4o-mini completion from its token usage. Returns USD (4 dp). */
export function priceOpenAiTokens(
  promptTokens: number,
  completionTokens: number,
): number {
  const input =
    (Math.max(0, promptTokens) / 1_000_000) * gpt4oMiniInputUsdPerMillion();
  const output =
    (Math.max(0, completionTokens) / 1_000_000) *
    gpt4oMiniOutputUsdPerMillion();
  return Number((input + output).toFixed(4));
}

/** Price Whisper transcription from audio duration. Returns USD (4 dp). */
export function priceWhisper(
  durationSeconds: number | null | undefined,
): number {
  const secs = Math.max(0, durationSeconds ?? 0);
  return Number(((secs / 60) * whisperUsdPerMinute()).toFixed(4));
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/costs/rates.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/costs/rates.ts
git commit -m "feat(costs): central rates module with pricing helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Centralize the lookup and number-rental constants

**Files:**

- Modify: `src/lib/leads/import-fields.ts:23`
- Modify: `src/lib/twilio/numbers.ts:37-46`

- [ ] **Step 1: Point `COST_PER_LOOKUP` at the rates module**

In `src/lib/leads/import-fields.ts`, add an import at the very top of the file (before `/** Lead fields ... */`):

```ts
import { twilioLookupUsd } from "@/lib/costs/rates";
```

Then replace the constant (line 23):

```ts
/** Cost charged by Twilio for one Line Type Intelligence lookup, in USD. */
export const COST_PER_LOOKUP = 0.005;
```

with:

```ts
/** Cost charged by Twilio for one Line Type Intelligence lookup, in USD.
 *  Sourced from the central rates module (env-overridable). */
export const COST_PER_LOOKUP = twilioLookupUsd();
```

- [ ] **Step 2: Point the number-rental estimate at the rates module**

In `src/lib/twilio/numbers.ts`, add to the imports (after `import { appBaseUrl } from "@/lib/app-url";`, line 12):

```ts
import { twilioNumberMonthlyUsd } from "@/lib/costs/rates";
```

Then replace this block (lines 37-46):

```ts
// Twilio's number-search API doesn't return your account's price (and the
// Pricing API only returns list price, not negotiated rates), so the monthly
// cost shown on search results is an estimate. Set TWILIO_NUMBER_MONTHLY_COST
// to override; the default is this workspace's actual negotiated per-number
// rate ($0.04/mo), since one Twilio account sits behind the whole product.
const DEFAULT_NUMBER_MONTHLY_COST = 0.04;
function estimatedMonthlyCost(): number {
  const raw = Number(process.env.TWILIO_NUMBER_MONTHLY_COST);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_NUMBER_MONTHLY_COST;
}
```

with:

```ts
// Twilio's number-search API doesn't return your account's price (and the
// Pricing API only returns list price, not negotiated rates), so the monthly
// cost shown on search results is an estimate. The rate lives in the central
// rates module (env TWILIO_NUMBER_MONTHLY_COST; default $0.04/mo).
function estimatedMonthlyCost(): number {
  return twilioNumberMonthlyUsd();
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/leads/import-fields.ts src/lib/twilio/numbers.ts`
Expected: PASS. (`estimatedMonthlyCost` is still used where it was; `COST_PER_LOOKUP` keeps its name so `import-actions.ts` is unaffected.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/leads/import-fields.ts src/lib/twilio/numbers.ts
git commit -m "refactor(costs): source lookup + number-rental rates from rates module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Twilio cost on AI calls + ElevenLabs rate from the module

**Files:**

- Modify: `src/lib/elevenlabs/post-call-webhook.ts:45-64` and `:808-819`

- [ ] **Step 1: Import the rates helpers**

In `src/lib/elevenlabs/post-call-webhook.ts`, add to the imports near the top (it already imports `Database`, `mergeLeadSummary`, etc. — add this with the other `@/lib` imports):

```ts
import { priceTwilioCall, elevenLabsUsdPerCredit } from "@/lib/costs/rates";
```

- [ ] **Step 2: Use the central ElevenLabs rate**

Replace the local rate constant + comment (lines 45-50):

```ts
/** ElevenLabs Conversational AI is billed in credits; the post-call payload
 *  reports the total as a number in metadata.cost. Convert to USD. Default is
 *  the Pro plan rate (~$0.000198/credit); override with ELEVENLABS_USD_PER_CREDIT
 *  if the workspace plan differs. */
const ELEVENLABS_USD_PER_CREDIT =
  Number(process.env.ELEVENLABS_USD_PER_CREDIT) || 0.000198;
```

with (delete the const; keep just the doc comment for the function below):

```ts
// ElevenLabs Conversational AI is billed in credits; the post-call payload
// reports the total as a number in metadata.cost. The per-credit USD rate lives
// in the central rates module (env ELEVENLABS_USD_PER_CREDIT).
```

Then in `elevenLabsCostUsd` (lines 57-58), change:

```ts
if (typeof cost === "number") {
  return Number((cost * ELEVENLABS_USD_PER_CREDIT).toFixed(4));
}
```

to:

```ts
if (typeof cost === "number") {
  return Number((cost * elevenLabsUsdPerCredit()).toFixed(4));
}
```

- [ ] **Step 3: Fill the Twilio cost from the call's duration**

Replace the `mergedCost` block (lines 811-819):

```ts
const prevCost = (call.cost_breakdown ?? {}) as Record<string, number>;
const elevenLabsCost = elevenLabsCostUsd(payload.metadata?.cost);
const mergedCost = {
  twilio: prevCost.twilio ?? 0,
  elevenlabs: elevenLabsCost,
  openai: 0,
  lookup: prevCost.lookup ?? 0,
  total: (prevCost.twilio ?? 0) + elevenLabsCost + (prevCost.lookup ?? 0),
};
```

with:

```ts
const prevCost = (call.cost_breakdown ?? {}) as Record<string, number>;
const elevenLabsCost = elevenLabsCostUsd(payload.metadata?.cost);
// Twilio bills the call leg even though ElevenLabs places the call. If a prior
// path (e.g. a human-call recording webhook) already wrote a Twilio cost, keep
// it; otherwise price this call's duration. ElevenLabs's credit figure bundles
// LLM+TTS+telephony and lands under `elevenlabs`.
const twilioCost =
  prevCost.twilio && prevCost.twilio > 0
    ? prevCost.twilio
    : priceTwilioCall(callDurationSecs);
const mergedCost = {
  twilio: twilioCost,
  elevenlabs: elevenLabsCost,
  openai: 0,
  lookup: prevCost.lookup ?? 0,
  total: Number(
    (twilioCost + elevenLabsCost + (prevCost.lookup ?? 0)).toFixed(4),
  ),
};
```

(`callDurationSecs` is already computed earlier in this function — it's used for the duration write and the short-call heuristic.)

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/elevenlabs/post-call-webhook.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/elevenlabs/post-call-webhook.ts
git commit -m "feat(costs): capture Twilio call cost on AI calls; EL rate from module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Token-based OpenAI cost (summary merge + transcript summary)

**Files:**

- Modify: `src/lib/openai/summary-merger.ts:12-13`, `:62-79`, `:104-183`
- Modify: `src/lib/openai/transcribe.ts:36-67`

- [ ] **Step 1: Make `summarizeTranscript` return token usage**

In `src/lib/openai/transcribe.ts`, replace the whole `summarizeTranscript` function (lines 36-67):

```ts
/** Summarize a single call transcript into 1–2 sentences. Null in mock mode. */
export async function summarizeTranscript(
  transcript: string,
): Promise<string | null> {
  const apiKey = openAiKey();
  if (!apiKey || !transcript.trim()) return null;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize this sales call transcript in 1-2 sentences: what happened and any next step. Be concise and factual.",
        },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
      max_tokens: 120,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content?.trim() || null;
}
```

with:

```ts
/** Summarize a single call transcript into 1–2 sentences. Returns the text plus
 *  the OpenAI token usage so the caller can price it. Null in mock mode. */
export async function summarizeTranscript(transcript: string): Promise<{
  text: string;
  promptTokens: number;
  completionTokens: number;
} | null> {
  const apiKey = openAiKey();
  if (!apiKey || !transcript.trim()) return null;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Summarize this sales call transcript in 1-2 sentences: what happened and any next step. Be concise and factual.",
        },
        { role: "user", content: transcript.slice(0, 12_000) },
      ],
      max_tokens: 120,
    }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  return {
    text,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}
```

- [ ] **Step 2: Price the rolling-summary merge from real tokens**

In `src/lib/openai/summary-merger.ts`, add the rates import after the `./live` import (line 3):

```ts
import { priceOpenAiTokens } from "@/lib/costs/rates";
```

Update the stale cost note in the file's doc comment (lines 12-13):

```ts
 * Cost: ~$0.001 per call with gpt-4o-mini in live mode. Hard-gated behind
 * OPENAI_LIVE=live so we don't spend on accident.
```

to:

```ts
 * Cost: priced from the actual gpt-4o-mini token usage the API returns, via the
 * central rates module. Live whenever an OpenAI key is configured.
```

Replace the live/mock cost block (lines 62-72):

```ts
const apiKey = openAiKey();
const live = Boolean(apiKey);
let newSummary: string;
let cost = 0;
if (apiKey) {
  newSummary = await callOpenAi(apiKey, existing, latest);
  // gpt-4o-mini cost approximation: ~$0.001 per call per spec.
  cost = 0.001;
} else {
  newSummary = mockMerge(existing, latest);
}
```

with:

```ts
const apiKey = openAiKey();
const live = Boolean(apiKey);
let newSummary: string;
let cost = 0;
if (apiKey) {
  const result = await callOpenAi(apiKey, existing, latest);
  newSummary = result.text;
  cost = priceOpenAiTokens(result.promptTokens, result.completionTokens);
} else {
  newSummary = mockMerge(existing, latest);
}
```

- [ ] **Step 3: Make `callOpenAi` return token usage**

In the same file, change the `callOpenAi` signature and its two return points. Replace the signature (lines 107-111):

```ts
async function callOpenAi(
  apiKey: string,
  existing: string,
  latest: string,
): Promise<string> {
```

with:

```ts
async function callOpenAi(
  apiKey: string,
  existing: string,
  latest: string,
): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
```

Replace the `!res.ok` fallback (lines 172-176):

```ts
if (!res.ok) {
  // Live failures fall back to the mock merge — we never want to lose
  // the latest summary just because OpenAI is down.
  return mockMerge(existing, latest);
}
const data = (await res.json()) as {
  choices?: { message?: { content?: string } }[];
};
return (
  data.choices?.[0]?.message?.content?.trim() ?? mockMerge(existing, latest)
);
```

with:

```ts
if (!res.ok) {
  // Live failures fall back to the mock merge — we never want to lose
  // the latest summary just because OpenAI is down (and we charge nothing).
  return {
    text: mockMerge(existing, latest),
    promptTokens: 0,
    completionTokens: 0,
  };
}
const data = (await res.json()) as {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};
return {
  text:
    data.choices?.[0]?.message?.content?.trim() ?? mockMerge(existing, latest),
  promptTokens: data.usage?.prompt_tokens ?? 0,
  completionTokens: data.usage?.completion_tokens ?? 0,
};
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/openai/summary-merger.ts src/lib/openai/transcribe.ts`
Expected: PASS. (`transcribe.ts`'s only other caller is the recording route, updated next.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-merger.ts src/lib/openai/transcribe.ts
git commit -m "feat(costs): price OpenAI from real token usage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Recording webhook uses centralized pricing

**Files:**

- Modify: `src/app/api/twilio/recording/route.ts:6-10`, `:74-86`

- [ ] **Step 1: Import the rates helpers**

In `src/app/api/twilio/recording/route.ts`, add to the imports (after the `transcribeAudioUrl, summarizeTranscript` import, lines 6-9):

```ts
import {
  priceTwilioCall,
  priceWhisper,
  priceOpenAiTokens,
} from "@/lib/costs/rates";
```

- [ ] **Step 2: Recompute the breakdown from the rates module**

Replace this block (lines 74-86):

```ts
const transcript = await transcribeAudioUrl(recordingUrl);
const aiSummary = transcript ? await summarizeTranscript(transcript) : null;

const minutes = Math.max(0, recordingDuration) / 60;
const cost = Number((minutes * 0.027).toFixed(4));

const costBreakdown = {
  twilio: Number((minutes * 0.0185).toFixed(4)),
  elevenlabs: 0,
  openai: Number((minutes * 0.006 + 0.001).toFixed(4)),
  lookup: 0,
  total: cost,
};
```

with:

```ts
const transcript = await transcribeAudioUrl(recordingUrl);
const summary = transcript ? await summarizeTranscript(transcript) : null;
const aiSummary = summary?.text ?? null;

// Twilio bills the recorded human call leg; OpenAI bills Whisper per minute of
// audio plus the gpt-4o-mini summary by its actual tokens. All rates central.
const twilioCost = priceTwilioCall(recordingDuration);
const openaiCost = Number(
  (
    priceWhisper(recordingDuration) +
    (summary
      ? priceOpenAiTokens(summary.promptTokens, summary.completionTokens)
      : 0)
  ).toFixed(4),
);
const costBreakdown = {
  twilio: twilioCost,
  elevenlabs: 0,
  openai: openaiCost,
  lookup: 0,
  total: Number((twilioCost + openaiCost).toFixed(4)),
};
```

(The rest of the handler already uses `aiSummary`, which is preserved as the summary string.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npx eslint "src/app/api/twilio/recording/route.ts"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/api/twilio/recording/route.ts"
git commit -m "refactor(costs): recording webhook prices via central rates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Contract test — Twilio cost on an AI call

**Files:**

- Modify: `tests/elevenlabs-post-call.spec.ts:238-244` (correct a stale assertion) and add a new test after the existing cost test (after line 269).

- [ ] **Step 1: Correct the stale cost assertion**

The existing assertion encodes pre-bundling behavior (it expects `elevenlabs: 0.05, openai: 0.01`, but ElevenLabs costs are now summed into one `elevenlabs` figure and `openai` starts at 0). With the seeded `twilio: 0.02` and the legacy object cost `{ elevenlabs: 0.05, openai: 0.01 }` → `elevenlabs` is `0.06`, `openai` is `0`, total `0.08`.

Replace (lines 238-244):

```ts
// Cost merged: twilio kept, elevenlabs/openai added, total recomputed.
expect(c?.cost_breakdown).toMatchObject({
  twilio: 0.02,
  elevenlabs: 0.05,
  openai: 0.01,
  total: 0.08,
});
```

with:

```ts
// Cost merged: pre-seeded twilio kept (0.02), ElevenLabs's bundled credit
// figure lands under elevenlabs (0.05 + 0.01 = 0.06), openai starts at 0,
// total recomputed (0.02 + 0.06).
expect(c?.cost_breakdown).toMatchObject({
  twilio: 0.02,
  elevenlabs: 0.06,
  openai: 0,
  total: 0.08,
});
```

- [ ] **Step 2: Add the new Twilio-from-duration test**

Insert this test immediately after the closing `});` of the existing `"the webhook writes outcome, transcript, summary, score, cost"` test (after line 269):

```ts
test("an AI call with no pre-set Twilio cost is priced from its duration", async () => {
  // A fresh call row with NO twilio cost in cost_breakdown — the AI path
  // (ElevenLabs places the call) must price the Twilio leg from the duration.
  const convo = `convo-${stamp}-twilio`;
  const { data: freshCall } = await admin
    .from("calls")
    .insert({
      lead_id: leadId,
      campaign_id: campaignId,
      agent_id: agentId,
      twilio_number_id: twilioNumberId,
      direction: "outbound",
      status: "dialing",
      elevenlabs_conversation_id: convo,
      // No cost_breakdown — twilio must be computed, not carried forward.
    })
    .select("id")
    .single();

  const context = await playwrightRequest.newContext({
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    storageState: undefined,
  });
  const res = await context.post("/api/elevenlabs/post-call", {
    headers: { "content-type": "application/json" },
    data: {
      conversation_id: convo,
      analysis: { data_collection: { disposition: "voicemail" } },
      // Real ElevenLabs sends cost as a NUMBER of credits and a duration.
      metadata: { duration_seconds: 92, cost: 100 },
    },
  });
  expect(res.ok()).toBe(true);

  const { data: c } = await admin
    .from("calls")
    .select("cost_breakdown")
    .eq("id", freshCall!.id)
    .single();
  const cost = c?.cost_breakdown as {
    twilio: number;
    elevenlabs: number;
    openai: number;
    total: number;
  };
  // 92s → ceil(92/60)=2 min × $0.0185 = $0.037 (assumes default rate).
  expect(cost.twilio).toBe(0.037);
  // 100 credits × $0.000198 = $0.0198.
  expect(cost.elevenlabs).toBe(0.0198);
  expect(cost.openai).toBe(0);
  // total = 0.037 + 0.0198.
  expect(cost.total).toBeCloseTo(0.0568, 4);

  await admin.from("calls").delete().eq("id", freshCall!.id);
  await admin
    .from("elevenlabs_webhook_events")
    .delete()
    .eq("conversation_id", convo);
  await context.dispose();
});
```

- [ ] **Step 3: Verify the spec type-checks and lints**

Run: `npx tsc --noEmit && npx eslint tests/elevenlabs-post-call.spec.ts`
Expected: PASS. (Do not run `npx playwright test` — it needs the live environment.)

- [ ] **Step 4: Commit**

```bash
git add tests/elevenlabs-post-call.spec.ts
git commit -m "test(costs): contract for Twilio cost priced from AI call duration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Final verification + PR

- [ ] **Step 1: Full local verification**

Run: `npx tsc --noEmit && npx eslint . && npm run build`
Expected: all clean on the changed files. (Two pre-existing `tsc` errors in `tests/twilio-inbound.spec.ts` and `tests/twilio-status-webhook.spec.ts` are unrelated and present on main — confirm no NEW errors reference the files this plan touched.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/costs-correctness
gh pr create --base main --title "Costs correctness: real Twilio + OpenAI costs, central rates" --body "$(cat <<'EOF'
## What & why
The Costs page understated spend: AI (autopilot) calls captured \$0 of Twilio cost (the per-call calc only ran for manual human calls), and OpenAI was a flat \$0.001 guess. This makes the numbers correct and centralizes every rate.

## Changes
- **New `src/lib/costs/rates.ts`** — one env-overridable source for every rate + pricing helpers (`priceTwilioCall`, `priceOpenAiTokens`, `priceWhisper`).
- **Twilio cost on AI calls** — the ElevenLabs post-call webhook now prices the call leg from its duration (\$0.0185/min, billed per whole minute). Forward-only; existing rows untouched.
- **Real OpenAI cost** — the rolling-summary merge and the recording webhook's summary are priced from actual token usage; Whisper from audio minutes.
- **ElevenLabs stays one total** — their API doesn't break out voice vs LLM.
- **Centralized** the scattered lookup / number-rental / EL-credit / inline rates.

## Safety
- No migration, no historical data edits (forward-only). Rates env-overridable.
- Costs page UI/queries unchanged — `cost_breakdown` just becomes accurate. (Visual redesign is Phase 2.)

## Tests
- `tests/elevenlabs-post-call.spec.ts`: new test asserts an AI call with no pre-set Twilio cost is priced from its duration; corrected a stale pre-bundling cost assertion. Specs run live only.

## Local verification
`tsc`, `eslint`, `npm run build` clean on changed files.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then stop for review — do not merge.

---

## Self-review

**Spec coverage:**

- #1 Twilio on AI calls (forward-only, $0.0185) → Task 3 + helper in Task 1; test in Task 6. ✓
- #2 ElevenLabs total only → unchanged bundling; EL rate centralized (Task 3). ✓
- #3 OpenAI real token cost → Task 4 (summary merge + transcript summary) + Task 5 (recording route). ✓
- #4 Centralize rates → Task 1 (module) + Task 2 (lookup/number) + Task 3 (EL) + Task 5 (recording inline rates). ✓
- No migration / no data edits / forward-only → no migration task; Task 3 guards `prevCost.twilio`. ✓

**Placeholder scan:** none — every step shows full code. ✓

**Type consistency:** `priceTwilioCall`/`priceOpenAiTokens`/`priceWhisper`/`twilioLookupUsd`/`twilioNumberMonthlyUsd`/`elevenLabsUsdPerCredit` names match across Tasks 1–5. `summarizeTranscript` new return shape `{ text, promptTokens, completionTokens }` is consumed in Task 5 (`summary?.text`, `summary.promptTokens/completionTokens`). `callOpenAi`'s new return shape is consumed in Task 4 Step 2. ✓
