# Shared Lists via Lead Ownership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple active campaigns/agents dial one shared lead list without ever double-calling a lead — each lead is worked by exactly one campaign (the first to dial it), stamped atomically at dial time.

**Architecture:** A new nullable `leads.owner_campaign_id` records which campaign owns a lead. A tiny SQL function `claim_lead_for_dial` extends the dialer's existing atomic dial-time claim to also stamp ownership (coalesce) and refuse a lead already owned by another campaign — this single statement is the whole double-call guarantee. The `dial_queue` view stops collapsing overlaps to one winner: owned leads surface only to their owner, un-owned leads surface to every matching active campaign (first-available). Because each lead ends up single-campaign, the retry engine, caps, and lead-state model are untouched.

**Tech Stack:** Supabase Postgres (migration: additive column, partial index drop, `create or replace` view, plpgsql function, one-time backfill), Next.js server actions (`"use server"`), supabase-js RPC, Playwright (live-env contract spec).

**Branch:** `feat/shared-list-lead-ownership` (already exists, spec committed).

**Spec:** `docs/superpowers/specs/2026-07-17-shared-list-lead-ownership-design.md` — read it first.

**Repo rules that bind every task:**

- This repo's Next.js has breaking changes — the patterns this plan uses (server actions, RSC data fetching, supabase-js) are all copied from the exact neighboring code shown in each task; don't invent new Next APIs.
- Migrations hit the LIVE prod DB on `supabase db push`. This migration is additive/relaxing only (new nullable column, dropped constraint, replaced view, guarded backfill) — safe to apply before the code deploys. Do NOT push it until Task 8.
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- A husky pre-commit hook runs prettier/eslint on staged files — expected.

---

## Task 1: Migration — ownership column, claim function, queue rewrite, backfill

**Files:**

- Create: `supabase/migrations/20260717120000_shared_list_lead_ownership.sql`

Additive/relaxing only. Do NOT run `supabase db push` here (that's Task 8, after a prod pre-read).

- [ ] **Step 1: Write the migration**

```sql
-- Shared lists via lead ownership. Multiple active campaigns can dial one list;
-- each lead is worked by exactly one campaign (the first to dial it), recorded
-- in leads.owner_campaign_id and stamped atomically by claim_lead_for_dial.

-- 1. Ownership column. NULL = un-owned (shared pool). ON DELETE SET NULL returns
--    a deleted campaign's leads to the pool (mirrors calls.campaign_id).
alter table public.leads
  add column if not exists owner_campaign_id uuid
    references public.campaigns (id) on delete set null;

comment on column public.leads.owner_campaign_id is
  'The campaign that owns this lead for dialing. NULL = un-owned (shared pool). '
  'Stamped atomically at dial time by claim_lead_for_dial; sticky for the '
  'lead''s lifetime until released on list detach or owning-campaign delete.';

create index if not exists leads_owner_campaign_idx
  on public.leads (owner_campaign_id) where owner_campaign_id is not null;

-- 2. Allow a list to be actively attached to more than one campaign. This partial
--    unique index was the only DB-level block on sharing a list.
drop index if exists public.list_campaign_active_unique;

-- 3. The atomic dial-time claim, now ownership-aware. Wins iff the lead is still
--    due AND (un-owned OR already owned by this campaign); stamps the owner on a
--    first win. Postgres serializes the row write, so two campaigns reaching for
--    the same un-owned lead resolve to exactly one owner — the double-call
--    guarantee. Replaces the JS-side next_call_at CAS in src/lib/dialer/tick.ts.
create or replace function public.claim_lead_for_dial(
  in_lead_id uuid,
  in_campaign_id uuid
) returns boolean
language plpgsql
as $$
begin
  update public.leads
     set next_call_at = now() + interval '2 minutes',
         owner_campaign_id = coalesce(owner_campaign_id, in_campaign_id)
   where id = in_lead_id
     and (next_call_at is null or next_call_at <= now())
     and (owner_campaign_id is null or owner_campaign_id = in_campaign_id);
  return found;
end;
$$;

grant execute on function public.claim_lead_for_dial(uuid, uuid) to service_role;

-- 4. dial_queue: re-declared verbatim from 20260713120000, with TWO changes:
--    (a) ownership predicate on the join — an owned lead is visible only to its
--        owner; (b) drop the `distinct on (lead_id)` collapse so an un-owned
--        lead surfaces to EVERY matching active campaign (first-available).
--    Same output columns (create or replace requires it).
create or replace view public.dial_queue
with (security_invoker = true)
as
select
  q.lead_id,
  q.owner_id,
  q.business_phone,
  q.lead_timezone,
  q.next_call_at,
  q.campaign_id,
  q.agent_id,
  q.twilio_number_id,
  q.calling_hours_start,
  q.calling_hours_end,
  q.calls_per_hour_cap,
  q.calls_per_day_cap,
  q.concurrency_cap_per_user,
  q.daily_spend_cap,
  q.monthly_spend_cap,
  q.dial_priority
from (
  select
    l.id as lead_id,
    l.owner_id,
    l.business_phone,
    l.timezone as lead_timezone,
    l.next_call_at,
    c.id as campaign_id,
    c.created_at as campaign_created_at,
    c.agent_id,
    c.twilio_number_id,
    c.calling_hours_start,
    c.calling_hours_end,
    c.calls_per_hour_cap,
    c.calls_per_day_cap,
    c.concurrency_cap_per_user,
    c.daily_spend_cap,
    c.monthly_spend_cap,
    (case when l.status = 'callback' then 0 else 1 end) as dial_priority
  from public.leads l
  join public.campaigns c
    on c.owner_id = l.owner_id
    and c.status = 'active'
    and (c.autopilot_enabled = true or l.status = 'callback')
    and (l.owner_campaign_id is null or l.owner_campaign_id = c.id)
    and (
      exists (
        select 1 from public.list_campaign_attachments lca
        where lca.campaign_id = c.id
          and lca.list_id = l.list_id
          and lca.detached_at is null
      )
      or (
        c.audience_search is not null
        and l.company is not null
        and l.company ilike '%' || c.audience_search || '%'
      )
      or (
        c.smart_list_id is not null
        and exists (
          select 1 from public.smart_list_members slm
          where slm.smart_list_id = c.smart_list_id
            and slm.lead_id = l.id
        )
      )
    )
  where
    l.deleted_at is null
    and l.business_phone is not null
    and l.status in ('ready_to_call', 'callback')
    and (l.next_call_at is null or l.next_call_at <= now())
    and c.twilio_number_id is not null
    and l.line_type is distinct from 'mobile'
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    and (
      case
        when l.status = 'callback' then public.is_within_calling_hours(
          l.timezone, time '08:00:00', time '21:00:00', true
        )
        else public.is_within_calling_hours(
          l.timezone, c.calling_hours_start, c.calling_hours_end, false
        )
      end
    )
) q
order by q.dial_priority, q.next_call_at nulls first;

-- 5. One-time backfill: every already-dialed lead is owned by the campaign of
--    its most recent call, so in-progress leads stay glued to the campaign
--    already working them and can't be scooped when a list is later shared.
--    GUARD: only stamp when that campaign STILL currently targets the lead
--    (active list attachment / audience_search / smart list) — a lead whose
--    list was moved to another campaign since its last call is left un-owned so
--    its current campaign claims it fresh, never stranded. Guarded to only-null
--    owners; idempotent. Stable tiebreak (id desc) so re-runs are deterministic.
update public.leads l
   set owner_campaign_id = mr.campaign_id
  from (
    select distinct on (lead_id) lead_id, campaign_id
      from public.calls
     where campaign_id is not null
     order by lead_id, created_at desc, id desc
  ) mr
  join public.campaigns c on c.id = mr.campaign_id
 where mr.lead_id = l.id
   and l.owner_campaign_id is null
   and (
     exists (
       select 1 from public.list_campaign_attachments lca
       where lca.campaign_id = c.id
         and lca.list_id = l.list_id
         and lca.detached_at is null
     )
     or (
       c.audience_search is not null
       and l.company is not null
       and l.company ilike '%' || c.audience_search || '%'
     )
     or (
       c.smart_list_id is not null
       and exists (
         select 1 from public.smart_list_members slm
         where slm.smart_list_id = c.smart_list_id
           and slm.lead_id = l.id
       )
     )
   );
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260717120000_shared_list_lead_ownership.sql
git commit -m "feat(dialer): migration for shared-list lead ownership

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Types — leads.owner_campaign_id + claim_lead_for_dial

**Files:**

- Modify: `src/lib/supabase/database.types.ts` (hand-maintained in this repo)

- [ ] **Step 1: Add `owner_campaign_id` to the `leads` table type**

Find the `leads:` table block. Add `owner_campaign_id: string | null;` to `Row` (alphabetical position, after `next_call_at`-area fields — place it among the other columns keeping the file's ordering), and `owner_campaign_id?: string | null;` to both `Insert` and `Update`. Leave the `leads` `Relationships` array as-is (a new FK relationship entry is optional and not required for the queries this feature uses).

- [ ] **Step 2: Add the `claim_lead_for_dial` function type**

In the `Functions:` block (around line 2481), add this entry alphabetically — after `bump_api_rate_limit`, before `pre_call_check`:

```ts
claim_lead_for_dial: {
  Args: {
    in_lead_id: string;
    in_campaign_id: string;
  }
  Returns: boolean;
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "feat(dialer): types for owner_campaign_id + claim_lead_for_dial

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Dialer claim — stamp ownership via the RPC

**Files:**

- Modify: `src/lib/dialer/tick.ts` (`claimLeadForDial` at lines 183-209; its call site at line 374)

- [ ] **Step 1: Replace `claimLeadForDial` with the RPC wrapper**

Replace the whole function (doc comment + body, lines 183-209) with:

```ts
/**
 * Atomically claim a lead for dialing AND stamp its owning campaign, via the
 * `claim_lead_for_dial` SQL function. It leases `next_call_at` 2 minutes into
 * the future only if the lead is still due, and only if the lead is un-owned or
 * already owned by THIS campaign — stamping ownership on a first win. Postgres
 * serializes the row write, so two campaigns (or two ticks) racing on the same
 * un-owned lead resolve to exactly one owner; the loser gets `false` and skips.
 * This single statement is the whole cross-campaign double-call guarantee.
 */
async function claimLeadForDial(
  supabase: SupabaseAdmin,
  leadId: string,
  campaignId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_lead_for_dial", {
    in_lead_id: leadId,
    in_campaign_id: campaignId,
  });
  if (error) return false;
  return data === true;
}
```

- [ ] **Step 2: Pass the campaign id at the call site**

At line 374, change:

```ts
const claimed = await claimLeadForDial(supabase, c.lead_id);
```

to:

```ts
const claimed = await claimLeadForDial(supabase, c.lead_id, c.campaign_id);
```

(`c.campaign_id` is already guaranteed non-null by the guard at line 311.)

- [ ] **Step 3: Typecheck + lint**

Run: `npx tsc --noEmit` and `npx eslint src/lib/dialer/tick.ts`
Expected: clean. (The RPC now returns `boolean` per the Task 2 type; the old JS `lease`/`nowIso` locals are gone.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/dialer/tick.ts
git commit -m "feat(dialer): claim stamps owning campaign (shared-list ownership)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Attach/detach — allow sharing + release ownership on detach

**Files:**

- Modify: `src/lib/campaigns/list-attachments-actions.ts`

Two changes: (a) the exclusivity error strings no longer describe reality (the DB now permits multi-attach), so soften them; (b) detaching a list from a campaign must release that campaign's ownership of the list's non-terminal leads back to the pool.

- [ ] **Step 1: Release ownership when `setCampaignLists` detaches lists**

In `setCampaignLists`, the detach branch currently ends after updating `detached_at`. Replace the `toDetach` block (lines 65-77) with:

```ts
// Detach the ones no longer wanted. Detach can't hit a unique index, so by
// this point the operation is safe to complete.
const toDetach = (currentAttachments ?? []).filter(
  (row) => !nextListIds.has(row.list_id),
);
if (toDetach.length > 0) {
  const detachIds = toDetach.map((row) => row.id);
  const { error } = await supabase
    .from("list_campaign_attachments")
    .update({ detached_at: new Date().toISOString() })
    .in("id", detachIds);
  if (error) return { error: "Could not detach those lists." };

  // Release this campaign's ownership of the detached lists' still-dialable
  // leads back to the shared pool so other sharing campaigns can finish them.
  // Terminal leads keep their owner for history.
  const detachedListIds = toDetach.map((row) => row.list_id);
  await supabase
    .from("leads")
    .update({ owner_campaign_id: null })
    .eq("owner_campaign_id", input.campaignId)
    .in("list_id", detachedListIds)
    .in("status", ["ready_to_call", "callback", "resting"]);
}
```

- [ ] **Step 2: Soften the multi-attach error in `setCampaignLists`**

Replace the `if (error)` return inside the `toAttach` block (lines 52-60) with:

```ts
if (error) {
  // Nothing has been detached yet, so the campaign's list set is unchanged
  // and the user can retry. (Sharing a list across campaigns is allowed;
  // this only fires on a genuine insert failure.)
  return { error: "Could not attach those lists. Please try again." };
}
```

- [ ] **Step 3: Release ownership in `detachList` + soften `attachListToCampaign`**

Replace `attachListToCampaign`'s error string (lines 99-104) with:

```ts
if (error) {
  return { error: "Could not attach the list. Please try again." };
}
```

Replace the body of `detachList` (after the auth check, lines 119-128) with:

```ts
const { error } = await supabase
  .from("list_campaign_attachments")
  .update({ detached_at: new Date().toISOString() })
  .eq("list_id", listId)
  .is("detached_at", null);
if (error) return { error: "Could not detach the list." };

// Release ownership of this list's still-dialable leads back to the pool.
await supabase
  .from("leads")
  .update({ owner_campaign_id: null })
  .eq("list_id", listId)
  .in("status", ["ready_to_call", "callback", "resting"])
  .not("owner_campaign_id", "is", null);

revalidatePath(CAMPAIGNS_PATH);
revalidatePath(LISTS_PATH);
return { error: null };
```

- [ ] **Step 4: Typecheck + lint + commit**

Run: `npx tsc --noEmit` and `npx eslint src/lib/campaigns/list-attachments-actions.ts`
Expected: clean.

```bash
git add src/lib/campaigns/list-attachments-actions.ts
git commit -m "feat(campaigns): allow shared lists + release ownership on detach

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Manual dial — respect and stamp ownership

**Files:**

- Modify: `src/lib/dialer/call-now.ts` (`callNow`, `callNowFromLead`)
- Modify: `src/lib/twilio/human-call.ts` (`resolveHumanCallTarget`)

A manual call must stamp ownership too (else a manually-started lead in a shared list stays un-owned and another campaign's autopilot could also dial it — a cross-campaign double call). And a manual call to an already-owned lead should go out under its owner.

- [ ] **Step 1: Stamp ownership on the live `callNow` branch**

In `callNow`, the live branch bumps the lead after placing the call (lines 250-256). Immediately after that `.update({...}).eq("id", input.leadId)` block, add:

```ts
// Claim ownership for this campaign if the lead is still un-owned, so a
// shared-list autopilot tick for another campaign won't also dial it.
await admin
  .from("leads")
  .update({ owner_campaign_id: input.campaignId })
  .eq("id", input.leadId)
  .is("owner_campaign_id", null);
```

- [ ] **Step 2: Stamp ownership on the mock `callNow` branch**

Similarly, after the mock branch's lead bump (lines 313-319), add the identical block:

```ts
await admin
  .from("leads")
  .update({ owner_campaign_id: input.campaignId })
  .eq("id", input.leadId)
  .is("owner_campaign_id", null);
```

- [ ] **Step 3: Make `callNowFromLead` prefer the owner**

In `callNowFromLead`, extend the lead select (line 362) to include the owner and use it before any preference/picker logic. Change:

```ts
const { data: lead } = await userClient
  .from("leads")
  .select("id, list_id")
  .eq("id", leadId)
  .is("deleted_at", null)
  .maybeSingle();
if (!lead) return { error: "Lead not found." };
```

to:

```ts
const { data: lead } = await userClient
  .from("leads")
  .select("id, list_id, owner_campaign_id")
  .eq("id", leadId)
  .is("deleted_at", null)
  .maybeSingle();
if (!lead) return { error: "Lead not found." };

// If this lead is already owned, it belongs to that campaign — dial under it
// (ownership is released on detach/delete, so a set owner is always valid).
if (lead.owner_campaign_id) {
  return callNow({ leadId, campaignId: lead.owner_campaign_id, target });
}
```

- [ ] **Step 4: Make `resolveHumanCallTarget` prefer the owner**

In `src/lib/twilio/human-call.ts`, extend the lead select (line 66) to include `owner_campaign_id`, and prefer the owner when resolving the campaign. Change:

```ts
const { data: lead } = await supabase
  .from("leads")
  .select("business_phone, owner_phone, list_id")
  .eq("id", leadId)
  .maybeSingle();
if (!lead?.list_id) return null;
const leadPhone = target === "owner" ? lead.owner_phone : lead.business_phone;
if (!leadPhone) return null;

const { data: attach } = await supabase
  .from("list_campaign_attachments")
  .select("campaign_id")
  .eq("list_id", lead.list_id)
  .is("detached_at", null);
if (!attach || attach.length === 0) return null;

const campaignIds = attach.map((a) => a.campaign_id);

const { data: campaigns } = await supabase
  .from("campaigns")
  .select("id, twilio_number_id, status")
  .in("id", campaignIds)
  .eq("status", "active")
  .not("twilio_number_id", "is", null);
const campaign = (campaigns ?? []).find((c) => c.twilio_number_id !== null);
if (!campaign?.twilio_number_id) return null;
```

to:

```ts
const { data: lead } = await supabase
  .from("leads")
  .select("business_phone, owner_phone, list_id, owner_campaign_id")
  .eq("id", leadId)
  .maybeSingle();
if (!lead?.list_id) return null;
const leadPhone = target === "owner" ? lead.owner_phone : lead.business_phone;
if (!leadPhone) return null;

const { data: attach } = await supabase
  .from("list_campaign_attachments")
  .select("campaign_id")
  .eq("list_id", lead.list_id)
  .is("detached_at", null);
if (!attach || attach.length === 0) return null;

const campaignIds = attach.map((a) => a.campaign_id);

const { data: campaigns } = await supabase
  .from("campaigns")
  .select("id, twilio_number_id, status")
  .in("id", campaignIds)
  .eq("status", "active")
  .not("twilio_number_id", "is", null);
// Prefer the lead's owning campaign when it's among the active-with-number
// set; otherwise fall back to the first available one.
const usable = (campaigns ?? []).filter((c) => c.twilio_number_id !== null);
const campaign =
  usable.find((c) => c.id === lead.owner_campaign_id) ?? usable[0];
if (!campaign?.twilio_number_id) return null;
```

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npx tsc --noEmit`, `npx eslint src/lib/dialer/call-now.ts src/lib/twilio/human-call.ts`
Expected: clean.

```bash
git add src/lib/dialer/call-now.ts src/lib/twilio/human-call.ts
git commit -m "feat(dialer): manual dial respects and stamps lead ownership

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Playwright contract spec — the double-call guarantee

**Files:**

- Create: `tests/shared-list-ownership.spec.ts`

Covers the DB primitives that are the safety core: an un-owned lead surfaces to every sharing campaign; the claim stamps the owner and refuses a non-owner; an owned lead surfaces only to its owner. (Detach-release is verified at ship time — it's a straightforward guarded UPDATE in Task 4. Generate/live dialing are not exercised — no Twilio/real calls.) Specs run against the live environment; seed + clean up via the service-role client.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe.configure({ mode: "serial" });

/**
 * Shared-list lead ownership (the cross-campaign double-call guarantee):
 *  - An un-owned lead in a list shared by two active campaigns appears in
 *    dial_queue once PER campaign (first-available).
 *  - claim_lead_for_dial stamps the owner on a first win and refuses a claim
 *    from any other campaign.
 *  - Once owned, the lead appears in dial_queue only for its owner.
 * Live dialing / Twilio are not exercised. Like the other dialer specs, these
 * assume a weekday-daytime run (the dial_queue enforces calling hours); the
 * seeded campaigns use a full-day window to minimize time-of-day flakiness.
 */
test.describe("Shared list ownership", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  let admin: SupabaseClient;
  let ownerId: string;
  let listId: string;
  let numAId: string;
  let numBId: string;
  let agentAId: string;
  let agentBId: string;
  let campAId: string;
  let campBId: string;
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
      .insert({ owner_id: ownerId, name: `E2E Shared List ${stamp}` })
      .select("id")
      .single();
    listId = list!.id as string;

    const mkNumber = async (suffix: string) => {
      const { data } = await admin
        .from("twilio_numbers")
        .insert({
          phone_number: `+1555${tail}${suffix}`,
          friendly_name: `E2E Shared Number ${suffix} ${stamp}`,
          country: "US",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    numAId = await mkNumber("70");
    numBId = await mkNumber("71");

    const mkAgent = async (label: string) => {
      const { data } = await admin
        .from("agents")
        .insert({
          owner_id: ownerId,
          name: `E2E Shared Agent ${label} ${stamp}`,
          elevenlabs_agent_id: `e2e-shared-${label}-${stamp}`,
          prompt_personality: "x",
          prompt_environment: "x",
          prompt_tone: "x",
          prompt_goal: "x",
          prompt_guardrails: "x",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    agentAId = await mkAgent("A");
    agentBId = await mkAgent("B");

    const mkCampaign = async (
      label: string,
      agentId: string,
      numberId: string,
    ) => {
      const { data } = await admin
        .from("campaigns")
        .insert({
          owner_id: ownerId,
          name: `E2E Shared Campaign ${label} ${stamp}`,
          agent_id: agentId,
          twilio_number_id: numberId,
          status: "active",
          autopilot_enabled: true,
          // Full-day window so the seeded lead is within calling hours whenever
          // the spec runs (matches the other dialer specs' daytime assumption).
          calling_hours_start: "00:00:00",
          calling_hours_end: "23:59:59",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    campAId = await mkCampaign("A", agentAId, numAId);
    campBId = await mkCampaign("B", agentBId, numBId);

    // Share the one list with BOTH campaigns.
    await admin.from("list_campaign_attachments").insert([
      { list_id: listId, campaign_id: campAId },
      { list_id: listId, campaign_id: campBId },
    ]);

    // A dialable, un-owned lead (landline, in the shared list, due now).
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: listId,
        company: `E2E Shared Co ${stamp}`,
        business_phone: `+1555${tail}72`,
        status: "ready_to_call",
        line_type: "landline",
        timezone: "America/New_York",
      })
      .select("id")
      .single();
    leadId = lead!.id as string;
  });

  test.afterAll(async () => {
    await admin.from("leads").delete().eq("id", leadId);
    await admin
      .from("list_campaign_attachments")
      .delete()
      .eq("list_id", listId);
    await admin.from("campaigns").delete().in("id", [campAId, campBId]);
    await admin.from("agents").delete().in("id", [agentAId, agentBId]);
    await admin.from("twilio_numbers").delete().in("id", [numAId, numBId]);
    await admin.from("lists").delete().eq("id", listId);
  });

  test("an un-owned shared lead is offered to both campaigns", async () => {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    const campaignIds = (data ?? []).map((r) => r.campaign_id).sort();
    expect(campaignIds).toEqual([campAId, campBId].sort());
  });

  test("claim stamps the owner and refuses a non-owner", async () => {
    // Campaign A wins the un-owned lead.
    const { data: wonA } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campAId,
    });
    expect(wonA).toBe(true);

    const { data: afterA } = await admin
      .from("leads")
      .select("owner_campaign_id")
      .eq("id", leadId)
      .single();
    expect(afterA?.owner_campaign_id).toBe(campAId);

    // Make it due again so the "still due" predicate can't be what blocks B.
    await admin
      .from("leads")
      .update({ next_call_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", leadId);

    // Campaign B is refused — the lead is owned by A.
    const { data: wonB } = await admin.rpc("claim_lead_for_dial", {
      in_lead_id: leadId,
      in_campaign_id: campBId,
    });
    expect(wonB).toBe(false);

    const { data: afterB } = await admin
      .from("leads")
      .select("owner_campaign_id")
      .eq("id", leadId)
      .single();
    expect(afterB?.owner_campaign_id).toBe(campAId);
  });

  test("an owned lead surfaces only to its owner", async () => {
    // Ensure it's due so it can appear at all.
    await admin
      .from("leads")
      .update({ next_call_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", leadId);
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    expect(data?.length).toBe(1);
    expect(data?.[0]?.campaign_id).toBe(campAId);
  });
});
```

- [ ] **Step 2: Typecheck + lint the spec (it can't run locally)**

Run: `npx tsc --noEmit` and `npx eslint tests/shared-list-ownership.spec.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add tests/shared-list-ownership.spec.ts
git commit -m "test(dialer): shared-list ownership double-call guarantee spec

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Lead-detail "Owned by" indicator + Lists-page shared-awareness

**Files:**

- Modify: `src/app/(app)/leads/[id]/page.tsx` (server component — fetch the owner name)
- Modify: the lead-detail client view it renders (thread + render the indicator)
- Modify: `src/app/(app)/settings/lists/page.tsx` + `src/app/(app)/settings/lists/list-attachment-controls.tsx` (shared-list awareness — Step 5)

- [ ] **Step 1: Read the render wiring**

Read `src/app/(app)/leads/[id]/page.tsx` around lines 300-320 to see which client component receives `availableCampaigns` and how props are passed, and open that client component to find where campaign info renders. You'll add one prop and one line following the exact pattern already there.

- [ ] **Step 2: Fetch the owning campaign name in the server component**

In `page.tsx`, the `lead` select must include `owner_campaign_id` (add it to that select if not already present). Then, after the `availableCampaigns` block (around line 129), add:

```ts
// The campaign that currently owns this lead (shared-list ownership). Resolved
// from the leads row; name looked up once for display.
let ownerCampaignName: string | null = null;
if ((lead as { owner_campaign_id?: string | null }).owner_campaign_id) {
  const { data: ownerCampaign } = await supabase
    .from("campaigns")
    .select("name")
    .eq("id", (lead as { owner_campaign_id: string }).owner_campaign_id)
    .maybeSingle();
  ownerCampaignName = ownerCampaign?.name ?? null;
}
```

- [ ] **Step 3: Pass and render the indicator**

Pass `ownerCampaignName={ownerCampaignName}` to the client view alongside `availableCampaigns` (the prop group near line 307). In the client component, add the prop to its props type (`ownerCampaignName?: string | null;`) and render, near the existing campaign controls:

```tsx
{
  ownerCampaignName ? (
    <p className="text-muted-foreground text-xs">
      Owned by {ownerCampaignName}
    </p>
  ) : null;
}
```

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit`, `npx eslint "src/app/(app)/leads/[id]"`, `npm run build`
Expected: clean.

- [ ] **Step 5: Make the Lists settings page shared-aware** (closes a code-review finding on Task 4)

Now that a list can be attached to multiple active campaigns, the Lists settings page must stop implying single ownership. Read `src/app/(app)/settings/lists/page.tsx` and `src/app/(app)/settings/lists/list-attachment-controls.tsx` first. Currently the page collapses each list to ONE campaign (a `Map<listId, campaign>` that silently overwrites when a list has 2+ attachments), and the row's "Detach" button calls `detachList`, which detaches the list from **every** attached campaign and releases all its leads — so an admin can detach-all while believing they're detaching one hidden campaign.

Two required changes (keep them minimal):

1. In `page.tsx`, build the attachments as `Map<listId, campaign[]>` (all active attachments per list, not just the last), and pass the full array to the controls.
2. In `list-attachment-controls.tsx`, when a list has ≥2 attached campaigns: show all their names (e.g. "Shared: A, B"), and make the detach button's label + confirmation explicit that it detaches from ALL of them and returns the leads to the pool (e.g. confirm "Detach this list from all N campaigns? Their un-finished leads go back to the shared pool." and toast "Detached from N campaigns."). A single-campaign list keeps today's wording.

Match the file's existing component/toast/confirmation patterns. If the current confirmation is a plain `confirm()` or a dialog, follow whichever is there.

- [ ] **Step 6: Verify + commit**

Run: `npx tsc --noEmit`, `npx eslint "src/app/(app)/leads/[id]" "src/app/(app)/settings/lists"`, `npm run build`
Expected: clean.

```bash
git add "src/app/(app)/leads/[id]" "src/app/(app)/settings/lists"
git commit -m "feat(leads,lists): owned-by indicator + shared-list awareness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Deferred UI (fast-follow, not in v1)

The spec's UI section also mentions a shared-list confirmation note in the
attach dialog and a per-campaign "N leads owned here" counter. Both are pure
cosmetics — the feature is fully functional and verifiable without them (leads
get called once; the lead-detail "Owned by" line above confirms ownership). They
are intentionally deferred to keep v1 tight; raise with Marija whether to include
them now or after she's seen the feature working. Each is a small, isolated
add-on (a static line in the lists dialog; one count query on the campaign view).

---

## Task 8: Verify, PR, ship

- [ ] **Step 1: Full local verification**

```bash
npx tsc --noEmit
npx eslint src/lib/dialer src/lib/campaigns/list-attachments-actions.ts src/lib/twilio/human-call.ts "src/app/(app)/leads/[id]" tests/shared-list-ownership.spec.ts
npm run test:unit
npm run build
```

Expected: all clean/passing.

- [ ] **Step 2: Push + open the PR**

```bash
git push -u origin feat/shared-list-lead-ownership
gh pr create --title "feat(dialer): shared lists via lead ownership" --body "$(cat <<'EOF'
## What
Multiple active campaigns/agents can now dial one shared list without double-calling. Each lead is worked by exactly one campaign — the first to dial it — recorded in `leads.owner_campaign_id` and stamped atomically at dial time.

- Migration (additive/relaxing): `owner_campaign_id` column; drop the one-campaign-per-list unique index; `claim_lead_for_dial()` (ownership-aware atomic claim); `dial_queue` surfaces un-owned leads to all matching campaigns and owned leads only to their owner; one-time backfill (each dialed lead → its most-recent campaign).
- Dialer claim now stamps ownership and refuses a lead owned by another campaign — the whole cross-campaign double-call guarantee, in one SQL statement.
- Detaching a list from a campaign releases its non-terminal leads back to the pool; deleting a campaign releases them automatically (ON DELETE SET NULL).
- Manual "Call Now" / browser dial respect and stamp ownership.
- Lead detail shows "Owned by [campaign]".
- Spec: docs/superpowers/specs/2026-07-17-shared-list-lead-ownership-design.md

## Safety
- Additive column + dropped constraint + replaced view + guarded idempotent backfill — safe to apply to the live DB before deploy.
- Double-call guarantee rests on the atomic `claim_lead_for_dial` (Playwright-tested); each lead ends up single-campaign so retry/caps/lead-state are untouched.

## Testing
- `tests/shared-list-ownership.spec.ts` — un-owned lead offered to both campaigns; claim stamps owner + refuses non-owner; owned lead visible only to owner.
- tsc / eslint / build / unit clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Pre-read prod state, then apply the migration**

Before pushing the migration, read and show Marija the current state (per the production-data rule), because the migration backfills `owner_campaign_id`:

```bash
# Against prod PostgREST (service role in .env.local): how many leads will the
# backfill stamp, and across how many campaigns. Show these to Marija first.
```

Query via the prod PostgREST (see `reference_supabase_access`): count of leads with at least one campaign-attributed call (the backfill's target set) and the distinct owning-campaign count. Also spot-check the one known narrow edge: any non-terminal lead whose most-recent-call campaign is **paused** while a **different active** campaign also currently targets it (only reachable via an audience/smart-list overlap). At the platform's ~single-active-campaign scale this should be zero; if it isn't, decide whether to add `and c.status = 'active'` to the backfill guard before pushing. Report the numbers, then:

```bash
supabase db push --linked
```

Expected: applies `20260717120000_shared_list_lead_ownership.sql` cleanly.

- [ ] **Step 4: Merge + verify deploy**

```bash
gh pr merge --merge
```

Confirm the Vercel production deploy succeeds. Sanity-check via prod PostgREST that `leads.owner_campaign_id` and the `dial_queue` view respond, and that a normal single-campaign list still queues exactly as before (one row per due lead).

- [ ] **Step 5: Post-ship checks**

- Confirm the backfill stamped the expected number of leads (re-run the count).
- Manually verify detach-release once: note an owned lead, detach its list from the owning campaign, confirm `owner_campaign_id` cleared for non-terminal leads.
- Update memory `project_smart_lists.md` / a dialer memory with the shipped feature.

```

```
