# Smart Lists Release 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a saved smart list (R1) self-updating and attachable to a campaign, so the AI dialer calls its members.

**Architecture:** A `smart_list_members` cache table holds each smart list's matching lead ids. A `pg_cron` job (every 3 min) plus an immediate refresh on attach rewrite the cache from the saved filter via the R1 `leads_matching_filter()` engine — single source of truth. A nullable `campaigns.smart_list_id` FK attaches one smart list to a campaign; the `dial_queue` view gains a third audience branch that unions smart-list members with the existing list + company-name branches. The campaign editor gets a smart-list picker with a live match count.

**Tech Stack:** Next.js 16 (App Router, Server Actions), Supabase Postgres (plpgsql `SECURITY DEFINER` fn, pg_cron + pg_net, RLS), TypeScript, Tailwind v4.

**Verification reality:** This repo has NO automated test runner (Playwright CI was removed — see project memory). "Tests" here = SQL probes against the DB + `tsc`/`eslint`/`npm run build` gates, exactly as the R1 spec's Testing section prescribes. Each task states the concrete probe and its expected output.

**Migration safety (locked rule):** `supabase db push --linked` hits the LIVE prod DB. All R2 schema changes are ADDITIVE (new table, new nullable column, view predicate). The `dial_queue` change is a no-op until a campaign actually has `smart_list_id` set (null for all rows until PR2's UI ships). Apply the column BEFORE deploying code that writes it.

**Ship as 2 PRs:**

- **PR 1 — Backend/infra** (Tasks 1–6): cache table + refresh fn + `campaigns.smart_list_id` + dial_queue branch + refresh endpoint + cron + types. Inert until used.
- **PR 2 — Campaign UI** (Tasks 7–11): live count action + create/update wiring + immediate-refresh-on-attach + dialog picker + page plumbing.

---

## File Structure

**PR 1**

- Create: `supabase/migrations/20260621120000_smart_list_members.sql` — members table + RLS + `refresh_smart_list(uuid)` fn.
- Create: `supabase/migrations/20260621120100_campaign_smart_list.sql` — `campaigns.smart_list_id` column + rebuilt `dial_queue` view (3rd branch).
- Create: `supabase/migrations/20260621120200_smart_lists_refresh_cron.sql` — pg_cron job.
- Create: `src/lib/smart-lists/cache.ts` — `refreshSmartListMembers(admin)`.
- Create: `src/app/api/smart-lists/refresh/route.ts` — secret-gated POST endpoint.
- Modify: `src/lib/supabase/database.types.ts` — regenerated.

**PR 2**

- Modify: `src/lib/campaigns/audience-actions.ts` — add `countSmartListMatches`.
- Modify: `src/lib/campaigns/actions.ts` — `CampaignInput.smartListId`, `buildUpdate`, immediate refresh on attach.
- Modify: `src/app/(app)/campaigns/campaign-settings-dialog.tsx` — `smartLists` prop, picker UI, state, live count, submit.
- Modify: `src/app/(app)/campaigns/page.tsx` — fetch smart-list options + `campaign.smart_list_id`, pass through.
- Modify: `src/app/(app)/campaigns/campaign-name-trigger.tsx` + `campaign-board.tsx` — thread the `smartLists` prop.

---

## PR 1 — Backend / infra

### Task 1: `smart_list_members` table + `refresh_smart_list()` function

**Files:**

- Create: `supabase/migrations/20260621120000_smart_list_members.sql`
- Reference (copy RLS shape from): `supabase/migrations/20260619150000_create_smart_lists.sql`

- [ ] **Step 1: Read the R1 smart_lists RLS policy to mirror it exactly**

Run: open `supabase/migrations/20260619150000_create_smart_lists.sql` and copy the exact `create policy …` statements + any `is_admin`/owner predicate it uses. The members policy must use the SAME admin/owner check, delegated through the parent `smart_lists` row.

- [ ] **Step 2: Write the migration**

```sql
-- Smart Lists R2: cached membership + atomic refresh.
--
-- A smart list (R1) is a saved filter recipe. R2 caches its matching lead ids in
-- smart_list_members so the dialer can read membership cheaply, and refreshes the
-- cache from the recipe via the R1 leads_matching_filter() engine (single source
-- of truth). Membership = presence of a row; refresh_smart_list() full-replaces a
-- list's rows atomically.

create table public.smart_list_members (
  smart_list_id uuid not null
    references public.smart_lists (id) on delete cascade,
  lead_id uuid not null
    references public.leads (id) on delete cascade,
  primary key (smart_list_id, lead_id)
);

create index smart_list_members_lead_idx
  on public.smart_list_members (lead_id);

comment on table public.smart_list_members is
  'Cached membership of each smart list (the lead ids matching its saved '
  'filter). Rewritten by refresh_smart_list() on a few-minute cron and '
  'immediately when a list is attached to a campaign. Read by the dial_queue '
  'view as a third audience branch.';

alter table public.smart_list_members enable row level security;

-- Mirror smart_lists access: a member row is visible/managed by whoever can see
-- its parent smart list (admin-scoped in R1). Delegated through the parent row.
create policy "smart_list_members are admin-managed via parent"
  on public.smart_list_members
  for all
  using (
    exists (
      select 1 from public.smart_lists sl
      where sl.id = smart_list_id
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role = 'admin'
        )
    )
  )
  with check (
    exists (
      select 1 from public.smart_lists sl
      where sl.id = smart_list_id
        and exists (
          select 1 from public.profiles p
          where p.id = auth.uid() and p.role = 'admin'
        )
    )
  );

grant select, insert, update, delete on public.smart_list_members to authenticated;

-- Atomically rebuild ONE smart list's members from its saved recipe. SECURITY
-- DEFINER so the cron (service role) and an admin "refresh now" both work; runs
-- as owner, can read all leads and write members. Returns the new member count.
create or replace function public.refresh_smart_list(in_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_filter jsonb;
  v_count integer;
begin
  select filter into v_filter from public.smart_lists where id = in_id;
  if v_filter is null then
    -- No such list (or null recipe): clear any stale rows, report zero.
    delete from public.smart_list_members where smart_list_id = in_id;
    return 0;
  end if;

  delete from public.smart_list_members where smart_list_id = in_id;
  insert into public.smart_list_members (smart_list_id, lead_id)
  select in_id, lf
  from public.leads_matching_filter(v_filter) as lf
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.refresh_smart_list(uuid) to authenticated, service_role;
```

> Note: if Step 1 reveals the codebase has an `is_admin()` SQL helper, replace the inline `exists (select 1 from public.profiles …)` with that helper for consistency.

- [ ] **Step 3: Apply to the linked DB**

Run: `npx supabase db push --linked`
Expected: applies `20260621120000_smart_list_members` with no error.

- [ ] **Step 4: Probe — refresh a real smart list and count members**

Pick an existing smart list id (`select id, name from smart_lists limit 5;`). Then:
Run (psql / Supabase SQL): `select public.refresh_smart_list('<id>'); select count(*) from smart_list_members where smart_list_id = '<id>';`
Expected: the function's return value equals the row count, and equals the Leads-page count for that same recipe (cross-check the R1 view). Compare against `select count(*) from leads_matching_filter((select filter from smart_lists where id='<id>'));`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260621120000_smart_list_members.sql
git commit -m "feat(smart-lists): members cache table + refresh_smart_list() fn"
```

---

### Task 2: `campaigns.smart_list_id` column + `dial_queue` third branch

**Files:**

- Create: `supabase/migrations/20260621120100_campaign_smart_list.sql`
- Reference (copy view verbatim, then add branch): `supabase/migrations/20260618120000_campaign_audience_filter.sql:29-125`

- [ ] **Step 1: Write the migration (column + full view recreate with branch C)**

```sql
-- Smart Lists R2: attach a smart list to a campaign + dial it.
--
-- campaigns.smart_list_id (nullable FK) attaches ONE smart list. The dial_queue
-- view gains a THIRD audience branch: a lead is in the queue if its list is
-- attached, OR the company-name filter matches, OR it is a member of the
-- campaign's attached smart list. Every safety gate (status, due, DNC, calling
-- hours, autopilot, per-lead dedup) is unchanged. on delete set null so deleting
-- a smart list simply detaches it instead of breaking the campaign.

alter table public.campaigns
  add column smart_list_id uuid
    references public.smart_lists (id) on delete set null;

comment on column public.campaigns.smart_list_id is
  'Optional attached smart list. When set, the campaign also targets every lead '
  'in smart_list_members for this list (in addition to attached lists and the '
  'company-name audience filter). NULL = no smart list attached.';

create or replace view public.dial_queue
with (security_invoker = true)
as
select distinct on (q.lead_id)
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
    -- Membership: attached list, OR company-name filter, OR smart-list member.
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
    and not exists (
      select 1 from public.dnc_entries d
      where d.phone = l.business_phone
    )
    and (
      case
        when l.status = 'callback' then public.is_within_calling_hours(
          l.timezone, time '08:00:00', time '21:00:00'
        )
        else public.is_within_calling_hours(
          l.timezone, c.calling_hours_start, c.calling_hours_end
        )
      end
    )
) q
order by q.lead_id, q.dial_priority, q.campaign_created_at, q.campaign_id;

comment on view public.dial_queue is
  'Leads eligible for the AUTO-dialer: ready, due, not on DNC, attached to an '
  'active campaign with a Twilio number via an attached list, the company-name '
  'audience filter, OR membership of the campaign''s attached smart list. '
  'Cold/retry leads require autopilot and dial inside the campaign window; '
  'callbacks dial regardless of autopilot inside the 08:00-21:00 local floor. '
  'One row per lead (callbacks first, then oldest campaign). Re-check caps in '
  'code at dial time before firing.';

grant select on public.dial_queue to authenticated;
```

- [ ] **Step 2: Capture the pre-change dial_queue row count (baseline)**

Run (before push, against current prod): `select count(*) from dial_queue;`
Record the number N.

- [ ] **Step 3: Apply to the linked DB**

Run: `npx supabase db push --linked`
Expected: applies `20260621120100_campaign_smart_list` with no error.

- [ ] **Step 4: Probe — dial_queue is unchanged (no campaign has a smart list yet)**

Run: `select count(*) from dial_queue;`
Expected: equals baseline N from Step 2 (the new branch is inert because every `campaigns.smart_list_id` is null). Also: `select count(*) from campaigns where smart_list_id is not null;` → expected 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260621120100_campaign_smart_list.sql
git commit -m "feat(smart-lists): campaigns.smart_list_id + dial_queue third branch"
```

---

### Task 3: Refresh library `refreshSmartListMembers`

**Files:**

- Create: `src/lib/smart-lists/cache.ts`
- Reference (shape): `src/lib/dialer/best-time-cache.ts` (the `refreshBestTimeHeatmap(admin)` analog)

- [ ] **Step 1: Write the library**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type Admin = SupabaseClient<Database>;

export type SmartListRefreshSummary = {
  ok: true;
  refreshedLists: number;
  totalMembers: number;
  computedAt: string;
};

/**
 * Rebuild the membership cache for every smart list currently attached to a
 * campaign. Each list is rebuilt atomically by the refresh_smart_list() SQL
 * function (delete + re-insert from its saved recipe). Unattached lists are
 * skipped — nothing reads their members. Called by the cron endpoint.
 */
export async function refreshSmartListMembers(
  admin: Admin,
): Promise<SmartListRefreshSummary> {
  const { data: rows, error } = await admin
    .from("campaigns")
    .select("smart_list_id")
    .not("smart_list_id", "is", null);
  if (error) throw new Error("Could not read attached smart lists.");

  const ids = Array.from(
    new Set(
      (rows ?? [])
        .map((r) => r.smart_list_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );

  let totalMembers = 0;
  for (const id of ids) {
    const { data, error: rpcError } = await admin.rpc("refresh_smart_list", {
      in_id: id,
    });
    if (rpcError) throw new Error(`refresh_smart_list failed for ${id}.`);
    totalMembers += (data as number | null) ?? 0;
  }

  return {
    ok: true,
    refreshedLists: ids.length,
    totalMembers,
    computedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` (filter the 3 known twilio spec errors)
Expected: no errors in `cache.ts`. (Depends on Task 6's regenerated types for the `refresh_smart_list` RPC + `smart_list_id` column — if running before Task 6, expect those two type errors and resolve them when types regenerate.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/smart-lists/cache.ts
git commit -m "feat(smart-lists): refreshSmartListMembers cache rebuilder"
```

---

### Task 4: Refresh endpoint `/api/smart-lists/refresh`

**Files:**

- Create: `src/app/api/smart-lists/refresh/route.ts`
- Reference (copy verbatim, swap the lib call): `src/app/api/best-time/refresh/route.ts`

- [ ] **Step 1: Write the route (identical auth to best-time/refresh)**

```ts
import { NextResponse, type NextRequest } from "next/server";

import { createClient as createServiceClient } from "@supabase/supabase-js";

import { refreshSmartListMembers } from "@/lib/smart-lists/cache";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Rebuild the smart-list membership cache for every attached smart list. The
 * pg_cron job hits this every few minutes (via pg_net); an attach also kicks an
 * immediate refresh inline (see campaigns/actions). Secret-gated EXACTLY like
 * /api/dialer/tick and /api/best-time/refresh — the `x-dialer-secret` header
 * compared to DIALER_TICK_SECRET, with a signed-in admin fallback.
 */
export async function POST(request: NextRequest) {
  const secret = request.headers.get("x-dialer-secret");
  const expected = process.env.DIALER_TICK_SECRET ?? "";

  let authorized = false;
  if (expected && secret && secret === expected) {
    authorized = true;
  } else {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const { data: me } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (me?.role === "admin") authorized = true;
    }
  }

  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    return NextResponse.json(
      { error: "Supabase service role env missing." },
      { status: 500 },
    );
  }

  try {
    const admin = createServiceClient<Database>(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const summary = await refreshSmartListMembers(admin);
    return NextResponse.json(summary);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit` (filtered) ; `npx eslint src/app/api/smart-lists/refresh/route.ts`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/smart-lists/refresh/route.ts
git commit -m "feat(smart-lists): /api/smart-lists/refresh endpoint"
```

---

### Task 5: pg_cron refresh job (every 3 min)

**Files:**

- Create: `supabase/migrations/20260621120200_smart_lists_refresh_cron.sql`
- Reference (copy pattern incl. exact URL host + secret read): `supabase/migrations/20260612150000_best_time_refresh_cron.sql`

- [ ] **Step 1: Write the cron migration**

```sql
-- Refresh smart-list membership every few minutes.
--
-- A smart list (saved filter) auto-includes any new lead matching the filter.
-- This cron rebuilds the smart_list_members cache for every attached smart list
-- so freshly imported leads become callable within minutes. Mirrors the
-- best-time-refresh cron: pg_net POST with the dialer_tick_secret as the
-- x-dialer-secret header; the endpoint rejects an empty/wrong secret (401).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid)
from cron.job
where jobname = 'smart-lists-refresh';

select cron.schedule(
  'smart-lists-refresh',
  '*/3 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://referrizer-smile-and-dial.vercel.app/api/smart-lists/refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-dialer-secret', coalesce(
        (select dialer_tick_secret from public.app_settings limit 1), ''
      )
    ),
    body := '{}'::jsonb
  );
  $cmd$
);
```

- [ ] **Step 2: Apply + verify the job is registered**

Run: `npx supabase db push --linked`
Then: `select jobname, schedule from cron.job where jobname = 'smart-lists-refresh';`
Expected: one row, schedule `*/3 * * * *`.

- [ ] **Step 3: Probe — endpoint security + success**

Run (no secret): `curl -sS -X POST https://referrizer-smile-and-dial.vercel.app/api/smart-lists/refresh`
Expected: `{"error":"Unauthorized"}` (401).
Run (with secret — read `dialer_tick_secret` from app_settings; do NOT print it):
`curl -sS -X POST -H "x-dialer-secret: $SECRET" https://referrizer-smile-and-dial.vercel.app/api/smart-lists/refresh`
Expected: `{"ok":true,"refreshedLists":0,"totalMembers":0,...}` (0 because nothing is attached yet). Must wait for the PR1 deploy to land first.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260621120200_smart_lists_refresh_cron.sql
git commit -m "feat(smart-lists): pg_cron refresh job (every 3 min)"
```

---

### Task 6: Regenerate types + ship PR 1

**Files:**

- Modify: `src/lib/supabase/database.types.ts`

- [ ] **Step 1: Regenerate types from the linked DB**

Run: `npx supabase gen types typescript --linked > src/lib/supabase/database.types.ts`
Expected: diff shows new `smart_list_members` table, `campaigns.smart_list_id`, and the `refresh_smart_list` function in the `Functions` block.

- [ ] **Step 2: Full local gates**

Run: `npx tsc --noEmit` (filtered) ; `npx eslint src/lib/smart-lists/cache.ts src/app/api/smart-lists/refresh/route.ts` ; `npm run build`
Expected: all green.

- [ ] **Step 3: Commit + open + merge PR 1**

```bash
git add src/lib/supabase/database.types.ts
git commit -m "chore(smart-lists): regenerate types for R2 backend"
# branch was feat/smart-lists-r2-backend; push, PR, squash-merge, verify deploy green
```

- [ ] **Step 4: Post-deploy probe (the cron's first live run)**

After the deploy is green, hit the endpoint with the secret (Task 5 Step 3) and confirm `refreshedLists:0`. Confirm `dial_queue` count still equals baseline N.

---

## PR 2 — Campaign UI

### Task 7: `countSmartListMatches` server action

**Files:**

- Modify: `src/lib/campaigns/audience-actions.ts`

- [ ] **Step 1: Add the action (after `countAudienceMatches`)**

```ts
import { runFilterRpc } from "@/lib/smart-lists/resolve";
import type { RecipeNode } from "@/lib/smart-lists/recipe";
// (add these imports at the top alongside the existing ones)

/**
 * Count how many leads a smart list's saved filter currently matches. Powers
 * the live "matches N leads" preview when a smart list is picked in campaign
 * settings. Uses the same R1 evaluator as the Leads page so the preview equals
 * what the dialer will see once members refresh.
 */
export async function countSmartListMatches(input: {
  smartListId: string;
}): Promise<AudienceCountResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { count: null, error: "You are not signed in." };

  const { data: sl } = await supabase
    .from("smart_lists")
    .select("filter")
    .eq("id", input.smartListId)
    .maybeSingle();
  if (!sl) return { count: null, error: "Smart list not found." };

  const { ids, error } = await runFilterRpc(
    supabase,
    sl.filter as unknown as RecipeNode,
  );
  if (error) return { count: null, error };
  return { count: ids.length, error: null };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` (filtered)
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/campaigns/audience-actions.ts
git commit -m "feat(smart-lists): countSmartListMatches preview action"
```

---

### Task 8: Wire `smartListId` through campaign create/update + immediate refresh

**Files:**

- Modify: `src/lib/campaigns/actions.ts`

- [ ] **Step 1: Add `smartListId` to `CampaignInput` (after `audienceSearch`, ~line 95)**

```ts
  /** Optional attached smart list id (smart_lists.id). When set, the campaign
   *  also dials every member of that smart list. Empty = no smart list. */
  smartListId?: string;
```

- [ ] **Step 2: Add it to `buildUpdate` (after the `audience_search` line, ~line 133)**

```ts
    smart_list_id: input.smartListId?.trim() || null,
```

- [ ] **Step 3: Immediate refresh on attach — add a helper + call it from create & update**

Add near the top helpers:

```ts
/** Rebuild a smart list's member cache immediately so a freshly attached list
 *  is callable within seconds, not at the next cron tick. Best-effort: the cron
 *  is the backstop, so a hiccup never blocks the save. */
async function refreshAttachedSmartList(
  supabase: Awaited<ReturnType<typeof createClient>>,
  smartListId: string | null | undefined,
): Promise<void> {
  if (!smartListId) return;
  try {
    await supabase.rpc("refresh_smart_list", { in_id: smartListId });
  } catch {
    // best-effort — the 3-min cron will reconcile
  }
}
```

In `createCampaign`, after `await reapplyAgentIntegration(supabase, payload.agent_id);`:

```ts
await refreshAttachedSmartList(supabase, payload.smart_list_id);
```

In `updateCampaign`, after its `await reapplyAgentIntegration(supabase, payload.agent_id);`:

```ts
await refreshAttachedSmartList(supabase, payload.smart_list_id);
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit` (filtered)
Expected: clean (`smart_list_id` is now a known column; `refresh_smart_list` a known RPC, both from Task 6's types).

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaigns/actions.ts
git commit -m "feat(smart-lists): persist campaign smart_list_id + refresh on attach"
```

---

### Task 9: Add the smart-list picker to the campaign dialog

**Files:**

- Modify: `src/app/(app)/campaigns/campaign-settings-dialog.tsx`

- [ ] **Step 1: Extend props + types**

Add to `CampaignData` (after `audience_search`, ~line 73):

```ts
smart_list_id: string | null;
```

Add a sentinel near `NO_TEMPLATE` (~line 81):

```ts
/** Sentinel for "no smart list attached". */
const NO_SMART_LIST = "__none__";
```

Add `smartLists` to the component props destructure + type (alongside `eligibleLists`):

```ts
  smartLists,
```

```ts
  /** Admin's saved smart lists, selectable as a campaign audience. */
  smartLists: Option[];
```

Add the import for the count action (alongside `countAudienceMatches`, line 41):

```ts
import {
  countAudienceMatches,
  countSmartListMatches,
} from "@/lib/campaigns/audience-actions";
```

(Replace the existing single-name import.)

- [ ] **Step 2: Add state (after `audienceCount`, ~line 191)**

```ts
const [selectedSmartListId, setSelectedSmartListId] = useState(
  campaign?.smart_list_id ?? NO_SMART_LIST,
);
const [smartListCount, setSmartListCount] = useState<number | null>(null);
```

- [ ] **Step 3: Add the live-count effect (after the audience-count effect, ~line 242)**

```ts
// Live "matches N leads" preview for the picked smart list.
useEffect(() => {
  if (selectedSmartListId === NO_SMART_LIST) {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSmartListCount(null);
    return;
  }
  let cancelled = false;
  void countSmartListMatches({ smartListId: selectedSmartListId }).then(
    (result) => {
      if (!cancelled) setSmartListCount(result.count);
    },
  );
  return () => {
    cancelled = true;
  };
}, [selectedSmartListId]);
```

- [ ] **Step 4: Submit — include `smartListId` + reset on create**

In the `submit()` input object (after `audienceSearch,` ~line 264):

```ts
        smartListId:
          selectedSmartListId === NO_SMART_LIST ? "" : selectedSmartListId,
```

In the create-mode reset block (after `setAudienceSearch("");` ~line 303):

```ts
setSelectedSmartListId(NO_SMART_LIST);
```

- [ ] **Step 5: Render the picker (inside the Audience `CampaignSection`, after the company-name `</div>` at ~line 505)**

```tsx
<div className="flex flex-col gap-2">
  <Label htmlFor="campaign-smart-list">…or a smart list</Label>
  {smartLists.length > 0 ? (
    <Select value={selectedSmartListId} onValueChange={setSelectedSmartListId}>
      <SelectTrigger id="campaign-smart-list">
        <SelectValue placeholder="No smart list" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_SMART_LIST}>No smart list</SelectItem>
        {smartLists.map((sl) => (
          <SelectItem key={sl.id} value={sl.id}>
            {sl.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : (
    <p className="text-muted-foreground text-sm">
      No smart lists yet. Build one on the Leads page (advanced filters → Save
      as smart list).
    </p>
  )}
  <p className="text-muted-foreground text-xs">
    A smart list is a saved filter that auto-includes any new lead matching it.
    Attaching one dials its members; membership refreshes every few minutes.
  </p>
  {selectedSmartListId !== NO_SMART_LIST ? (
    <p className="text-muted-foreground text-xs">
      {smartListCount === null
        ? "Counting matching leads…"
        : `Matches ${smartListCount.toLocaleString()} lead${
            smartListCount === 1 ? "" : "s"
          } right now.`}
    </p>
  ) : null}
</div>
```

- [ ] **Step 6: Typecheck + lint**

Run: `npx tsc --noEmit` (filtered) ; `npx eslint "src/app/(app)/campaigns/campaign-settings-dialog.tsx"`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/campaigns/campaign-settings-dialog.tsx"
git commit -m "feat(smart-lists): smart-list picker in campaign Audience section"
```

---

### Task 10: Thread `smartLists` from the page through every dialog entry point

**Files:**

- Modify: `src/app/(app)/campaigns/page.tsx`
- Modify: `src/app/(app)/campaigns/campaign-name-trigger.tsx`
- Modify: `src/app/(app)/campaigns/campaign-board.tsx`

- [ ] **Step 1: page.tsx — fetch smart-list options**

Where other option lists are built (near `agentOptions`/`goalOptions`), add a query for the admin's smart lists and map to `Option[]`:

```ts
const { data: smartListRows } = await supabase
  .from("smart_lists")
  .select("id, name")
  .order("name");
const smartListOptions: Option[] = (smartListRows ?? []).map((s) => ({
  id: s.id,
  name: s.name,
}));
```

(Use the same `supabase` server client the page already creates for its other queries.)

- [ ] **Step 2: page.tsx — include `smart_list_id` in each campaign's `data`**

In the `data` object (after `audience_search: campaign.audience_search,` ~line 305):

```ts
      smart_list_id: campaign.smart_list_id,
```

Ensure the campaigns source query SELECTs `smart_list_id`. Find the `.from("campaigns").select(...)` (or the view it reads) and add `smart_list_id` to the column list if not `*`.

- [ ] **Step 3: page.tsx — pass `smartLists` to all three entry points**

Create dialog (~line 357), `CampaignBoard` (~line 374), and `CampaignNameTrigger` (~line 420) each get:

```tsx
smartLists = { smartListOptions };
```

- [ ] **Step 4: campaign-name-trigger.tsx — accept + forward `smartLists`**

Add `smartLists: Option[]` to its props type, destructure it, and pass `smartLists={smartLists}` to the `<CampaignSettingsDialog>` it renders. (Match the existing `eligibleLists` plumbing exactly.)

- [ ] **Step 5: campaign-board.tsx — accept + forward `smartLists`**

Add `smartLists: Option[]` to its props, destructure it, and pass it down to each `CampaignNameTrigger`/`CampaignSettingsDialog` the board renders (mirror how it already forwards `agents`/`goals`/`calendlyEvents`).

- [ ] **Step 6: Typecheck + lint + build**

Run: `npx tsc --noEmit` (filtered) ; `npx eslint "src/app/(app)/campaigns/page.tsx" "src/app/(app)/campaigns/campaign-name-trigger.tsx" "src/app/(app)/campaigns/campaign-board.tsx"` ; `npm run build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/campaigns/page.tsx" "src/app/(app)/campaigns/campaign-name-trigger.tsx" "src/app/(app)/campaigns/campaign-board.tsx"
git commit -m "feat(smart-lists): pass smart-list options to campaign dialogs"
```

---

### Task 11: End-to-end verification + ship PR 2

- [ ] **Step 1: Screenshot the picker (light + dark)**

Build a throwaway `src/app/share/sl-picker-preview/page.tsx` rendering the Audience section (or the whole dialog open) with mock `smartLists`. `npm run dev`, navigate, screenshot light + dark via Playwright MCP, Read the PNGs. Confirm the picker + count line render in the command-center style. Delete the preview route before committing.

- [ ] **Step 2: Live end-to-end against a TEST campaign (manual, non-destructive)**

Do NOT attach to a real active campaign. Create/Use a paused or test campaign, attach a smart list in the editor, save, then:

- `select smart_list_id from campaigns where id = '<test>';` → expected the chosen id.
- `select count(*) from smart_list_members where smart_list_id = '<id>';` → expected > 0 (the immediate refresh ran).
- `select count(*) from dial_queue where campaign_id = '<test>';` → expected to include the smart-list members that pass eligibility (status/hours/DNC). If the campaign is paused (`status<>'active'`), expect 0 — re-check with an active test campaign only if safe.
  Confirm caps/hours/DNC still gate (compare a known-DNC lead is excluded).

- [ ] **Step 3: Detach + cleanup**

Set the test campaign's smart list back to none in the editor; confirm `dial_queue` for it drops the members.

- [ ] **Step 4: Open + merge PR 2, verify deploy green**

```bash
# branch feat/smart-lists-r2-ui; push, PR, squash-merge, confirm commit status success
```

---

## Self-Review

**Spec coverage (R2 section of `2026-06-19-smart-lists-advanced-filters-design.md`):**

- `smart_list_members (smart_list_id, lead_id, PK both)` indexed → Task 1 ✓
- Refresh job every few minutes → Task 5 (cron) + Task 3/4 (job) ✓
- Immediate refresh after attach → Task 8 Step 3 ✓
- `campaigns.smart_list_id` nullable FK → Task 2 ✓
- Smart-list picker + live match count → Tasks 7, 9 ✓
- `dial_queue` third branch (exists smart_list_members) → Task 2 ✓
- Eligibility (hours/caps/DNC/in-flight) unchanged → Task 2 keeps every gate verbatim ✓
- One smart list per campaign → single `smart_list_id` column ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Two intentional "match the existing X plumbing" instructions (Task 10 Steps 4–5) reference a concrete existing pattern (`eligibleLists`) rather than leaving code blank — acceptable because the change is identical-shaped pass-through and the exact local prop names live in those files.

**Type consistency:** `smartLists: Option[]` (the dialog's existing `Option = {id,name}`), `smart_list_id: string | null` on `CampaignData`, `smartListId?: string` on `CampaignInput`, `refresh_smart_list(in_id uuid)` RPC name + `in_id` arg used identically in SQL (Task 1), cache lib (Task 3), and actions (Task 8). `countSmartListMatches({ smartListId })` signature matches caller (Task 9 Step 3). Consistent.
