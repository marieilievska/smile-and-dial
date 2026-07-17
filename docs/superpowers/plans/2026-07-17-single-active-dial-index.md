# Single-Active-Dial Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a partial unique index on `calls(lead_id)` that permits at most one in-flight **AI outbound** call per lead, closing the last double-call TOCTOU windows at the database level, and make the two AI insert paths treat the resulting unique-violation as "already in flight, skip".

**Architecture:** A partial unique index scoped by `direction = 'outbound' AND call_mode = 'ai' AND status in (active)` is the DB-level backstop to the app-level `claim_lead_for_dial` claim and the Call-Now in-flight re-check. Inbound (`direction`) and human browser-dial (`call_mode`) are deliberately excluded. A guarded, deterministic dedup runs in the same migration transaction so the index can build against live data. The two AI insert paths (`call-now.ts`, `tick.ts`) catch Postgres error `23505` and treat it as a graceful skip; `call-now.ts` also gains a server-side non-owner reject and an ownership-leak fix.

**Tech Stack:** Next.js (App Router, server actions), Supabase (Postgres + PostgREST, `@supabase/supabase-js` service-role client), SQL migrations via `supabase db push --linked`, Playwright specs (run against live prod — no CI gate), local gates `npx tsc --noEmit` + `npm run lint` + `npm run build`.

---

## Testing reality (read before executing)

This repo has **no CI and no local test database** (see memory `project_ci_test_db`). Playwright specs run against **live prod**. Therefore:

- **Local per-task gate = `npx tsc --noEmit` + `npm run lint`.** These need no env and run in the worktree. They are the red/green signal for the code tasks.
- **`npm run build`** runs once before the PR (final gate). If it complains about missing public env, make the main repo's env available in the worktree first (Task 0).
- **The Playwright scope spec (Task 5) can only pass once the migration is applied to prod** (Task 7). It is written as the contract now and run green after `supabase db push`. There is no local red-green for a DB index — that is expected here, not a gap.
- **The `callNow` non-owner reject** is not reachable from a Playwright spec (server action needs a Next session; the specs use the service-role client directly). It is verified by `tsc`/`build` + the manual check in Task 3. Do **not** extract it into a helper just to unit-test two lines (YAGNI).

Per superpowers instruction priority, this project's documented workflow (Playwright-as-contract, verify locally with tsc/lint/build) overrides the skill's default local-red-green TDD loop.

**Main-agent vs subagent:** Tasks **1** (prod read) and **7** (ship: PR, merge, `db push`, run spec, memory) touch production and require the user gate — the **main agent** performs them, not a subagent. Tasks **2–6** are pure code/docs and are subagent-drivable.

**Paths:** `MAIN` = `C:/Users/Marija/Documents/smile-and-dial-finalVersion` (holds `.env.local`). `WORKTREE` = `C:/Users/Marija/Documents/smile-and-dial-finalVersion/.claude/worktrees/agitated-khayyam-32d95f` (where all edits happen; current dir).

---

## Task 0: Make env available in the worktree (one-time setup)

**Files:** none (copies an untracked file).

- [ ] **Step 1: Copy the main repo's env into the worktree** (needed for `npm run build` and Playwright; not for tsc/eslint).

```bash
cp "C:/Users/Marija/Documents/smile-and-dial-finalVersion/.env.local" \
   "C:/Users/Marija/Documents/smile-and-dial-finalVersion/.claude/worktrees/agitated-khayyam-32d95f/.env.local"
```

- [ ] **Step 2: Confirm it is gitignored** (must not be committed).

Run: `cd "$WORKTREE" && git check-ignore .env.local`
Expected: prints `.env.local` (i.e. it is ignored). If it prints nothing, STOP — do not proceed; the file would be committable.

No commit for this task.

---

## Task 1: Reconcile pre-read (MAIN AGENT — read-only, user gate)

Confirm no pre-existing duplicate active AI-outbound rows exist (they would fail the index build), and show the current active-call state to the user before any write. Read-only.

**Files:** none.

- [ ] **Step 1: Read the exact active-AI-outbound set from prod** (the index predicate).

```bash
ENVF="C:/Users/Marija/Documents/smile-and-dial-finalVersion/.env.local"
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '"'\'' \r')
KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"'\'' \r')
curl -s "$URL/rest/v1/calls?direction=eq.outbound&call_mode=eq.ai&status=in.(queued,dialing,ringing,in_progress)&select=id,lead_id,status,twilio_call_sid,created_at&order=lead_id" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" > /tmp/active_ai_outbound.json
node -e 'const rows=require("/tmp/active_ai_outbound.json"); const byLead={}; for(const r of rows){(byLead[r.lead_id]??=[]).push(r);} const dups=Object.entries(byLead).filter(([,v])=>v.length>1); console.log("active AI-outbound rows:", rows.length); console.log("distinct leads:", Object.keys(byLead).length); console.log("leads with >1 active AI-outbound row (would block the index):", dups.length); console.log(JSON.stringify(dups,null,2));'
```

Expected: `leads with >1 active AI-outbound row = 0` (prod runs `closeStaleActiveCalls` every tick). If `> 0`, list those `lead_id`/`id`/`created_at`/`status` rows.

- [ ] **Step 2: Read a broader active-call overview for context** (all directions/modes).

```bash
curl -s "$URL/rest/v1/calls?status=in.(queued,dialing,ringing,in_progress)&select=id,lead_id,direction,call_mode,status,created_at&order=created_at.desc" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const rows=JSON.parse(d);const by=(k)=>rows.reduce((m,r)=>((m[r[k]]=(m[r[k]]||0)+1),m),{});console.log("total active rows:",rows.length);console.log("by direction:",by("direction"));console.log("by call_mode:",by("call_mode"));})'
```

- [ ] **Step 3: Present the numbers to the user and get the go-ahead.**

Report: active AI-outbound row count, count of leads with >1 such row (the blocker set), and the overview. If the blocker set is non-empty, describe exactly which rows the migration's dedup will terminalize (keep the one with a `twilio_call_sid`, else newest; fail the rest) and confirm none are two genuinely-live simultaneous calls before proceeding. **Do not run any write in this task.**

---

## Task 2: The migration (index + guarded dedup)

**Files:**

- Create: `supabase/migrations/20260717130000_calls_single_active_ai_dial_index.sql`

- [ ] **Step 1: Write the migration.**

```sql
-- Single-active-dial guarantee at the DB level (shared-list fast-follow).
-- A partial unique index on calls(lead_id) that permits at most ONE in-flight
-- AI outbound call per lead. This closes the last time-of-check/time-of-use
-- windows the app-level guards only narrow: manual "Call Now" vs the autopilot
-- tick (same-campaign, pre-existing) and cross-campaign manual-vs-tick
-- (shared-list Known limitation 2). Real calls = money + TCPA, so the guarantee
-- lives in the database, not just application code. Complements the atomic
-- claim_lead_for_dial from 20260717120000.
--
-- Scope (deliberate):
--   direction = 'outbound'  -> inbound calls insert status='in_progress'
--                              (inbound-webhook.ts); they are legitimately
--                              concurrent with an outbound dial and must never be
--                              blocked from being logged.
--   call_mode = 'ai'        -> covers the tick + manual "Call Now" (both 'ai').
--                              The human browser-dial path ('human') is left as
--                              the accepted Known limitation 3.
--   status in (active)      -> terminal rows are excluded, so a lead may accrue
--                              any number of finished calls; only one may be live.

-- 1. Reconcile (race-proof safety net): terminalize any pre-existing duplicate
--    active AI-outbound rows so the unique index can build. Keep the row that
--    actually placed a call (twilio_call_sid present), then the newest; fail the
--    rest -- mirrors closeStaleActiveCalls. Guarded + deterministic; a no-op once
--    the manual reconcile (plan Task 1) has cleared everything.
with ranked as (
  select id,
         row_number() over (
           partition by lead_id
           order by (twilio_call_sid is not null) desc, created_at desc, id desc
         ) as rn
    from public.calls
   where direction = 'outbound'
     and call_mode = 'ai'
     and status in ('queued', 'dialing', 'ringing', 'in_progress')
)
update public.calls c
   set status = 'failed',
       outcome = coalesce(c.outcome, 'failed'),
       ended_at = coalesce(c.ended_at, now())
  from ranked r
 where c.id = r.id
   and r.rn > 1;

-- 2. The partial unique index: at most one in-flight AI outbound call per lead.
create unique index if not exists calls_one_active_ai_outbound_dial_per_lead
  on public.calls (lead_id)
  where direction = 'outbound'
    and call_mode = 'ai'
    and status in ('queued', 'dialing', 'ringing', 'in_progress');

comment on index public.calls_one_active_ai_outbound_dial_per_lead is
  'At most one in-flight AI outbound call per lead. DB-level double-dial guard '
  '(money + TCPA); complements claim_lead_for_dial. Excludes inbound (direction) '
  'and human browser-dial (call_mode) by design.';
```

- [ ] **Step 2: Sanity-check the migration file is listed as pending** (does not apply it).

Run: `cd "$WORKTREE" && supabase migration list --linked 2>/dev/null | tail -5` — or, if that prompts for auth, simply confirm the file exists and is newer than `20260717120000`:
Run: `ls supabase/migrations/ | tail -3`
Expected: `20260717130000_calls_single_active_ai_dial_index.sql` is present and sorts last.

> Do NOT run `supabase db push` here. The apply happens in Task 7, after the code is merged/deployed.

- [ ] **Step 3: Commit.**

```bash
cd "$WORKTREE"
git add supabase/migrations/20260717130000_calls_single_active_ai_dial_index.sql
git commit -m "feat(db): partial unique index for single active AI outbound dial per lead"
```

---

## Task 3: `call-now.ts` — non-owner reject, 23505 handling, ownership-leak fix

**Files:**

- Modify: `src/lib/dialer/call-now.ts` (lead select ~86-92; live-insert failure block ~236-238)

- [ ] **Step 1: Add `owner_campaign_id` to the lead select and reject a non-owner campaign.**

Replace this block (currently ~lines 86-92):

```ts
const { data: lead } = await userClient
  .from("leads")
  .select("id, list_id, owner_id, business_phone, owner_phone")
  .eq("id", input.leadId)
  .is("deleted_at", null)
  .maybeSingle();
if (!lead) return { error: "Lead not found." };
```

with:

```ts
const { data: lead } = await userClient
  .from("leads")
  .select(
    "id, list_id, owner_id, business_phone, owner_phone, owner_campaign_id",
  )
  .eq("id", input.leadId)
  .is("deleted_at", null)
  .maybeSingle();
if (!lead) return { error: "Lead not found." };

// Sticky ownership (shared lists): if this lead already belongs to a DIFFERENT
// campaign, refuse to dial it under the one we were handed. callNowFromLead
// already routes owned leads to their owner; this guards DIRECT callers (e.g.
// the lead-detail Call dialog passing an explicit campaign) that the UI only
// hides. Un-owned (null) and same-owner both pass.
if (lead.owner_campaign_id && lead.owner_campaign_id !== input.campaignId) {
  return { error: "This lead is owned by another campaign." };
}
```

- [ ] **Step 2: Handle a lost insert race and release optimistic ownership on any insert failure.**

Replace this block (currently ~lines 236-238, inside the `if (liveCalling)` branch):

```ts
if (pendingError || !pending) {
  return { error: "Could not record the call before dialing." };
}
```

with:

```ts
if (pendingError || !pending) {
  // Release ownership if WE optimistically stamped it above — a failed insert
  // must not leave the lead owned by a campaign that never actually dialed it.
  // Guarded to only clear an owner we set (never a pre-existing one).
  if (stampedHere) {
    await admin
      .from("leads")
      .update({ owner_campaign_id: null })
      .eq("id", input.leadId)
      .eq("owner_campaign_id", input.campaignId);
  }
  // A unique-violation (23505) means another AI outbound dial for this lead
  // won the race at the DB level (calls_one_active_ai_outbound_dial_per_lead).
  // Surface it as the same "already in progress" copy the pre-call re-check
  // uses, not a generic failure.
  const code = (pendingError as { code?: string } | null)?.code;
  return {
    error:
      code === "23505"
        ? "This lead already has a call in progress."
        : "Could not record the call before dialing.",
  };
}
```

- [ ] **Step 3: Typecheck + lint.**

Run: `cd "$WORKTREE" && npx tsc --noEmit && npm run lint`
Expected: no errors. (`tsc` clean; eslint clean.)

- [ ] **Step 4: Manual check of the non-owner reject reasoning.**

Confirm by reading: `callNowFromLead` (same file, ~394) already calls `callNow` with `campaignId = lead.owner_campaign_id` for owned leads, so the new guard never fires on that path; un-owned leads pass (`owner_campaign_id` is null); only a direct `callNow` with a mismatched campaign is rejected. No behavior change for the common one-click path.

- [ ] **Step 5: Commit.**

```bash
cd "$WORKTREE"
git add src/lib/dialer/call-now.ts
git commit -m "fix(dialer): Call Now rejects non-owner campaign; handle active-dial 23505 + release stamped ownership on insert failure"
```

---

## Task 4: `tick.ts` — `placeLiveDialerCall` 23505 handling + honest accounting

**Files:**

- Modify: `src/lib/dialer/tick.ts` (`placeLiveDialerCall` signature/returns ~414-505; call site ~382-404)

- [ ] **Step 1: Change `placeLiveDialerCall`'s return type and all its returns.**

Change the signature line (currently ~line 414-423). Replace:

```ts
async function placeLiveDialerCall(
  supabase: SupabaseAdmin,
  c: {
    lead_id: string;
    campaign_id: string;
    agent_id: string | null;
    twilio_number_id: string | null;
    business_phone: string | null;
  },
): Promise<string | null> {
  if (!c.business_phone) return null;
  if (!c.twilio_number_id) return null;
```

with:

```ts
/** Result of one live placement: a dialed call id, a graceful skip because the
 *  lead already has an in-flight AI outbound call (the calls(lead_id) active-dial
 *  index rejected our insert), or a genuine error (both null/false). */
type LivePlaceResult = { callId: string | null; inFlight?: boolean };

async function placeLiveDialerCall(
  supabase: SupabaseAdmin,
  c: {
    lead_id: string;
    campaign_id: string;
    agent_id: string | null;
    twilio_number_id: string | null;
    business_phone: string | null;
  },
): Promise<LivePlaceResult> {
  if (!c.business_phone) return { callId: null };
  if (!c.twilio_number_id) return { callId: null };
```

- [ ] **Step 2: Handle 23505 on the insert.**

Replace (currently ~line 441):

```ts
if (pendingError || !pending) return null;
```

with:

```ts
if (pendingError || !pending) {
  // A unique-violation means another AI outbound dial for this lead won the
  // race at the DB level (calls_one_active_ai_outbound_dial_per_lead). Not an
  // error: the lead already has a live call and its next_call_at stays leased
  // (claim_lead_for_dial set it 2 min out), so it is not re-dialed immediately.
  // Ownership is already consistent (a successful claim is the gate), so no
  // rollback is needed here.
  if ((pendingError as { code?: string } | null)?.code === "23505") {
    return { callId: null, inFlight: true };
  }
  return { callId: null };
}
```

- [ ] **Step 3: Update the two remaining returns in `placeLiveDialerCall`.**

Change the failure-path return (currently ~line 482, after `finalizeFailedCall`):

```ts
await finalizeFailedCall(supabase, pending.id);
return null;
```

to:

```ts
await finalizeFailedCall(supabase, pending.id);
return { callId: null };
```

Change the success return (currently ~line 504):

```ts
return pending.id;
```

to:

```ts
return { callId: pending.id };
```

- [ ] **Step 4: Update the call site to record "already in flight" as blocked, not an error.**

Replace this block (currently ~lines 382-404, inside the `for` loop):

```ts
if (elevenLive) {
  // TS doesn't carry the lead_id / campaign_id null narrow from
  // the guard above into this scope, so re-bind into a typed
  // object the helper can take directly.
  const callId = await placeLiveDialerCall(supabase, {
    lead_id: c.lead_id,
    campaign_id: c.campaign_id,
    agent_id: c.agent_id,
    twilio_number_id: c.twilio_number_id,
    business_phone: c.business_phone,
  });
  if (callId) summary.dialed++;
  else summary.errors++;
} else {
  const callId = await placeMockCall(supabase, {
    lead_id: c.lead_id,
    campaign_id: c.campaign_id,
    agent_id: c.agent_id,
    twilio_number_id: c.twilio_number_id,
  });
  if (callId) summary.dialed++;
  else summary.errors++;
}
```

with:

```ts
if (elevenLive) {
  // TS doesn't carry the lead_id / campaign_id null narrow from
  // the guard above into this scope, so re-bind into a typed
  // object the helper can take directly.
  const res = await placeLiveDialerCall(supabase, {
    lead_id: c.lead_id,
    campaign_id: c.campaign_id,
    agent_id: c.agent_id,
    twilio_number_id: c.twilio_number_id,
    business_phone: c.business_phone,
  });
  if (res.callId) {
    summary.dialed++;
  } else if (res.inFlight) {
    // The DB active-dial index rejected the insert: another dialer already
    // has this lead in flight. Count it as blocked, not an error.
    summary.blocked++;
    summary.blockedReasons["already_in_flight"] =
      (summary.blockedReasons["already_in_flight"] ?? 0) + 1;
  } else {
    summary.errors++;
  }
} else {
  const callId = await placeMockCall(supabase, {
    lead_id: c.lead_id,
    campaign_id: c.campaign_id,
    agent_id: c.agent_id,
    twilio_number_id: c.twilio_number_id,
  });
  if (callId) summary.dialed++;
  else summary.errors++;
}
```

- [ ] **Step 5: Typecheck + lint.**

Run: `cd "$WORKTREE" && npx tsc --noEmit && npm run lint`
Expected: no errors.

- [ ] **Step 6: Commit.**

```bash
cd "$WORKTREE"
git add src/lib/dialer/tick.ts
git commit -m "fix(dialer): tick treats active-dial 23505 as a graceful skip, not an error"
```

---

## Task 5: Playwright scope spec

**Files:**

- Create: `tests/single-active-dial-index.spec.ts`

> Runs against live prod; passes only after Task 7 applies the migration. Mirrors the seed/cleanup shape of `tests/shared-list-ownership.spec.ts`.

- [ ] **Step 1: Write the spec.**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * The DB-level single-active-dial guarantee
 * (calls_one_active_ai_outbound_dial_per_lead):
 *  - A second in-flight AI OUTBOUND call for the same lead is rejected (23505).
 *  - The index is scoped: a terminal (completed) row, an INBOUND in-flight row,
 *    and a HUMAN in-flight row for the same lead all still insert fine.
 * These assert the migration is applied; they do not exercise Twilio/ElevenLabs.
 */
test.describe("Single active dial index", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let goalId: string;
  let numId: string;
  let agentId: string;
  let campaignId: string;
  let leadId: string;

  test.beforeAll(async () => {
    admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: owner } = await admin
      .from("profiles")
      .select("id")
      .eq("email", process.env.E2E_TEST_EMAIL ?? "")
      .single();
    ownerId = owner!.id;

    const { data: list } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E ActiveDial List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E ActiveDial Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id as string;

    const { data: num } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}80`,
        friendly_name: `E2E ActiveDial Number ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    numId = num!.id as string;

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E ActiveDial Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-activedial-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id as string;

    const { data: campaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        goal_id: goalId,
        name: `E2E ActiveDial Campaign ${stamp}`,
        agent_id: agentId,
        twilio_number_id: numId,
        status: "active",
        autopilot_enabled: true,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    campaignId = campaign!.id as string;

    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E ActiveDial Co ${stamp}`,
        business_phone: `+1555${tail}81`,
        status: "ready_to_call",
        line_type: "landline",
        timezone: "America/New_York",
      })
      .select("id")
      .single();
    leadId = lead!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("calls").delete().eq("lead_id", leadId);
    await admin.from("leads").delete().eq("id", leadId);
    await admin.from("campaigns").delete().eq("id", campaignId);
    await admin.from("goals").delete().eq("id", goalId);
    await admin.from("agents").delete().eq("id", agentId);
    await admin.from("twilio_numbers").delete().eq("id", numId);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("a second active AI outbound call for the same lead is rejected", async () => {
    const first = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "dialing",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(first.error).toBeNull();

    const second = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "queued",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(second.error?.code).toBe("23505");
  });

  test("terminal, inbound, and human rows for the same lead are allowed", async () => {
    // Terminal AI outbound (not in the partial index predicate).
    const completed = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "completed",
        outcome: "no_answer",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(completed.error).toBeNull();

    // In-flight INBOUND (excluded by direction) — must not collide with the
    // active outbound row from the previous test.
    const inbound = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "inbound",
        status: "in_progress",
        call_mode: "ai",
      })
      .select("id")
      .single();
    expect(inbound.error).toBeNull();

    // In-flight HUMAN browser-dial (excluded by call_mode).
    const human = await admin
      .from("calls")
      .insert({
        lead_id: leadId,
        campaign_id: campaignId,
        direction: "outbound",
        status: "dialing",
        call_mode: "human",
      })
      .select("id")
      .single();
    expect(human.error).toBeNull();
  });
});
```

- [ ] **Step 2: Typecheck + lint the spec.**

Run: `cd "$WORKTREE" && npx tsc --noEmit && npm run lint`
Expected: no errors. (Do NOT run the spec yet — the index does not exist in prod until Task 7.)

- [ ] **Step 3: Commit.**

```bash
cd "$WORKTREE"
git add tests/single-active-dial-index.spec.ts
git commit -m "test(dialer): scope spec for the single-active-dial index"
```

---

## Task 6: Update the shared-list spec doc

**Files:**

- Modify: `docs/superpowers/specs/2026-07-17-shared-list-lead-ownership-design.md` (the two "Known limitation" notes)

- [ ] **Step 1: Mark limitation 2 closed and add a fast-follow status line.**

In `docs/superpowers/specs/2026-07-17-shared-list-lead-ownership-design.md`, find the paragraph that begins:

```
**Known limitation 2 (manual dial, narrow race — accepted for v1):**
```

Append this sentence to the end of that paragraph (after the existing text that ends `...must first reconcile any existing duplicate active rows.`):

```
**Update (2026-07-17, fast-follow shipped):** the partial unique index
`calls_one_active_ai_outbound_dial_per_lead` (`direction='outbound' AND
call_mode='ai' AND status in active`, migration `20260717130000`) is now live,
closing this window and the pre-existing same-campaign Call-Now-vs-tick TOCTOU at
the DB level. See `docs/superpowers/specs/2026-07-17-single-active-dial-index-design.md`.
```

- [ ] **Step 2: Note that limitation 3 stays open by design.**

Find the paragraph beginning `**Known limitation 3 (human browser-dial doesn't claim ownership — accepted for v1):**` and append:

```
**Update (2026-07-17):** the fast-follow index is scoped to `call_mode='ai'`, so
the human browser-dial path is intentionally NOT covered — this limitation remains
open and accepted. Revisit only if human browser-dialing is used on a shared list.
```

- [ ] **Step 3: Commit.**

```bash
cd "$WORKTREE"
git add docs/superpowers/specs/2026-07-17-shared-list-lead-ownership-design.md
git commit -m "docs(spec): note single-active-dial index closes shared-list limitation 2"
```

---

## Task 7: Ship (MAIN AGENT — build gate, PR, apply migration, verify)

**Files:** none (operational).

- [ ] **Step 1: Full local gate.**

Run: `cd "$WORKTREE" && npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean. (Task 0 must have put `.env.local` in the worktree for `build`.)

- [ ] **Step 2: Push the branch and open the PR.**

```bash
cd "$WORKTREE"
git push -u origin HEAD
gh pr create --title "Single-active-dial DB index (shared-list fast-follow)" \
  --body "$(cat <<'EOF'
Partial unique index `calls_one_active_ai_outbound_dial_per_lead` on
`calls(lead_id)` where `direction='outbound' AND call_mode='ai' AND status in
('queued','dialing','ringing','in_progress')`. Closes the last double-call TOCTOU
windows at the DB level (pre-existing same-campaign Call-Now-vs-tick; shared-list
Known limitation 2). Inbound (`direction`) and human browser-dial (`call_mode`)
deliberately excluded.

- Migration includes a guarded, deterministic dedup so the index builds against
  live data (reconcile pre-read was run and shown before merge).
- `call-now.ts`: server-side non-owner reject; 23505 -> "already in progress";
  release optimistically-stamped ownership on insert failure.
- `tick.ts`: 23505 -> blocked ("already_in_flight"), not an error.
- Scope spec: `tests/single-active-dial-index.spec.ts`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Merge the PR (deploys the code before the index lands).**

```bash
cd "$WORKTREE"
gh pr merge --squash --delete-branch=false
```

Wait for Vercel to finish deploying the merged code.

- [ ] **Step 4: Apply the migration to prod.**

```bash
cd "$WORKTREE"
supabase db push --linked
```

Expected: applies `20260717130000_calls_single_active_ai_dial_index.sql` (dedup no-op if Task 1 was clean; index created). If it errors on a duplicate, re-run the Task 1 read to find the offending lead, resolve it, and re-push.

- [ ] **Step 5: Verify the index exists in prod.**

```bash
ENVF="C:/Users/Marija/Documents/smile-and-dial-finalVersion/.env.local"
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' "$ENVF" | cut -d= -f2- | tr -d '"'\'' \r')
KEY=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' "$ENVF" | cut -d= -f2- | tr -d '"'\'' \r')
# get_indexes RPC may not exist; instead confirm behavior via the spec in Step 6.
echo "Proceed to Step 6 to confirm the index behavior."
```

- [ ] **Step 6: Run the scope spec against prod.**

```bash
cd "$WORKTREE"
npx playwright test tests/single-active-dial-index.spec.ts
```

Expected: 2 passed. (The second insert returns `23505`; terminal/inbound/human inserts succeed.) The spec self-cleans its seeded rows.

- [ ] **Step 7: Update memory.**

Update `reference_shared_list_ownership.md` (and its `MEMORY.md` line): the `calls(lead_id)` partial unique index fast-follow is shipped — closes limitation 2 + the pre-existing same-campaign TOCTOU; limitation 3 (human browser-dial) intentionally left open; index is `direction='outbound' AND call_mode='ai'`.

---

## Self-review checklist (completed during planning)

- **Spec coverage:** index predicate + all three terms (Task 2); reconcile-first with pre-read shown + guarded in-migration dedup (Tasks 1, 2); 23505 handling in both AI paths (Tasks 3, 4); ownership-leak fix (Task 3); non-owner reject (Task 3); scope test (Task 5); shared-list doc update (Task 6); code-first rollout (Task 7). ✓
- **Placeholder scan:** every code/SQL step shows complete content; commands are exact. ✓
- **Type consistency:** `LivePlaceResult = { callId: string | null; inFlight?: boolean }` defined and used consistently across all `placeLiveDialerCall` returns and the single call site (Task 4); `owner_campaign_id` added to the select it is read from (Task 3). ✓
