# Onboarding UI (Part B) — welcome primer + Getting started checklist — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Give a new teammate a first-run on-ramp — a one-time welcome primer explaining the four building blocks, and a per-user "Getting started" checklist on Today that tracks real progress to a live campaign.

**Architecture:** Two nullable profile columns gate the once-only welcome and the dismissible checklist. Step completion is **derived from live per-user data** (never stored), so it can't drift. New members land on `/today` (root redirects there), so both surfaces render from the Today page — no app-shell/layout changes in this PR. The top-bar "Setup N/4" pill is a documented fast-follow, not in this PR.

**Tech stack:** Next.js 16 (server components + server actions), Supabase, TypeScript, Playwright.

**Design source:** spec §5 (`docs/superpowers/specs/2026-08-02-teammate-onboarding-design.md`) and the approved mockup (Leads → Number → Agent → Campaign; welcome CTA "Import leads").

### Testing reality (same as Phase 0)

Playwright is the contract but runs against live only. Local gate = `npx tsc --noEmit`, `npx eslint <changed>`, `npm run build` all clean.

### File structure

- Create: `supabase/migrations/20260802130000_onboarding_profile_columns.sql`
- Modify: `src/lib/supabase/database.types.ts` — add the two columns to `profiles` Row/Insert/Update.
- Create: `src/lib/onboarding/queries.ts` — `fetchOnboardingProgress`.
- Create: `src/lib/onboarding/actions.ts` — `markWelcomeSeen`, `dismissOnboarding`.
- Create: `src/components/onboarding/welcome-dialog.tsx` — one-time welcome modal.
- Create: `src/components/onboarding/getting-started.tsx` — checklist card + success state.
- Modify: `src/app/(app)/today/page.tsx` — fetch state, render both, fix the empty-copy.
- Create: `tests/onboarding.spec.ts`.

---

## Task 1: Migration + generated types

**Files:** create the migration; edit `database.types.ts`.

- [ ] **Step 1: Write the migration** (`supabase/migrations/20260802130000_onboarding_profile_columns.sql`)

```sql
-- First-run onboarding state (Part B). Additive, nullable — safe.
alter table public.profiles
  add column if not exists welcome_seen_at timestamptz,
  add column if not exists onboarding_dismissed_at timestamptz;
```

- [ ] **Step 2: Add the columns to the generated `profiles` types** in `src/lib/supabase/database.types.ts` — insert `onboarding_dismissed_at: string | null;` (after `notify_on_goal_met`) and `welcome_seen_at: string | null;` (after `role`) in the `Row` block; the `?`-optional forms in `Insert` and `Update`. (Hand-edit avoids applying the migration to prod mid-build; a later `supabase gen types` will match.)

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260802130000_onboarding_profile_columns.sql src/lib/supabase/database.types.ts
git commit -m "feat(onboarding): profile columns for welcome + checklist state"
```

---

## Task 2: Per-user onboarding progress query

**Files:** create `src/lib/onboarding/queries.ts`.

- [ ] **Step 1: Write `fetchOnboardingProgress`**

```ts
import "server-only";

import type { createClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export type OnboardingStep = {
  key: "leads" | "number" | "agent" | "campaign";
  done: boolean;
  detail: string | null;
};

export type OnboardingProgress = {
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  complete: boolean;
  agentName: string | null;
};

/** Derive first-campaign progress for one user from live data. Order is
 *  load-bearing: Leads → Number → Agent → Campaign. Numbers are a shared
 *  pool, so "number ready" = an unattached pool number exists OR the user
 *  already attached one to a campaign. */
export async function fetchOnboardingProgress(
  supabase: Supabase,
  userId: string,
): Promise<OnboardingProgress> {
  const [
    { count: leadCount },
    { count: freeNumberCount },
    { data: agentRow },
    { count: agentCount },
    { data: campaignRow },
    { count: activeCampaignCount },
    { count: userNumberCount },
  ] = await Promise.all([
    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId),
    supabase
      .from("twilio_numbers")
      .select("id", { count: "exact", head: true })
      .is("released_at", null)
      .is("attached_campaign_id", null),
    supabase
      .from("agents")
      .select("name")
      .eq("owner_id", userId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("agents")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId),
    supabase
      .from("campaigns")
      .select("name")
      .eq("owner_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId)
      .eq("status", "active"),
    // A number attached to one of THIS user's campaigns also counts as
    // "number ready" even if the shared pool has no free numbers.
    supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", userId)
      .not("twilio_number_id", "is", null),
  ]);

  const leads = (leadCount ?? 0) > 0;
  const number = (freeNumberCount ?? 0) > 0 || (userNumberCount ?? 0) > 0;
  const agent = (agentCount ?? 0) > 0;
  const campaign = (activeCampaignCount ?? 0) > 0;

  const steps: OnboardingStep[] = [
    {
      key: "leads",
      done: leads,
      detail: leads ? `${(leadCount ?? 0).toLocaleString()} imported` : null,
    },
    {
      key: "number",
      done: number,
      detail: number ? "Ready to dial from" : null,
    },
    {
      key: "agent",
      done: agent,
      detail: agent ? (agentRow?.name ?? "Ready") : null,
    },
    {
      key: "campaign",
      done: campaign,
      detail: campaign ? (campaignRow?.name ?? "Live") : null,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return {
    steps,
    doneCount,
    total: steps.length,
    complete: doneCount === steps.length,
    agentName: agentRow?.name ?? null,
  };
}
```

- [ ] **Step 2: Verify + commit**

```bash
npx tsc --noEmit && npx eslint src/lib/onboarding/queries.ts
git add src/lib/onboarding/queries.ts
git commit -m "feat(onboarding): per-user first-campaign progress query"
```

---

## Task 3: Onboarding actions

**Files:** create `src/lib/onboarding/actions.ts` (mirror `setActiveCampaign`).

- [ ] **Step 1: Write the two actions**

```ts
"use server";

import { revalidatePath } from "next/cache";

import { createClient } from "@/lib/supabase/server";

async function stampProfile(
  column: "welcome_seen_at" | "onboarding_dismissed_at",
): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };

  const { error } = await supabase
    .from("profiles")
    .update({ [column]: new Date().toISOString() })
    .eq("id", user.id);
  if (error) return { error: "Could not save your preference." };

  revalidatePath("/today");
  return { error: null };
}

/** Remember that the user has seen the one-time welcome primer. */
export async function markWelcomeSeen() {
  return stampProfile("welcome_seen_at");
}

/** Hide the Getting started checklist card (the user chose "Hide for now"). */
export async function dismissOnboarding() {
  return stampProfile("onboarding_dismissed_at");
}
```

- [ ] **Step 2: Verify + commit**

```bash
npx tsc --noEmit && npx eslint src/lib/onboarding/actions.ts
git add src/lib/onboarding/actions.ts
git commit -m "feat(onboarding): actions to mark welcome seen + dismiss checklist"
```

---

## Task 4: Welcome dialog component

**Files:** create `src/components/onboarding/welcome-dialog.tsx` (client).

- [ ] **Step 1: Build it** — a `Dialog` open by default, four building-block cards in the approved order, primary CTA "Import leads" (link to `/leads/import`, calls `markWelcomeSeen` first), secondary "Explore on my own" (calls `markWelcomeSeen`, closes). Footer hint points at Ask Smile. Use the existing `@/components/ui/dialog`, `Button`, and lucide icons (`Users`, `Phone`, `Bot`, `Rocket`, `Sparkles`, `ArrowRight`). Props: `{ firstName: string }`. On any dismissal, call `markWelcomeSeen` (fire-and-forget in a transition) so it never reappears. Copy verbatim from spec §6.

- [ ] **Step 2: Verify + commit**

```bash
npx tsc --noEmit && npx eslint src/components/onboarding/welcome-dialog.tsx
git add src/components/onboarding/welcome-dialog.tsx
git commit -m "feat(onboarding): one-time welcome primer dialog"
```

---

## Task 5: Getting started checklist card (+ success state)

**Files:** create `src/components/onboarding/getting-started.tsx` (client).

- [ ] **Step 1: Build it** — props `{ progress: OnboardingProgress }`. Renders the approved checklist: title "Getting started", "N of 4 done", a progress bar, one row per step (done = check + `detail`; the first not-done = "Start here" emphasis + a primary link to its screen; later = muted). Optional "Connect your calendar and email" line is out of the 4 and can be omitted in v1 (note it as a fast-follow). Footer: "Ask Smile if you get stuck" + a "Hide for now" button calling `dismissOnboarding`. When `progress.complete`, render the success state instead ("You're live — {agentName} is dialing", buttons Go to Today / View campaign). Deep links per step: leads → `/leads/import`, number → `/settings/twilio-numbers`, agent → `/settings/agents/new`, campaign → `/campaigns`.

- [ ] **Step 2: Verify + commit**

```bash
npx tsc --noEmit && npx eslint src/components/onboarding/getting-started.tsx
git add src/components/onboarding/getting-started.tsx
git commit -m "feat(onboarding): getting-started checklist card + success state"
```

---

## Task 6: Wire into Today + fix the empty-copy

**Files:** modify `src/app/(app)/today/page.tsx`.

- [ ] **Step 1:** In `TodayPage`, extend the profile select to `full_name, role, welcome_seen_at, onboarding_dismissed_at`. Call `fetchOnboardingProgress(supabase, user.id)`. Render `<WelcomeDialog firstName={firstName} />` when `profile.welcome_seen_at` is null. Render `<GettingStarted progress={progress} />` above the bento grid when `!profile.onboarding_dismissed_at && (!progress.complete || <just-completed>)`. Simplest v1: show the card when `!onboarding_dismissed_at && !progress.complete`; show the success variant when complete AND not yet dismissed (dismiss on the success CTA).

- [ ] **Step 2:** Fix the misleading action-queue empty copy: when the user has **not** launched a campaign yet (`!progress.steps.campaign.done`), the "The AI is handling things… free to step away" line must not show — the Getting started card carries the message instead. Only show the "all clear / free to step away" copy once they're live.

- [ ] **Step 3: Verify + commit**

```bash
npx tsc --noEmit && npx eslint "src/app/(app)/today/page.tsx" && npm run build
git add "src/app/(app)/today/page.tsx"
git commit -m "feat(onboarding): show welcome + checklist on Today; fix false 'all clear' for pre-launch users"
```

---

## Task 7: Playwright contract

**Files:** create `tests/onboarding.spec.ts`.

- [ ] **Step 1:** Using the member session (`playwright/.auth/member.json`), assert: on `/today` the "Getting started" heading is visible for a not-yet-complete member; the "Import leads" welcome CTA appears for a member whose `welcome_seen_at` is null (seed/reset via the admin service client, mirroring other specs); "Hide for now" removes the card. Keep it resilient; top-of-file note that it runs against live only.

- [ ] **Step 2: Commit**

```bash
git add tests/onboarding.spec.ts
git commit -m "test(onboarding): welcome + checklist contract"
```

---

## Task 8: Ship (with Marija)

- [ ] Local gate green (`tsc`, `eslint .`, `npm run build`).
- [ ] Push branch, open PR from `feat/teammate-onboarding` (or a fresh `feat/onboarding-ui` branch off updated main).
- [ ] **Confirm with Marija**, then merge + `supabase db push --linked` (the profile-columns migration — additive/safe) + regenerate types if desired. Smoke-test: a fresh member sees the welcome once, then the checklist tracking their real progress.

---

## Self-review notes

- Covers spec §5.1 (welcome), §5.2 (checklist, per-user, correct order + deep links), §5.3 (success), §5.4 (empty-copy fix), §5.5 (two profile columns, derived completion).
- Deferred to fast-follow (documented, not silently dropped): the top-bar "Setup N/4" pill (§5.2) and the optional "Connect calendar + email" step. Core value (new member lands on /today → guided) ships without them.
- Migration is additive/nullable — safe; applied at ship with Marija's go.
