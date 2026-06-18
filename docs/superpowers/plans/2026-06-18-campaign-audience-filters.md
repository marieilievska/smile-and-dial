# Campaign Audience Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a campaign call every lead whose company name contains a given text, in addition to its attached lists, so overlapping (deduped) uploads no longer drop leads from a campaign.

**Architecture:** Add a nullable `audience_search` text column to `campaigns`. Rebuild the `dial_queue` SQL view so a lead is eligible for a campaign when its list is attached **or** its company name ILIKE-matches the campaign's `audience_search` (scoped to the same owner), and collapse the view to one row per lead (callbacks first, then oldest campaign) as a double-call guard. Surface the filter as an "Audience" field in campaign settings with a live match count. The dialer TypeScript (`tick.ts`) and `pre_call_check` are unchanged — the view stays the single source of truth for campaign membership.

**Tech Stack:** Next.js (App Router, server actions), Supabase/Postgres (SQL views, RLS), TypeScript, Playwright (contract tests, run live only).

---

## Important conventions for this plan

- **No CI gate.** Playwright specs run only against the live environment, so you **cannot** run them locally. Wherever a task adds/edits a spec, "verify" means: the spec is written as the behavioral contract, and `npx tsc --noEmit` + `npx eslint <files>` + `npm run build` are clean. Do **not** try to run `npx playwright test` locally.
- **Branch:** all work lands on `feat/campaign-audience-filters` (already created). Stage only the files each task names.
- **Migrations hit the LIVE prod DB** and are applied in the deploy step (Task 7), not during implementation. The migration is backward-compatible: no existing campaign has `audience_search` set, so the rebuilt view behaves identically to today for every current campaign.
- Read `node_modules/next/dist/docs/` before writing any Next-specific code if unsure — this repo runs a Next.js with breaking changes.

---

### Task 1: Migration — add `audience_search` and rebuild `dial_queue`

**Files:**

- Create: `supabase/migrations/20260618120000_campaign_audience_filter.sql`
- Modify: `src/lib/supabase/database.types.ts` (campaigns `Row`/`Insert`/`Update`)

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/20260618120000_campaign_audience_filter.sql` with exactly this content:

```sql
-- Campaign audience filters: target leads by company-name text, not just lists.
--
-- Problem: a lead belongs to exactly one list, so when a second upload overlaps
-- an earlier one the duplicates are skipped and never join the new list — and
-- the dialer, which picks leads by their single home list, never calls them.
--
-- Fix: campaigns gain an optional `audience_search`. When set, the campaign also
-- targets every lead (same owner) whose company name ILIKE-contains that text,
-- regardless of which list the lead lives in. List-based targeting is unchanged.
--
-- Because a lead can now match more than one campaign (a filter on one, a list
-- on another), the rebuilt view collapses to ONE row per lead — the double-call
-- guard the old one-lead-one-list rule used to provide for free. Winner per
-- lead: scheduled callbacks first, then the oldest campaign.
--
-- Output columns and every safety gate (status, due, DNC, calling hours, the
-- callback 08:00-21:00 floor, autopilot rule, active campaign + Twilio number)
-- are identical to 20260617120000 — only the membership join and the per-lead
-- dedup change. tick.ts and pre_call_check are untouched.

alter table public.campaigns
  add column audience_search text;

comment on column public.campaigns.audience_search is
  'Optional company-name filter. When set, the campaign also targets every '
  'lead (same owner) whose company name ILIKE-contains this text, regardless '
  'of list membership. NULL = list-only targeting.';

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
    -- Callbacks are agreed appointments — they dial regardless of autopilot.
    -- Cold/retry leads still require autopilot on.
    and (c.autopilot_enabled = true or l.status = 'callback')
    -- Membership: the lead's list is attached to this campaign, OR the
    -- campaign's company-name filter matches the lead.
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
-- One row per lead = the double-call guard. Callbacks (dial_priority 0) win,
-- then the oldest campaign; campaign_id is the final stable tiebreak.
order by q.lead_id, q.dial_priority, q.campaign_created_at, q.campaign_id;

comment on view public.dial_queue is
  'Leads currently eligible for the AUTO-dialer: ready, due, not on DNC, '
  'attached to an active campaign with a Twilio number OR matching that '
  'campaign''s company-name audience filter. Cold/retry leads require autopilot '
  'on and dial inside the campaign window; callbacks dial regardless of '
  'autopilot inside the 08:00-21:00 local floor. Collapsed to one row per lead '
  '(callbacks first, then oldest campaign) so a lead is dialed by exactly one '
  'campaign. dial_priority orders callbacks (0) ahead of cold (1). Re-check '
  'caps in code at dial time before firing.';

grant select on public.dial_queue to authenticated;
```

- [ ] **Step 2: Update the generated DB types for the new column**

In `src/lib/supabase/database.types.ts`, in the `campaigns:` block (starts at line 634), add `audience_search` to all three shapes. Insert it alphabetically right after the `agent_id` line in each:

In `Row` (after line 636 `agent_id: string;`):

```ts
audience_search: string | null;
```

In `Insert` (after `agent_id: string;`):

```ts
          audience_search?: string | null;
```

In `Update` (after `agent_id?: string;`):

```ts
          audience_search?: string | null;
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors). The `campaigns` row type now carries `audience_search`; nothing references it yet, so this is purely additive.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260618120000_campaign_audience_filter.sql src/lib/supabase/database.types.ts
git commit -m "feat(dialer): add campaign audience_search column and filter-aware dial_queue

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure sanitizer for the company-name filter

A small pure helper, shared by the save action and the count action. It lives in its own (non-`"use server"`) module so both can import it — `"use server"` files may only export async actions.

**Files:**

- Create: `src/lib/campaigns/audience-filter.ts`

- [ ] **Step 1: Write the helper**

Create `src/lib/campaigns/audience-filter.ts`:

```ts
/**
 * Normalize a company-name audience filter to a literal "contains" term:
 * trim it and drop characters that act as ILIKE wildcards (`%`, `_`) or that
 * would break the pattern (`,`, `(`, `)`, `\`, `*`). Mirrors the Leads page
 * search sanitization so the stored filter matches as plain text both in the
 * dial_queue view (which concatenates it into an ILIKE pattern) and in the
 * live count query.
 *
 * Returns "" for input that is empty after sanitizing — callers treat that as
 * "no filter" (NULL on the campaign).
 */
export function sanitizeAudienceSearch(raw: string): string {
  return raw.replace(/[%_,()\\*]/g, "").trim();
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/campaigns/audience-filter.ts
git commit -m "feat(campaigns): add audience-filter sanitizer helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Save `audience_search` through the campaign actions

**Files:**

- Modify: `src/lib/campaigns/actions.ts` (import the sanitizer; add `audienceSearch` to `CampaignInput`; persist it in `buildUpdate`)

- [ ] **Step 1: Import the sanitizer**

In `src/lib/campaigns/actions.ts`, add this import alongside the existing imports (after the `import { createClient }` line, line 7):

```ts
import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
```

- [ ] **Step 2: Add `audienceSearch` to the `CampaignInput` type**

In the `CampaignInput` type (ends at line 90, after `emailTemplateId?: string;`), add:

```ts
  /** Optional company-name "contains" filter. When set, the campaign also
   *  targets every lead (same owner) whose company name contains this text,
   *  regardless of list. Empty = list-only targeting. */
  audienceSearch?: string;
```

- [ ] **Step 3: Persist it in `buildUpdate`**

In `buildUpdate` (the returned object, line 106-127), add this line after `email_template_id: input.emailTemplateId?.trim() || null,`:

```ts
    audience_search: sanitizeAudienceSearch(input.audienceSearch ?? "") || null,
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: PASS. `createCampaign` and `updateCampaign` both route through `buildUpdate`, so both now persist the field.

- [ ] **Step 5: Commit**

```bash
git add src/lib/campaigns/actions.ts
git commit -m "feat(campaigns): persist audience_search on create/update

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Live audience count server action

Powers the "matches N leads" preview. Scoped to the **campaign owner's** leads so the preview equals what the dialer will actually call. Admin-only screen; RLS lets admins read all leads.

**Files:**

- Create: `src/lib/campaigns/audience-actions.ts`

- [ ] **Step 1: Write the action**

Create `src/lib/campaigns/audience-actions.ts`:

```ts
"use server";

import { sanitizeAudienceSearch } from "@/lib/campaigns/audience-filter";
import { createClient } from "@/lib/supabase/server";

export type AudienceCountResult = {
  count: number | null;
  error: string | null;
};

/**
 * Count how many of the campaign owner's leads a company-name audience filter
 * would target. Powers the live "matches N leads" preview in campaign settings.
 *
 * The dialer matches a campaign's audience against the campaign OWNER's leads,
 * so resolve that owner from the campaign in edit mode; in create mode the new
 * campaign will be owned by the current user. Counts non-deleted leads whose
 * company name contains the (sanitized) term — the same match the dial_queue
 * view applies, so the preview equals reality.
 */
export async function countAudienceMatches(input: {
  search: string;
  campaignId?: string;
}): Promise<AudienceCountResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { count: null, error: "You are not signed in." };

  const term = sanitizeAudienceSearch(input.search);
  if (!term) return { count: 0, error: null };

  let ownerId = user.id;
  if (input.campaignId) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("owner_id")
      .eq("id", input.campaignId)
      .maybeSingle();
    if (campaign?.owner_id) ownerId = campaign.owner_id;
  }

  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .is("deleted_at", null)
    .ilike("company", `%${term}%`);
  if (error) return { count: null, error: "Could not count matches." };
  return { count: count ?? 0, error: null };
}
```

- [ ] **Step 2: Verify types + lint**

Run: `npx tsc --noEmit && npx eslint src/lib/campaigns/audience-actions.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/campaigns/audience-actions.ts
git commit -m "feat(campaigns): add live audience match-count action

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Campaign settings UI — "Audience" section + live count, and page plumbing

**Files:**

- Modify: `src/app/(app)/campaigns/campaign-settings-dialog.tsx`
- Modify: `src/app/(app)/campaigns/page.tsx`

- [ ] **Step 1: Plumb the field through the campaigns page query and mappings**

In `src/app/(app)/campaigns/page.tsx`:

(a) In the campaigns `.select(...)` string (line 90), add `audience_search` — insert it right after `email_template_id,`:

```
... calendly_event_id, email_template_id, audience_search, created_at, agent:agents(name), goal:goals(name)
```

(b) In the `allCampaigns` map (line 225-252), add after `email_template_id: c.email_template_id ?? null,` (line 248):

```ts
    audience_search: c.audience_search ?? null,
```

(c) In the `viewModels` `data` object (line 283-302), add after `email_template_id: campaign.email_template_id,` (line 301):

```ts
      audience_search: campaign.audience_search ?? null,
```

- [ ] **Step 2: Add the field to the `CampaignData` type and dialog state**

In `src/app/(app)/campaigns/campaign-settings-dialog.tsx`:

(a) Add to the `CampaignData` type (after `email_template_id: string | null;`, line 72):

```ts
audience_search: string | null;
```

(b) Add `Filter` to the lucide import block (lines 3-14), e.g. after `CalendarClock,`:

```ts
  Filter,
```

(c) Add `useEffect` to the React import (line 15):

```ts
import { useEffect, useState, useTransition } from "react";
```

(d) Add the count action import after the `setCampaignLists` import (line 42):

```ts
import { countAudienceMatches } from "@/lib/campaigns/audience-actions";
```

(e) Add state next to the other `useState` hooks (after `selectedListIds`, line 171-172):

```ts
const [audienceSearch, setAudienceSearch] = useState(
  campaign?.audience_search ?? "",
);
const [audienceCount, setAudienceCount] = useState<number | null>(null);
```

- [ ] **Step 3: Add the debounced live-count effect**

In the same component, after the `agentKbs` line (line 178), add:

```ts
// Live "matches N leads" preview. Debounced so we don't fire a count on
// every keystroke. Empty filter → no count shown.
useEffect(() => {
  const term = audienceSearch.trim();
  if (!term) {
    setAudienceCount(null);
    return;
  }
  let cancelled = false;
  const handle = setTimeout(() => {
    void countAudienceMatches({
      search: term,
      campaignId: campaign?.id,
    }).then((result) => {
      if (!cancelled) setAudienceCount(result.count);
    });
  }, 400);
  return () => {
    cancelled = true;
    clearTimeout(handle);
  };
}, [audienceSearch, campaign?.id]);
```

- [ ] **Step 4: Send the field on save and reset it on create**

(a) In the `submit()` input object (line 182-200), add after `emailTemplateId: ...` (line 199):

```ts
        audienceSearch,
```

(b) In the create-mode reset block (line 226-238), add after `setSelectedListIds([]);` (line 237):

```ts
setAudienceSearch("");
```

- [ ] **Step 5: Add the "Audience" section to the drawer**

Insert a new `CampaignSection` immediately after the closing `</CampaignSection>` of the **Lists** section (after line 614, before the **Goal** section at line 616):

```tsx
<CampaignSection title="Audience" icon={<Filter className="size-4" />}>
  <p className="text-muted-foreground text-sm">
    Beyond attached lists, this campaign can also call every lead whose company
    name contains the text below — no matter which list the lead was uploaded
    into. Leave blank to target only the lists above.
  </p>
  <div className="flex flex-col gap-2">
    <Label htmlFor="campaign-audience">Company name contains</Label>
    <Input
      id="campaign-audience"
      value={audienceSearch}
      onChange={(event) => setAudienceSearch(event.target.value)}
      placeholder="e.g. F45"
    />
    {audienceSearch.trim() ? (
      <p className="text-muted-foreground text-xs">
        {audienceCount === null
          ? "Counting matching leads…"
          : `Matches ${audienceCount.toLocaleString()} lead${
              audienceCount === 1 ? "" : "s"
            } across all lists.`}
      </p>
    ) : null}
  </div>
</CampaignSection>
```

- [ ] **Step 6: Verify types, lint, and build**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/campaigns/campaign-settings-dialog.tsx" "src/app/(app)/campaigns/page.tsx" && npm run build`
Expected: all PASS. The drawer now shows an Audience field with a live count; saving persists `audience_search`.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/campaigns/campaign-settings-dialog.tsx" "src/app/(app)/campaigns/page.tsx"
git commit -m "feat(campaigns): Audience filter field with live match count

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Playwright contract spec for filter targeting + the double-call guard

This spec is the behavioral contract. It runs against the live environment in CI/QA only — **do not run it locally**. Mirror the seeding/cleanup style of `tests/dial-queue.spec.ts`.

**Files:**

- Create: `tests/campaign-audience-filter.spec.ts`

- [ ] **Step 1: Write the spec**

Create `tests/campaign-audience-filter.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.use({ storageState: "playwright/.auth/user.json" });

test.describe.configure({ mode: "serial" });

/**
 * Campaign audience filters: a campaign with `audience_search` calls leads by
 * company name regardless of which list they live in, and a lead matching more
 * than one campaign is dialed by exactly one (the double-call guard). Poked
 * directly through the service-role client against dial_queue.
 */
test.describe("Campaign audience filter", () => {
  const stamp = Date.now();
  const tail = String(stamp).slice(-6);
  const token = `F45AUD${tail}`; // unique company-name token for this run
  const phoneFilter = `+1555${tail}11`;
  const phoneShared = `+1555${tail}22`;

  let admin: SupabaseClient;
  let ownerId: string;
  let unattachedListId: string;
  let attachedListId: string;
  let filterCampaignId: string; // newer; targets by audience_search only
  let listCampaignId: string; // older; targets by an attached list
  let numA: string;
  let numB: string;
  let agentId: string;
  let goalId: string;
  let leadFilterId: string; // in an unattached list, matches the filter
  let leadSharedId: string; // in the attached list AND matches the filter

  async function seedNumber(suffix: string): Promise<string> {
    const { data } = await admin
      .from("twilio_numbers")
      .insert({
        phone_number: `+1555${tail}${suffix}`,
        friendly_name: `E2E Aud Number ${suffix} ${stamp}`,
        country: "US",
      })
      .select("id")
      .single();
    return data!.id;
  }

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

    const { data: agent } = await admin
      .from("agents")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud Agent ${stamp}`,
        elevenlabs_agent_id: `e2e-aud-${stamp}`,
        prompt_personality: "x",
        prompt_environment: "x",
        prompt_tone: "x",
        prompt_goal: "x",
        prompt_guardrails: "x",
      })
      .select("id")
      .single();
    agentId = agent!.id;

    const { data: goal } = await admin
      .from("goals")
      .insert({ owner_id: ownerId, name: `E2E Aud Goal ${stamp}` })
      .select("id")
      .single();
    goalId = goal!.id;

    const { data: listU } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Aud Unattached ${stamp}` })
      .select("id")
      .single();
    unattachedListId = listU!.id;

    const { data: listA } = await admin
      .from("lists")
      .insert({ owner_id: ownerId, name: `E2E Aud Attached ${stamp}` })
      .select("id")
      .single();
    attachedListId = listA!.id;

    numA = await seedNumber("31");
    numB = await seedNumber("32");

    // Older campaign: list-based, attached to attachedListId.
    const { data: listCampaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud List Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: numA,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    listCampaignId = listCampaign!.id;

    // Newer campaign: filter-based, audience_search = token, NO list attached.
    const { data: filterCampaign } = await admin
      .from("campaigns")
      .insert({
        owner_id: ownerId,
        name: `E2E Aud Filter Campaign ${stamp}`,
        status: "active",
        agent_id: agentId,
        goal_id: goalId,
        twilio_number_id: numB,
        audience_search: token,
        calling_hours_start: "00:00:00",
        calling_hours_end: "23:59:59",
      })
      .select("id")
      .single();
    filterCampaignId = filterCampaign!.id;

    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: listCampaignId })
      .eq("id", numA);
    await admin
      .from("twilio_numbers")
      .update({ attached_campaign_id: filterCampaignId })
      .eq("id", numB);

    await admin.from("list_campaign_attachments").insert({
      list_id: attachedListId,
      campaign_id: listCampaignId,
    });

    // Lead that ONLY the filter campaign should reach: lives in an unattached
    // list, but its company contains the token.
    const { data: leadFilter } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: unattachedListId,
        company: `${token} Downtown`,
        business_phone: phoneFilter,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadFilterId = leadFilter!.id;

    // Lead that BOTH campaigns want: in the attached list (list campaign) and
    // its company contains the token (filter campaign).
    const { data: leadShared } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        list_id: attachedListId,
        company: `${token} Uptown`,
        business_phone: phoneShared,
        timezone: "America/New_York",
        status: "ready_to_call",
      })
      .select("id")
      .single();
    leadSharedId = leadShared!.id;
  });

  test.afterAll(async () => {
    for (const id of [leadFilterId, leadSharedId]) {
      await admin
        .from("calls")
        .delete()
        .eq("lead_id", id ?? "");
      await admin
        .from("leads")
        .delete()
        .eq("id", id ?? "");
    }
    await admin.from("dnc_entries").delete().eq("phone", phoneFilter);
    await admin.from("dnc_entries").delete().eq("phone", phoneShared);
    for (const id of [filterCampaignId, listCampaignId]) {
      await admin
        .from("list_campaign_attachments")
        .delete()
        .eq("campaign_id", id ?? "");
    }
    for (const id of [numA, numB]) {
      await admin
        .from("twilio_numbers")
        .update({ attached_campaign_id: null })
        .eq("id", id ?? "");
    }
    for (const id of [filterCampaignId, listCampaignId]) {
      await admin
        .from("campaigns")
        .delete()
        .eq("id", id ?? "");
    }
    await admin
      .from("agents")
      .delete()
      .eq("id", agentId ?? "");
    for (const id of [numA, numB]) {
      await admin
        .from("twilio_numbers")
        .delete()
        .eq("id", id ?? "");
    }
    await admin
      .from("goals")
      .delete()
      .eq("id", goalId ?? "");
    for (const id of [unattachedListId, attachedListId]) {
      await admin
        .from("lists")
        .delete()
        .eq("id", id ?? "");
    }
  });

  async function queueRows(leadId: string) {
    const { data } = await admin
      .from("dial_queue")
      .select("lead_id, campaign_id")
      .eq("lead_id", leadId);
    return data ?? [];
  }

  test("a lead matches a campaign's audience filter even when its list isn't attached", async () => {
    const rows = await queueRows(leadFilterId);
    expect(rows.length).toBe(1);
    expect(rows[0].campaign_id).toBe(filterCampaignId);
  });

  test("a lead matching two campaigns is queued once, for the older campaign", async () => {
    const rows = await queueRows(leadSharedId);
    // Double-call guard: exactly one row, and the older (list) campaign wins.
    expect(rows.length).toBe(1);
    expect(rows[0].campaign_id).toBe(listCampaignId);
  });
});
```

- [ ] **Step 2: Verify the spec type-checks and lints**

Run: `npx tsc --noEmit && npx eslint tests/campaign-audience-filter.spec.ts`
Expected: PASS. (Do not run `npx playwright test` — it needs the live environment.)

- [ ] **Step 3: Commit**

```bash
git add tests/campaign-audience-filter.spec.ts
git commit -m "test(dialer): contract for audience-filter targeting + double-call guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Final verification, PR, and safe deploy

- [ ] **Step 1: Full local verification**

Run: `npx tsc --noEmit && npx eslint . && npm run build`
Expected: all clean. If anything fails, fix it before proceeding.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin feat/campaign-audience-filters
gh pr create --title "Campaign audience filters (filter-based targeting)" --body "$(cat <<'EOF'
## What & why
Lead lists are one-lead-one-list, so overlapping uploads get deduped and the duplicates never join the second list — and the dialer, which picks leads by their single home list, never calls them. This adds **filter-based targeting**: a campaign can also call every lead whose company name contains a given text, regardless of list.

## How
- `campaigns.audience_search` (nullable text) holds the company-name filter.
- `dial_queue` rebuilt: a lead is eligible for a campaign via its attached list **or** a company-name ILIKE match (same owner). Every existing safety gate is unchanged.
- **Double-call guard:** the view now returns one row per lead (callbacks first, then oldest campaign), so a lead matching two campaigns is dialed by exactly one.
- Campaign settings gains an **Audience** field with a live "matches N leads" count.

## Safety
- Backward-compatible: no existing campaign has `audience_search`, so the view behaves identically for them today. List-based campaigns are untouched.
- `tick.ts` and `pre_call_check` unchanged.

## Contract test
`tests/campaign-audience-filter.spec.ts` — filter targeting across lists + the double-call guard (runs live).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Apply the migration to prod, then merge**

The migration is backward-compatible (adds a nullable column; the rebuilt view is identical for campaigns without `audience_search`), so it is safe to apply before the UI deploys. Apply it, then merge the PR (Vercel auto-deploys on merge):

```bash
supabase db push --linked
```

Then merge the PR on GitHub. After deploy, sanity-check: open a campaign, set Audience to a known token, confirm the live count looks right, and confirm an existing list-based campaign still dials normally.

---

## Self-review

**Spec coverage:**

- Audience filter stored on campaign → Task 1 (column), Task 3 (persist). ✓
- Company-name-only match, sanitized, preview == reality → Task 2 (sanitizer), Task 4 (count uses same term + ILIKE on `company`), Task 1 (view ILIKE on `company`). ✓
- Dialer honors filter, all safety gates preserved → Task 1 (view rebuild; `tick.ts`/`pre_call_check` untouched). ✓
- Double-call guard (one row per lead, callbacks then oldest) → Task 1 (`DISTINCT ON` + ORDER BY). ✓
- Adds, does not replace lists; list+filter = union → Task 1 (EXISTS attachment OR filter). ✓
- Campaign settings UI with live count → Task 5. ✓
- Migration sequencing / no breakage / no data edits → Task 1 + Task 7. ✓
- Contract test → Task 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete content. ✓

**Type consistency:** `audience_search` (snake_case DB/row/JSX prop) vs `audienceSearch` (camelCase `CampaignInput`/React state) used consistently; `countAudienceMatches`/`AudienceCountResult`/`sanitizeAudienceSearch` names match across Tasks 2, 4, 5. ✓
