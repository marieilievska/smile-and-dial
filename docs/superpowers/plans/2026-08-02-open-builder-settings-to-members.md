# Open builder settings to members (numbers + custom fields) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `member` manage Twilio numbers and custom fields (and reach Integrations), so an everyday teammate can complete the onboarding flow without an admin — while keeping the destructive/compliance-sensitive actions admin-only.

**Architecture:** Authorization in this app is enforced in two layers: an explicit `requireAdmin()` code check inside each server action, and Postgres RLS as a backstop. Opening a surface to members therefore requires changing **both**. We relax RLS to `authenticated` (with an ownership guardrail on number updates), swap the per-action `requireAdmin()` for a lighter `requireSignedIn()` on the member-allowed actions (keeping `requireAdmin()` on delete), drop the admin page redirects, and surface the cards/tabs to members. Reporting and the full onboarding UI are separate plans.

**Tech stack:** Next.js 16 (App Router, server actions), Supabase (Postgres + RLS), TypeScript, Playwright.

**Scope for this plan:** Twilio numbers, custom fields, Integrations nav visibility, and a DNC verification. **Not** in this plan: Reporting access (separate follow-up), the onboarding welcome/checklist UI (Part B plan).

### Testing reality for this repo (read first)

Playwright specs are the behavior **contract**, but they run against the live environment and **cannot be run locally or in CI** (CI was removed). So each task writes/updates the spec as the contract, and the **local gate** is:

```bash
npx tsc --noEmit
npx eslint <changed files>
npm run build
```

A task's "verify" step means those three are clean on the changed files. Do not claim a task passing without running them.

### File structure

- Create: `supabase/migrations/20260802120000_open_numbers_customfields_to_members.sql` — RLS relaxation.
- Modify: `src/lib/twilio/number-actions.ts` — per-action guards + release ownership check.
- Modify: `src/lib/custom-fields/actions.ts` — create/update/move guards; fix stale comment.
- Modify: `src/app/(app)/settings/twilio-numbers/page.tsx` — drop admin redirect; pass `isAdmin` for destructive UI.
- Modify: `src/app/(app)/settings/custom-fields/page.tsx` — drop admin redirect; pass `isAdmin` for delete UI.
- Modify: `src/components/app-shell/settings-nav.tsx` — move Custom fields / Twilio numbers / Integrations to the member-visible group.
- Modify: `src/app/(app)/settings/overview/page.tsx` — move those cards to Workspace; count a number as an essential for everyone; keep Users / API keys admin-only.
- Modify: `src/app/(app)/settings/users/invite-user-dialog.tsx` — member role helper copy.
- Verify only: `src/app/(app)/dnc/page.tsx` + `src/lib/dnc/actions.ts` — confirm view/add already open, removal admin-only.
- Test: `tests/member-builder-access.spec.ts` — new contract spec.

---

## Task 1: RLS migration — relax numbers + custom fields

**Files:**

- Create: `supabase/migrations/20260802120000_open_numbers_customfields_to_members.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Open Twilio numbers and custom fields to members (repurposed "builder" role).
-- Numbers: members can view the pool, buy/adopt, attach, and repoint webhooks.
-- The UPDATE guardrail blocks touching a number attached to ANOTHER user's
-- campaign (so a member can't yank a number out from under a teammate's live
-- campaign). Permanent DELETE stays admin-only (unchanged; done via service
-- role after an admin code-check).
-- Custom fields: members can create + edit (needed for lead import); DELETE
-- stays admin-only (dropping a field destroys that column's data for everyone).
-- Relaxing-only: no drops/renames of columns; existing admin behavior unchanged.

-- --- twilio_numbers -------------------------------------------------------
drop policy if exists "twilio_numbers_select" on public.twilio_numbers;
create policy "twilio_numbers_select"
  on public.twilio_numbers for select to authenticated
  using (true);

drop policy if exists "twilio_numbers_insert" on public.twilio_numbers;
create policy "twilio_numbers_insert"
  on public.twilio_numbers for insert to authenticated
  with check (true);

drop policy if exists "twilio_numbers_update" on public.twilio_numbers;
create policy "twilio_numbers_update"
  on public.twilio_numbers for update to authenticated
  using (
    public.is_admin((select auth.uid()))
    or attached_campaign_id is null
    or exists (
      select 1 from public.campaigns c
      where c.id = public.twilio_numbers.attached_campaign_id
        and c.owner_id = (select auth.uid())
    )
  )
  with check (
    public.is_admin((select auth.uid()))
    or attached_campaign_id is null
    or exists (
      select 1 from public.campaigns c
      where c.id = public.twilio_numbers.attached_campaign_id
        and c.owner_id = (select auth.uid())
    )
  );
-- twilio_numbers DELETE policy intentionally unchanged (admin-only).

-- --- custom_field_defs ----------------------------------------------------
drop policy if exists "custom_field_defs_insert" on public.custom_field_defs;
create policy "custom_field_defs_insert"
  on public.custom_field_defs for insert to authenticated
  with check (true);

drop policy if exists "custom_field_defs_update" on public.custom_field_defs;
create policy "custom_field_defs_update"
  on public.custom_field_defs for update to authenticated
  using (true) with check (true);
-- custom_field_defs SELECT already (true); DELETE intentionally unchanged
-- (admin-only).
```

- [ ] **Step 2: Do NOT push to prod yet.** The migration lands in the repo now; applying it to the live DB (`supabase db push --linked`) happens during the guarded rollout at the end (Task 9), after code review, so RLS and code relax together.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260802120000_open_numbers_customfields_to_members.sql
git commit -m "feat(rls): open twilio numbers + custom fields to members"
```

---

## Task 2: Number actions — per-action guards + release ownership check

**Files:**

- Modify: `src/lib/twilio/number-actions.ts`

- [ ] **Step 1: Update the spec (contract) for member number access**

Add to `tests/member-builder-access.spec.ts` (full file authored in Task 8) an assertion that a signed-in member can open `/settings/twilio-numbers`, see the buy UI, and that the Delete control is absent for members.

- [ ] **Step 2: Add a `requireSignedIn` helper alongside `requireAdmin`**

In `number-actions.ts`, keep the existing `requireAdmin` and add:

```ts
/** Confirm the caller is signed in, and report whether they're an admin.
 *  Members (builders) may manage numbers; a few actions still gate on admin. */
async function requireSignedIn(): Promise<{
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string | null;
  isAdmin: boolean;
  error: string | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      supabase,
      userId: null,
      isAdmin: false,
      error: "You are not signed in.",
    };
  }
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  return {
    supabase,
    userId: user.id,
    isAdmin: me?.role === "admin",
    error: null,
  };
}
```

- [ ] **Step 3: Switch the member-allowed actions from `requireAdmin` to `requireSignedIn`**

In `searchNumbers`, `purchaseNumber`, `renameNumber`, `repointNumberWebhooks`, `syncFromTwilio`, and `connectNumberToElevenLabs`, replace `const { ... } = await requireAdmin();` with `const { ... } = await requireSignedIn();` (destructure `supabase`/`error` as before). Leave `deleteTwilioNumber` on `requireAdmin` (permanent delete stays admin-only).

- [ ] **Step 4: Add the ownership guardrail to `releaseNumber`**

Change `releaseNumber` to use `requireSignedIn`, fetch `attached_campaign_id`, and block releasing a number attached to someone else's campaign:

```ts
export async function releaseNumber(id: string): Promise<ActionResult> {
  const {
    supabase,
    userId,
    isAdmin,
    error: authError,
  } = await requireSignedIn();
  if (authError) return { error: authError };

  const { data: number } = await supabase
    .from("twilio_numbers")
    .select("twilio_sid, released_at, attached_campaign_id")
    .eq("id", id)
    .maybeSingle();
  if (!number) return { error: "That number no longer exists." };
  if (number.released_at) return { error: "That number is already released." };

  if (!isAdmin && number.attached_campaign_id) {
    const { data: campaign } = await supabase
      .from("campaigns")
      .select("owner_id")
      .eq("id", number.attached_campaign_id)
      .maybeSingle();
    if (!campaign || campaign.owner_id !== userId) {
      return {
        error: "That number is attached to another teammate's campaign.",
      };
    }
  }

  const { error: releaseError } = await releaseTwilioNumber(number.twilio_sid);
  if (releaseError) return { error: releaseError };

  const { error } = await supabase
    .from("twilio_numbers")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { error: "Could not release the number." };

  revalidatePath(NUMBERS_PATH);
  return { error: null };
}
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit
npx eslint src/lib/twilio/number-actions.ts
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/twilio/number-actions.ts
git commit -m "feat(numbers): members can manage numbers; release guarded by campaign owner; delete stays admin"
```

---

## Task 3: Custom-field actions — open create/edit/reorder to members

**Files:**

- Modify: `src/lib/custom-fields/actions.ts`

- [ ] **Step 1: Add a `requireSignedIn` helper next to `requireAdmin`**

```ts
async function requireSignedIn(
  supabase: Supabase,
): Promise<{ ok: true } | { error: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  return { ok: true };
}
```

- [ ] **Step 2: Swap guards on `createCustomField`, `updateCustomField`, `moveCustomField`**

In those three, change `const auth = await requireAdmin(supabase);` to `const auth = await requireSignedIn(supabase);`. Leave `deleteCustomField` on `requireAdmin`.

- [ ] **Step 3: Fix the stale comment on `createCustomFieldInline`**

Replace the comment block that says "Creating a field requires admin (RLS on custom_field_defs); the inline dialog is only offered to admins…" with:

```ts
/** Create a custom field and return its id, for the import wizard's
 *  inline-create affordance. Open to any signed-in teammate (members
 *  included) — the RLS insert policy allows members; only field DELETE
 *  stays admin-only. */
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit
npx eslint src/lib/custom-fields/actions.ts
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/custom-fields/actions.ts
git commit -m "feat(custom-fields): members can create/edit fields; delete stays admin"
```

---

## Task 4: Drop the admin page redirects (numbers + custom fields)

**Files:**

- Modify: `src/app/(app)/settings/twilio-numbers/page.tsx`
- Modify: `src/app/(app)/settings/custom-fields/page.tsx`

- [ ] **Step 1: Twilio numbers page — remove the admin redirect, pass `isAdmin` down**

Delete the `if (me?.role !== "admin") redirect("/leads");` guard (keep the signed-in check). Keep computing `isAdmin` from the profile and pass it to the client component(s) that render row actions, so the **Delete** control (and any "release" affordance on numbers attached to other campaigns) is only rendered when `isAdmin` is true. Follow the existing prop-passing pattern used elsewhere (e.g. `AppSidebar isAdmin=…`).

- [ ] **Step 2: Custom fields page — remove the admin redirect, pass `isAdmin` down**

Delete the `if (me?.role !== "admin") redirect("/leads");` guard (keep the signed-in check). Pass `isAdmin` to the row/table component so the **Delete field** control is admin-only; Create/Edit/Reorder are available to members.

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx eslint src/app/(app)/settings/twilio-numbers/page.tsx src/app/(app)/settings/custom-fields/page.tsx
npm run build
```

Expected: clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/twilio-numbers/page.tsx" "src/app/(app)/settings/custom-fields/page.tsx"
git commit -m "feat(settings): members can open numbers + custom fields; destructive actions stay admin-only"
```

---

## Task 5: Surface the tabs + overview cards to members

**Files:**

- Modify: `src/components/app-shell/settings-nav.tsx`
- Modify: `src/app/(app)/settings/overview/page.tsx`

- [ ] **Step 1: settings-nav — move member-accessible tabs out of admin-only**

Change the tab groups so members see Custom fields, Twilio numbers, and Integrations. Users and API keys stay admin-only:

```ts
const WORKSPACE_TABS: Tab[] = [
  { label: "Lists", href: "/settings/lists" },
  { label: "Goals", href: "/settings/goals" },
  { label: "Knowledge bases", href: "/settings/knowledge-bases" },
  { label: "Email templates", href: "/settings/email-templates" },
  { label: "Text templates", href: "/settings/sms-templates" },
  { label: "Agents", href: "/settings/agents" },
  { label: "Custom fields", href: "/settings/custom-fields" },
  { label: "Twilio numbers", href: "/settings/twilio-numbers" },
  { label: "Integrations", href: "/settings/integrations" },
];

const ADMIN_TABS: Tab[] = [
  { label: "Users", href: "/settings/users" },
  { label: "API keys", href: "/settings/api" },
];
```

- [ ] **Step 2: overview — move those cards to the member-visible group and count numbers for everyone**

In `settings/overview/page.tsx`, move the Twilio numbers, Custom fields, and Integrations cards out of the `adminCards` (admin-only) array into the member-visible `workspaceCards` array (leave Users and API keys in `adminCards`). Because those cards now render for everyone, the existing essentials math automatically counts a phone number + voice integration toward "ready to make calls" for members too — fixing the false "3 of 3 ready" a member saw before. Keep the Administration section rendering only when `isAdmin` (now just Users + API keys).

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit
npx eslint src/components/app-shell/settings-nav.tsx "src/app/(app)/settings/overview/page.tsx"
npm run build
```

Expected: clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/components/app-shell/settings-nav.tsx "src/app/(app)/settings/overview/page.tsx"
git commit -m "feat(settings): show numbers, custom fields, integrations to members; keep users + API keys admin"
```

---

## Task 6: Update the member role helper copy

**Files:**

- Modify: `src/app/(app)/settings/users/invite-user-dialog.tsx:38-48`

- [ ] **Step 1: Rewrite the `member` and `admin` helper text**

```ts
const ROLE_META: Record<
  Role,
  { label: string; helper: string; icon: React.ReactNode }
> = {
  member: {
    label: "Member",
    helper:
      "Builds and runs calls: agents, leads, numbers, custom fields, campaigns, and reporting.",
    icon: <User className="size-3.5" />,
  },
  admin: {
    label: "Admin",
    helper:
      "Everything a member can do, plus teammates, API keys, and system settings.",
    icon: <ShieldCheck className="size-3.5" />,
  },
};
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit
npx eslint "src/app/(app)/settings/users/invite-user-dialog.tsx"
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/settings/users/invite-user-dialog.tsx"
git commit -m "docs(users): member role helper reflects expanded capabilities"
```

---

## Task 7: Verify DNC already matches the spec (no backend change expected)

**Files:**

- Read/verify: `src/app/(app)/dnc/page.tsx`, `src/lib/dnc/actions.ts`, `src/app/(app)/dnc/remove-dnc-dialog.tsx`

- [ ] **Step 1: Confirm view + add are open to members**

`dnc_entries` RLS is already `select using (true)` and `insert with check (true)`, and the DNC nav item has no `adminOnly`. Confirm `dnc/page.tsx` has no `role !== "admin"` redirect. If it does, remove it (members should reach DNC). If not, no change.

- [ ] **Step 2: Confirm removal stays admin-only**

`dnc_entries` DELETE and `dnc_removals` INSERT are already `is_admin`. Confirm the remove action in `src/lib/dnc/actions.ts` keeps its admin check, and that the remove control in `remove-dnc-dialog.tsx`/`bulk-action-bar.tsx` is only shown to admins. If the remove UI shows for members, gate it behind an `isAdmin` prop from the page.

- [ ] **Step 3: Verify + commit (only if a change was needed)**

```bash
npx tsc --noEmit
npx eslint <any changed dnc files>
git add <changed files>
git commit -m "fix(dnc): members can view/add, removal stays admin-only"
```

If nothing changed, record "DNC already correct — no change" in the PR description.

---

## Task 8: Playwright contract spec

**Files:**

- Create: `tests/member-builder-access.spec.ts`

- [ ] **Step 1: Write the contract**

Cover, using the suite's existing auth/login helpers (mirror an existing spec's setup, e.g. `tests/connect-rate-monitor.spec.ts`):

```ts
// A member (non-admin) can now:
//  - open /settings/twilio-numbers (no redirect) and see the buy UI
//  - open /settings/custom-fields (no redirect) and create a field
//  - open /settings/integrations
// A member still cannot:
//  - open /settings/users (redirects away)
//  - open /settings/api (redirects to /settings)
//  - see a Delete control on a custom field or a Twilio number
//  - remove a number from the DNC list
```

Write each as a `test(...)` with real navigation + `expect` assertions on the resulting URL / visible controls. Reuse a seeded member account (or create-then-demote via an admin helper) consistent with how the suite seeds users.

- [ ] **Step 2: Note — spec runs against live env only**

Add a top-of-file comment that this spec is the behavior contract and runs against the deployed environment (not locally/CI). Do not attempt to run it here.

- [ ] **Step 3: Commit**

```bash
git add tests/member-builder-access.spec.ts
git commit -m "test(access): member can reach numbers/custom-fields/integrations, not users/api or destructive actions"
```

---

## Task 9: Guarded rollout (with Marija)

- [ ] **Step 1: Local gate green**

```bash
npx tsc --noEmit
npx eslint .
npm run build
```

Expected: all clean.

- [ ] **Step 2: Open the PR** from `feat/teammate-onboarding` with a description covering the capability change, the guardrails, and the DNC "already correct" note.

- [ ] **Step 3: Apply the migration to prod — this is the one production step; confirm with Marija first.** Because the code guards were relaxed too, RLS and code widen together. Order: merge the PR (Vercel deploys the relaxed code), then:

```bash
supabase db push --linked
```

Then smoke-test with a real member account: can reach numbers/custom-fields; cannot reach users/api; cannot delete a field or remove a DNC number.

- [ ] **Step 4: Confirm no service-role regressions** — the dialer/webhooks use the service-role client and bypass RLS, so they're unaffected; spot-check that a test call still dials.

---

## Self-review notes

- **Spec coverage:** Covers the Numbers and Custom-fields rows of the §4.1 matrix and their §4.2 guardrails (number release ownership; custom-field delete admin-only). DNC row verified (Task 7). Reporting row is explicitly deferred to a follow-up plan. Onboarding UI (Part B) is a separate plan.
- **Two-layer auth:** every opened surface changes both RLS (Task 1) and the code guard (Tasks 2–4) — neither alone is sufficient.
- **Migration safety:** relaxing-only; no drops/renames; applied after the code deploys (Task 9), per the migration-sequencing rule.
- **Type consistency:** `requireSignedIn` returns `{ supabase, userId, isAdmin, error }` in number-actions and `{ ok } | { error }` in custom-fields (matching each file's existing `requireAdmin` shape).
