# Human / Manual Call Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user place a live human call to a lead from the Lead detail page — talking through the browser — with the call recorded, transcribed (Whisper), summarized (OpenAI), and tagged "Human" in the call log.

**Architecture:** The browser uses the Twilio Voice SDK to connect to Twilio; Twilio calls back into our app, which creates the `calls` row (tagged `human`) and returns TwiML that dials the lead from the campaign's number and bridges the two parties with recording on. When the recording is ready, a callback transcribes + summarizes it. After hang-up, the user sets an outcome that runs the existing retry/side-effect pipeline.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (Postgres), Twilio Programmable Voice + Voice JS SDK (`@twilio/voice-sdk`), OpenAI (Whisper + chat). Twilio access tokens are minted with node `crypto` (HMAC-SHA256 JWT) — no Twilio server SDK, matching the existing hand-rolled Twilio HMAC code.

**Conventions in this repo (follow exactly):**

- All real external calls are gated behind a `*_LIVE === "live"` env flag; otherwise return deterministic mock values so tests never hit the network. Twilio voice uses `TWILIO_LIVE`, OpenAI uses `OPENAI_LIVE`.
- Server-only libs start with `import "server-only";`.
- Service-role Supabase client: `createClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })`.
- Migrations are applied with the Supabase CLI: `npx supabase db push --include-all`, then regenerate types with `npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`.
- Commit trailer: `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.
- Tests run with Playwright (`npx playwright test <file>`); there is no unit-test runner, so pure-logic tests are written as Playwright spec files using `test()` + `expect()` with no page (they run in Node).

---

## File Structure

**Create:**

- `supabase/migrations/20260612090000_human_call_mode.sql` — add `call_mode`, `placed_by` to `calls`.
- `src/lib/twilio/voice-token.ts` — mint a Twilio Voice AccessToken (crypto JWT).
- `src/app/api/twilio/voice-token/route.ts` — POST endpoint, auth-gated, returns `{ token, identity }`.
- `src/lib/twilio/human-call.ts` — resolve a lead's human-call target (lead phone, caller-ID number, campaign id, twilio number id) and create the `calls` row; build the dial TwiML.
- `src/app/api/twilio/voice-browser-dial/route.ts` — POST endpoint Twilio hits when the browser connects; returns dial TwiML.
- `src/app/api/twilio/recording/route.ts` — POST recording-status callback; kicks off transcription.
- `src/lib/openai/transcribe.ts` — Whisper transcription + single-transcript summary helpers.
- `src/lib/calls/human-disposition.ts` — server action: set a human call's outcome + run retry side-effects.
- `src/app/(app)/leads/[id]/manual-call-panel.tsx` — client component: Call button, Twilio Device, in-call UI, post-call disposition.
- `scripts/create-twiml-app.mjs` — one-off: create the Twilio TwiML App via REST, print the SID.
- `tests/human-call.spec.ts` — pure-logic tests for token minting, TwiML building, transcription mock.

**Modify:**

- `src/lib/supabase/database.types.ts` — regenerated after migration.
- `src/app/(app)/calls/columns.tsx` — add `call_mode` to `DisplayCall`; render a "Human" badge.
- `src/app/(app)/calls/page.tsx` (and its query) — select `call_mode`; add an All/AI/Human filter.
- `src/app/(app)/leads/[id]/page.tsx` — mount `ManualCallPanel`.
- `.env.local` — add `TWILIO_TWIML_APP_SID` after the script runs.
- `package.json` — add `@twilio/voice-sdk`.

**Natural phasing** (each phase leaves the app green and shippable):

- **Phase A** (Tasks 1–2): data + tagging.
- **Phase B** (Tasks 3–5): token + dial plumbing.
- **Phase C** (Tasks 6–7): recording → transcript → summary.
- **Phase D** (Tasks 8–10): client UI + disposition + wire-in.
- **Phase E** (Task 11): Twilio TwiML App + manual go-live test.

---

## Task 1: Migration — tag calls human/AI

**Files:**

- Create: `supabase/migrations/20260612090000_human_call_mode.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Tag each call as placed by the AI agent or a human, and record who placed a
-- human call. AI calls keep the default so existing rows need no backfill.
alter table public.calls
  add column if not exists call_mode text not null default 'ai'
    check (call_mode in ('ai', 'human')),
  add column if not exists placed_by uuid references public.profiles(id);

comment on column public.calls.call_mode is
  'ai = placed by the autopilot/agent; human = placed by a user via browser calling.';
comment on column public.calls.placed_by is
  'The user who placed a human call (null for AI calls).';

create index if not exists calls_call_mode_idx on public.calls (call_mode);
```

- [ ] **Step 2: Apply the migration**

Run: `npx supabase db push --include-all`
Expected: `Finished supabase db push.` with `20260612090000_human_call_mode.sql` applied.

- [ ] **Step 3: Regenerate types**

Run: `npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`
Then verify: `grep -c "call_mode" src/lib/supabase/database.types.ts` → expect ≥ 1.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260612090000_human_call_mode.sql src/lib/supabase/database.types.ts
git commit -m "feat(calls): add call_mode + placed_by for human calls

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Calls list — "Human" badge + AI/Human filter

**Files:**

- Modify: `src/app/(app)/calls/columns.tsx` (DisplayCall type + Lead cell)
- Modify: `src/app/(app)/calls/page.tsx` (query select + filter)

- [ ] **Step 1: Add `call_mode` to the DisplayCall type**

In `src/app/(app)/calls/columns.tsx`, add to the `DisplayCall` type (near `direction`):

```ts
call_mode: "ai" | "human";
```

- [ ] **Step 2: Render a "Human" badge in the Lead cell**

In `columns.tsx`, in the `company` column's `cell`, immediately after the company-name `<Link>`/`<span>` block (inside the inner `flex flex-col`), add:

```tsx
{
  c.call_mode === "human" ? (
    <span className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-700 uppercase dark:text-emerald-400">
      Human
    </span>
  ) : null;
}
```

- [ ] **Step 3: Select `call_mode` in the calls page query and map it**

In `src/app/(app)/calls/page.tsx`, find the `.select(...)` literal that loads call rows and add `call_mode` to it. Then where the raw row is mapped to `DisplayCall`, add `call_mode: c.call_mode ?? "ai",`.

Run: `grep -n "call_mode\|\.select(" "src/app/(app)/calls/page.tsx"` to locate the exact select string before editing.

- [ ] **Step 4: Add the All/AI/Human filter**

In `page.tsx`, read a `mode` search param and apply it to the query:

```ts
const mode = typeof searchParams.mode === "string" ? searchParams.mode : "all";
// ...after building the base calls query `q`:
if (mode === "human") q = q.eq("call_mode", "human");
else if (mode === "ai") q = q.eq("call_mode", "ai");
```

Add a 3-segment toggle in the filter popover that sets `?mode=all|ai|human` (mirror the existing chip/segmented controls already in the calls filter UI — match their markup). Run `grep -rn "searchParams" "src/app/(app)/calls/page.tsx"` to confirm the param-reading pattern in use.

- [ ] **Step 5: Verify build + typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status" | grep "error TS"` → expect no output.
Run: `npm run build` → expect exit 0.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/calls/columns.tsx" "src/app/(app)/calls/page.tsx"
git commit -m "feat(calls): Human badge + AI/Human filter on the calls list

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Twilio Voice access-token minting (pure lib)

**Files:**

- Create: `src/lib/twilio/voice-token.ts`
- Test: `tests/human-call.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/human-call.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

import { mintVoiceToken } from "../src/lib/twilio/voice-token";

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

test("mintVoiceToken builds a Twilio FPA voice grant token", () => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_API_KEY_SID = "SKtest";
  process.env.TWILIO_API_KEY_SECRET = "secret123";
  process.env.TWILIO_TWIML_APP_SID = "APtest";

  const token = mintVoiceToken({ identity: "user-1", nowSeconds: 1_000 });
  const [headerB64, payloadB64] = token.split(".");
  const header = decodeJwtPart(headerB64);
  const payload = decodeJwtPart(payloadB64);

  expect(header.cty).toBe("twilio-fpa;v=1");
  expect(payload.iss).toBe("SKtest");
  expect(payload.sub).toBe("ACtest");
  expect(payload.exp).toBe(1_000 + 3600);
  const grants = payload.grants as Record<string, unknown>;
  expect(grants.identity).toBe("user-1");
  const voice = grants.voice as { outgoing: { application_sid: string } };
  expect(voice.outgoing.application_sid).toBe("APtest");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/human-call.spec.ts -g "mintVoiceToken"`
Expected: FAIL — cannot find module `voice-token`.

- [ ] **Step 3: Implement `voice-token.ts`**

```ts
import "server-only";

import crypto from "node:crypto";

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a short-lived Twilio Voice access token (a "first-party access" JWT)
 * the browser SDK uses to connect. Hand-rolled with node crypto so we don't
 * pull in the Twilio server SDK — mirrors the existing hand-rolled Twilio HMAC
 * signature code in status-webhook.ts.
 *
 * `nowSeconds` is injectable for deterministic tests; defaults to wall clock.
 */
export function mintVoiceToken(opts: {
  identity: string;
  nowSeconds?: number;
}): string {
  const accountSid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const apiKeySid = process.env.TWILIO_API_KEY_SID ?? "";
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET ?? "";
  const appSid = process.env.TWILIO_TWIML_APP_SID ?? "";
  if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
    throw new Error(
      "Voice token requires TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_TWIML_APP_SID.",
    );
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    nbf: now,
    exp: now + 3600,
    grants: {
      identity: opts.identity,
      voice: {
        incoming: { allow: false },
        outgoing: { application_sid: appSid },
      },
    },
  };
  const enc = (o: object) => base64url(JSON.stringify(o));
  const signingInput = `${enc(header)}.${enc(payload)}`;
  const signature = base64url(
    crypto.createHmac("sha256", apiKeySecret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/human-call.spec.ts -g "mintVoiceToken"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/twilio/voice-token.ts tests/human-call.spec.ts
git commit -m "feat(twilio): mint Voice access tokens with node crypto

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Voice-token API route (auth-gated)

**Files:**

- Create: `src/app/api/twilio/voice-token/route.ts`

- [ ] **Step 1: Implement the route**

```ts
import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { mintVoiceToken } from "@/lib/twilio/voice-token";

/**
 * Returns a short-lived Twilio Voice access token for the logged-in user so
 * their browser can place a human call. Identity = the user's id, which the
 * dial handler echoes back on the call params.
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    const token = mintVoiceToken({ identity: user.id });
    return NextResponse.json({ token, identity: user.id });
  } catch {
    return NextResponse.json(
      { error: "Browser calling is not configured." },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 2: Verify build**

Run: `npm run build` → expect exit 0. (Route compiles; returns 503 until `TWILIO_TWIML_APP_SID` is set in Task 11 — expected.)

- [ ] **Step 3: Commit**

```bash
git add src/app/api/twilio/voice-token/route.ts
git commit -m "feat(twilio): voice-token endpoint for browser calling

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Human-call target resolution + dial TwiML (pure lib)

**Files:**

- Create: `src/lib/twilio/human-call.ts`
- Test: `tests/human-call.spec.ts` (append)

- [ ] **Step 1: Write the failing test (append to the spec)**

```ts
import { buildDialTwiml } from "../src/lib/twilio/human-call";

test("buildDialTwiml dials the lead from the caller id with recording on", () => {
  const xml = buildDialTwiml({
    leadPhone: "+16505551234",
    callerId: "+18885550000",
    appBaseUrl: "https://app.example.com",
  });
  expect(xml).toContain('callerId="+18885550000"');
  expect(xml).toContain("record-from-answer-dual");
  expect(xml).toContain("https://app.example.com/api/twilio/recording");
  expect(xml).toContain("<Number");
  expect(xml).toContain("+16505551234");
  expect(xml.startsWith("<?xml")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/human-call.spec.ts -g "buildDialTwiml"`
Expected: FAIL — cannot find module `human-call`.

- [ ] **Step 3: Implement `human-call.ts`**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type SupabaseAdmin = ReturnType<typeof createClient<Database>>;

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the TwiML that bridges the browser caller to the lead with recording
 *  enabled. `record-from-answer-dual` records both legs once the lead answers.
 *  The recording callback fires our /api/twilio/recording handler. */
export function buildDialTwiml(opts: {
  leadPhone: string;
  callerId: string;
  appBaseUrl: string;
}): string {
  const recordingCb = `${opts.appBaseUrl}/api/twilio/recording`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Dial callerId="${xmlEscape(opts.callerId)}" answerOnBridge="true" ` +
    `record="record-from-answer-dual" ` +
    `recordingStatusCallback="${xmlEscape(recordingCb)}" ` +
    `recordingStatusCallbackEvent="completed">` +
    `<Number>${xmlEscape(opts.leadPhone)}</Number>` +
    `</Dial>` +
    `</Response>`
  );
}

export type HumanCallTarget = {
  leadPhone: string;
  callerId: string;
  campaignId: string;
  twilioNumberId: string;
};

/**
 * Resolve where a human call to `leadId` should go: the lead's phone, the
 * campaign that owns the lead's list, and that campaign's Twilio number (used
 * as caller ID). Returns null when the lead has no phone or no active campaign
 * with a usable number — the caller surfaces a friendly error.
 */
export async function resolveHumanCallTarget(
  supabase: SupabaseAdmin,
  leadId: string,
): Promise<HumanCallTarget | null> {
  const { data: lead } = await supabase
    .from("leads")
    .select("business_phone, list_id")
    .eq("id", leadId)
    .maybeSingle();
  if (!lead?.business_phone || !lead.list_id) return null;

  // Find an active campaign attached to the lead's list that has a number.
  const { data: attach } = await supabase
    .from("list_campaign_attachments")
    .select("campaign:campaigns(id, twilio_number_id, status)")
    .eq("list_id", lead.list_id)
    .is("detached_at", null);
  const campaign = (attach ?? [])
    .map(
      (a) =>
        a.campaign as {
          id: string;
          twilio_number_id: string | null;
          status: string;
        } | null,
    )
    .find((c) => c && c.status === "active" && c.twilio_number_id);
  if (!campaign?.twilio_number_id) return null;

  const { data: num } = await supabase
    .from("twilio_numbers")
    .select("phone_number")
    .eq("id", campaign.twilio_number_id)
    .maybeSingle();
  if (!num?.phone_number) return null;

  return {
    leadPhone: lead.business_phone,
    callerId: num.phone_number,
    campaignId: campaign.id,
    twilioNumberId: campaign.twilio_number_id,
  };
}

/** Create the calls row for a human call and return its id. */
export async function createHumanCallRow(
  supabase: SupabaseAdmin,
  input: {
    leadId: string;
    campaignId: string;
    twilioNumberId: string;
    placedBy: string;
  },
): Promise<string | null> {
  const { data, error } = await supabase
    .from("calls")
    .insert({
      lead_id: input.leadId,
      campaign_id: input.campaignId,
      twilio_number_id: input.twilioNumberId,
      direction: "outbound",
      status: "dialing",
      call_mode: "human",
      placed_by: input.placedBy,
      outcome_source: "manual",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test tests/human-call.spec.ts -g "buildDialTwiml"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/twilio/human-call.ts tests/human-call.spec.ts
git commit -m "feat(twilio): resolve human-call target + build dial TwiML

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Browser-dial API route

**Files:**

- Create: `src/app/api/twilio/voice-browser-dial/route.ts`

- [ ] **Step 1: Implement the route**

Twilio POSTs form-encoded params when the browser connects. The client passes `leadId` and `userId` as custom params (Task 8). We resolve the target, create the call row, and return TwiML. The recording callback later attaches the call by the lead's most recent dialing human call (Task 7).

```ts
import { type NextRequest } from "next/server";

import { appBaseUrl } from "@/lib/app-url";
import { makeServiceClient } from "@/lib/supabase/admin";
import {
  buildDialTwiml,
  createHumanCallRow,
  resolveHumanCallTarget,
} from "@/lib/twilio/human-call";

function twimlSay(message: string): Response {
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="Polly.Joanna">${message}</Say><Hangup/></Response>`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const leadId = String(form.get("leadId") ?? "");
  const userId = String(form.get("userId") ?? "");
  if (!leadId || !userId) {
    return twimlSay("Missing call details.");
  }

  const supabase = makeServiceClient();
  const target = await resolveHumanCallTarget(supabase, leadId);
  if (!target) {
    return twimlSay(
      "This lead has no phone number or active campaign to call from.",
    );
  }

  await createHumanCallRow(supabase, {
    leadId,
    campaignId: target.campaignId,
    twilioNumberId: target.twilioNumberId,
    placedBy: userId,
  });

  const xml = buildDialTwiml({
    leadPhone: target.leadPhone,
    callerId: target.callerId,
    appBaseUrl: appBaseUrl() ?? request.nextUrl.origin,
  });
  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}
```

- [ ] **Step 2: Ensure `makeServiceClient` exists or inline it**

Run: `grep -rn "makeServiceClient\|export function makeService" src/lib/supabase/`
If `src/lib/supabase/admin.ts` with `makeServiceClient` does not exist, create it:

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/** Service-role Supabase client for server-side, RLS-bypassing work. */
export function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    throw new Error(
      "Service client requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
```

(If a similar helper already exists under another name — e.g. in `tick.ts` — prefer importing that and skip creating a new one.)

- [ ] **Step 3: Verify build**

Run: `npm run build` → expect exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/twilio/voice-browser-dial/route.ts src/lib/supabase/admin.ts
git commit -m "feat(twilio): browser-dial TwiML route for human calls

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Recording → Whisper transcript → OpenAI summary

**Files:**

- Create: `src/lib/openai/transcribe.ts`
- Create: `src/app/api/twilio/recording/route.ts`
- Test: `tests/human-call.spec.ts` (append)

- [ ] **Step 1: Write the failing test (mock-mode transcription returns null)**

```ts
import { transcribeAudioUrl } from "../src/lib/openai/transcribe";

test("transcribeAudioUrl returns null in mock mode", async () => {
  delete process.env.OPENAI_LIVE;
  const result = await transcribeAudioUrl("https://example.com/rec.mp3");
  expect(result).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx playwright test tests/human-call.spec.ts -g "transcribeAudioUrl"`
Expected: FAIL — cannot find module `transcribe`.

- [ ] **Step 3: Implement `transcribe.ts`**

```ts
import "server-only";

/** Transcribe an audio URL with OpenAI Whisper. The Twilio recording URL needs
 *  Basic auth (account SID : auth token). Returns null in mock mode or on
 *  failure so callers degrade gracefully. */
export async function transcribeAudioUrl(
  recordingUrl: string,
): Promise<string | null> {
  if (process.env.OPENAI_LIVE !== "live") return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  const token = process.env.TWILIO_AUTH_TOKEN ?? "";
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");

  const audioRes = await fetch(`${recordingUrl}.mp3`, {
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!audioRes.ok) return null;
  const buf = Buffer.from(await audioRes.arrayBuffer());

  const form = new FormData();
  form.append("file", new Blob([buf], { type: "audio/mpeg" }), "call.mp3");
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { text?: string };
  return json.text?.trim() || null;
}

/** Summarize a single call transcript into 1–2 sentences. Null in mock mode. */
export async function summarizeTranscript(
  transcript: string,
): Promise<string | null> {
  if (process.env.OPENAI_LIVE !== "live") return null;
  const apiKey = process.env.OPENAI_API_KEY;
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

- [ ] **Step 4: Run to verify it passes**

Run: `npx playwright test tests/human-call.spec.ts -g "transcribeAudioUrl"`
Expected: PASS.

- [ ] **Step 5: Implement the recording callback route**

```ts
import { type NextRequest } from "next/server";

import { makeServiceClient } from "@/lib/supabase/admin";
import {
  summarizeTranscript,
  transcribeAudioUrl,
} from "@/lib/openai/transcribe";

/**
 * Twilio recording-status callback. Fires once the human call recording is
 * ready. We attach it to the most recent in-flight human call for the dialed
 * number, store the recording path, transcribe (Whisper) and summarize
 * (OpenAI), and stamp the call's cost + duration.
 */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const recordingUrl = String(form.get("RecordingUrl") ?? "");
  const recordingDuration = Number(form.get("RecordingDuration") ?? "0");
  const calledNumber = String(form.get("Called") ?? form.get("To") ?? "");
  if (!recordingUrl) return new Response("", { status: 204 });

  const supabase = makeServiceClient();

  // Most recent human call still in 'dialing' to this lead phone.
  const { data: call } = await supabase
    .from("calls")
    .select("id, lead_id")
    .eq("call_mode", "human")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call) return new Response("", { status: 204 });

  const transcript = await transcribeAudioUrl(recordingUrl);
  const summary = transcript ? await summarizeTranscript(transcript) : null;

  // ~$0.027/min: voice + recording + whisper + summary (see spec).
  const minutes = Math.max(0, recordingDuration) / 60;
  const cost = Number((minutes * 0.027).toFixed(4));

  await supabase
    .from("calls")
    .update({
      recording_path: recordingUrl,
      transcript_json: transcript ? { text: transcript } : null,
      summary,
      duration_seconds: recordingDuration || null,
      status: "completed",
      ended_at: new Date().toISOString(),
      cost_breakdown: {
        twilio: Number((minutes * 0.0185).toFixed(4)),
        elevenlabs: 0,
        openai: Number((minutes * 0.006 + 0.001).toFixed(4)),
        lookup: 0,
        total: cost,
      },
    })
    .eq("id", call.id);

  // void calledNumber — reserved for stricter matching once multiple
  // concurrent human calls are supported.
  void calledNumber;
  return new Response("", { status: 204 });
}
```

- [ ] **Step 6: Verify build + run the spec**

Run: `npm run build` → expect exit 0.
Run: `npx playwright test tests/human-call.spec.ts` → expect all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/openai/transcribe.ts src/app/api/twilio/recording/route.ts tests/human-call.spec.ts
git commit -m "feat(calls): transcribe + summarize human call recordings

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: Manual-call panel (client) — add the SDK + Call button

**Files:**

- Modify: `package.json` (add `@twilio/voice-sdk`)
- Create: `src/app/(app)/leads/[id]/manual-call-panel.tsx`

- [ ] **Step 1: Add the Voice SDK dependency**

Run: `npm install @twilio/voice-sdk`
Expected: `@twilio/voice-sdk` appears in `package.json` dependencies.

- [ ] **Step 2: Implement the panel (Device lifecycle + in-call UI)**

```tsx
"use client";

import { Device, type Call } from "@twilio/voice-sdk";
import { Phone, PhoneOff, Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type Phase = "idle" | "connecting" | "in_call" | "ended" | "error";

export function ManualCallPanel({
  leadId,
  userId,
  onCallEnded,
}: {
  leadId: string;
  userId: string;
  onCallEnded: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const callRef = useRef<Call | null>(null);

  // Live timer while in a call.
  useEffect(() => {
    if (phase !== "in_call") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const startCall = useCallback(async () => {
    setError(null);
    setPhase("connecting");
    try {
      const res = await fetch("/api/twilio/voice-token", { method: "POST" });
      if (!res.ok) throw new Error("token");
      const { token } = (await res.json()) as { token: string };
      const device = new Device(token, { logLevel: "error" });
      deviceRef.current = device;
      const call = await device.connect({
        params: { leadId, userId },
      });
      callRef.current = call;
      call.on("accept", () => {
        setSeconds(0);
        setPhase("in_call");
      });
      call.on("disconnect", () => {
        setPhase("ended");
        onCallEnded();
      });
      call.on("error", () => setPhase("error"));
    } catch {
      setError("Couldn't start the call. Check your mic permissions.");
      setPhase("error");
    }
  }, [leadId, userId, onCallEnded]);

  const hangUp = useCallback(() => {
    callRef.current?.disconnect();
    deviceRef.current?.destroy();
  }, []);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    const next = !muted;
    call.mute(next);
    setMuted(next);
  }, [muted]);

  useEffect(() => () => deviceRef.current?.destroy(), []);

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  if (phase === "idle" || phase === "ended" || phase === "error") {
    return (
      <div className="flex flex-col gap-1">
        <Button onClick={startCall} className="gap-2">
          <Phone className="size-4" />
          {phase === "ended" ? "Call again" : "Call manually"}
        </Button>
        {error ? <p className="text-xs text-rose-600">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-lg border p-3">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-70" />
        <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
      </span>
      <span className="text-sm font-medium tabular-nums">
        {phase === "connecting" ? "Connecting…" : mmss}
      </span>
      <div className="ml-auto flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={toggleMute}
          className="gap-1"
        >
          {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={hangUp}
          className="gap-1"
        >
          <PhoneOff className="size-4" />
          Hang up
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify build**

Run: `npm run build` → expect exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json "src/app/(app)/leads/[id]/manual-call-panel.tsx"
git commit -m "feat(leads): browser manual-call panel (Twilio Voice SDK)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Disposition action + post-call disposition UI

**Files:**

- Create: `src/lib/calls/human-disposition.ts`
- Modify: `src/app/(app)/leads/[id]/manual-call-panel.tsx` (show disposition after `ended`)

- [ ] **Step 1: Implement the disposition server action**

```ts
"use server";

import { applyRetryForCall } from "@/lib/dialer/retry-engine";
import { OVERRIDABLE_OUTCOMES } from "@/lib/calls/outcomes";
import { makeServiceClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Set the outcome of the user's most recent human call to a lead, then run the
 * SAME retry/side-effect pipeline AI calls use (schedules next_call_at, rests
 * the lead, etc.). Note is appended to the call summary.
 */
export async function dispositionHumanCall(input: {
  leadId: string;
  outcome: string;
  note?: string;
}): Promise<{ error?: string }> {
  const authed = await createClient();
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return { error: "Not authenticated" };
  if (!OVERRIDABLE_OUTCOMES.includes(input.outcome as never)) {
    return { error: "Pick a valid outcome." };
  }

  const supabase = makeServiceClient();
  const { data: call } = await supabase
    .from("calls")
    .select("id, summary")
    .eq("lead_id", input.leadId)
    .eq("call_mode", "human")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!call) return { error: "No recent human call to update." };

  const summary = input.note?.trim()
    ? [call.summary, `Note: ${input.note.trim()}`].filter(Boolean).join("\n")
    : call.summary;

  await supabase
    .from("calls")
    .update({
      outcome: input.outcome,
      outcome_source: "manual",
      goal_met: input.outcome === "goal_met",
      summary,
    })
    .eq("id", call.id);

  // Drive the lead's next_call_at / status from the outcome, exactly like AI.
  await applyRetryForCall(call.id);
  return {};
}
```

- [ ] **Step 2: Add the disposition UI to the panel**

In `manual-call-panel.tsx`, when `phase === "ended"`, render a small outcome picker (a `<select>` over the common outcomes + a note field + Save button) that calls `dispositionHumanCall`. Add this import at top:

```ts
import { dispositionHumanCall } from "@/lib/calls/human-disposition";
```

Replace the `phase === "ended"` portion of the idle/ended/error branch with a disposition form. Minimal version:

```tsx
if (phase === "ended") {
  return (
    <DispositionForm
      leadId={leadId}
      onDone={() => {
        setPhase("idle");
        onCallEnded();
      }}
    />
  );
}
```

And add the component at the bottom of the file:

```tsx
function DispositionForm({
  leadId,
  onDone,
}: {
  leadId: string;
  onDone: () => void;
}) {
  const [outcome, setOutcome] = useState("goal_met");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const options = [
    "goal_met",
    "callback",
    "not_interested",
    "no_answer",
    "voicemail",
    "dnc",
  ];
  async function save() {
    setSaving(true);
    await dispositionHumanCall({ leadId, outcome, note });
    setSaving(false);
    onDone();
  }
  return (
    <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-3">
      <p className="text-sm font-medium">How did the call go?</p>
      <select
        value={outcome}
        onChange={(e) => setOutcome(e.target.value)}
        className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional)"
        className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
      />
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save outcome"}
      </Button>
    </div>
  );
}
```

- [ ] **Step 3: Verify build + typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status" | grep "error TS"` → expect no output.
Run: `npm run build` → expect exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/calls/human-disposition.ts "src/app/(app)/leads/[id]/manual-call-panel.tsx"
git commit -m "feat(calls): human-call disposition reusing the retry pipeline

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Wire the panel into the Lead detail page

**Files:**

- Modify: `src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1: Find the action cluster and the current user**

Run: `grep -n "auth.getUser\|action\|Call\|client\|<.*Client" "src/app/(app)/leads/[id]/page.tsx" | head`
Identify where lead actions render and whether the user id is already loaded (if not, load it via `supabase.auth.getUser()` in the page).

- [ ] **Step 2: Mount the panel**

Add the import and render it in the lead's action area, passing the lead id and the current user id. `onCallEnded` triggers a refresh of the lead's activity (use the page's existing refresh affordance, or a `router.refresh()` from a thin client wrapper if the action area is a client component):

```tsx
import { ManualCallPanel } from "./manual-call-panel";
// ...
<ManualCallPanel leadId={lead.id} userId={user.id} onCallEnded={() => {}} />;
```

(If the action area is a server component, place `ManualCallPanel` where other interactive controls already live — it is a client component and can be dropped into server JSX directly.)

- [ ] **Step 3: Verify build**

Run: `npm run build` → expect exit 0.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(leads): show the manual-call panel on the lead page

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 11: Create the Twilio TwiML App + manual go-live test

**Files:**

- Create: `scripts/create-twiml-app.mjs`
- Modify: `.env.local` (add `TWILIO_TWIML_APP_SID`)

This task runs AFTER the branch is deployed so the TwiML App can point at the live `voice-browser-dial` URL.

- [ ] **Step 1: Write the creation script**

```js
// Run once after deploy:  node scripts/create-twiml-app.mjs https://<deployed-app>
import fs from "node:fs";

const base = process.argv[2];
if (!base) {
  console.error("Usage: node scripts/create-twiml-app.mjs https://<app-url>");
  process.exit(1);
}
const env = Object.fromEntries(
  fs
    .readFileSync(".env.local", "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
const sid = env.TWILIO_ACCOUNT_SID;
const token = env.TWILIO_AUTH_TOKEN;
const auth = Buffer.from(`${sid}:${token}`).toString("base64");

const body = new URLSearchParams({
  FriendlyName: "Smile & Dial — Browser Calling",
  VoiceUrl: `${base}/api/twilio/voice-browser-dial`,
  VoiceMethod: "POST",
});
const res = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${sid}/Applications.json`,
  {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  },
);
const json = await res.json();
if (!res.ok) {
  console.error("Failed:", json);
  process.exit(1);
}
console.log("TWILIO_TWIML_APP_SID=" + json.sid);
```

- [ ] **Step 2: Run it against the deployed URL and capture the SID**

Run: `node scripts/create-twiml-app.mjs https://<deployed-app-url>`
Expected: prints `TWILIO_TWIML_APP_SID=AP...`.

- [ ] **Step 3: Add the SID to env**

Add `TWILIO_TWIML_APP_SID=AP...` to `.env.local` (and to the production environment so the deployed app can mint tokens). Do not commit `.env.local`.

- [ ] **Step 4: Manual go-live test (cannot be automated)**

1. Open a lead with a phone number on the deployed app.
2. Click **Call manually**, accept the mic prompt.
3. Confirm your headset connects and the lead's phone rings; talk.
4. Hang up; set an outcome + note.
5. Verify on the Calls page: a **Human**-tagged call appears with duration, recording, and (with `OPENAI_LIVE=live`) transcript + summary, and the lead's status/next-call reflects the outcome.

- [ ] **Step 5: Commit the script**

```bash
git add scripts/create-twiml-app.mjs
git commit -m "chore(twilio): script to provision the browser-calling TwiML App

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** browser calling (Tasks 3–6, 8), recording+Whisper+summary (Task 7), Human/AI tag + filter (Tasks 1–2), disposition via existing pipeline (Task 9), Lead-detail entry point (Task 10), programmatic TwiML App / no console work (Task 11). Recording disclosure and inbound are out of scope per spec — correctly absent.
- **Mock-mode safety:** all Twilio/OpenAI live calls are gated on `TWILIO_LIVE`/`OPENAI_LIVE`/SID presence; tests run without network.
- **Type consistency:** `call_mode` ('ai'|'human') and `placed_by` defined in Task 1 are used identically in Tasks 2, 5, 7, 9. `mintVoiceToken`, `buildDialTwiml`, `resolveHumanCallTarget`, `createHumanCallRow`, `transcribeAudioUrl`, `summarizeTranscript`, `dispositionHumanCall` signatures are consistent across tasks.
- **Open implementation choices flagged inline:** exact calls-page select string (Task 2 Step 3), reuse-vs-create `makeServiceClient` (Task 6 Step 2), and the lead-page action-area mount point (Task 10) are resolved by a `grep` at the start of each so the worker matches existing patterns rather than guessing.
