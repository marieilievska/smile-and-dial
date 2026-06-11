# Deletion Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a call is deleted, reset its lead from the remaining calls; and make lead deletion a permanent hard delete (taking calls/recordings with it, pulling synced leads out of Meta). Then purge the 173 already-soft-deleted leads.

**Architecture:** Two server actions change (`deleteCalls`, `bulkDeleteLeads`), sharing two new helpers (call hard-delete + lead recompute). The `leads.deleted_at` column and its filters stay in place (dormant) — no schema migration.

**Tech Stack:** Next.js server actions, Supabase service-role client, existing outcome sets + Meta sync helpers.

> **Testing note:** automated Playwright CI was retired for this project (it ran against prod). Verification per task = `npx tsc --noEmit` (ignore the 3 known `tests/twilio-*` errors), `npx eslint <files>`, and a final `npx next build`. Production data effects are checked with read-only Supabase probes. No new Playwright specs (they can't run).

---

### Task 1: Shared call hard-delete helper

**Files:**

- Create: `src/lib/calls/delete-calls-core.ts`
- Modify: `src/lib/calls/actions.ts` (have `deleteCalls` reuse the helper — no behavior change yet)

- [ ] **Step 1: Create the helper**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { ID_CHUNK, chunk } from "@/lib/leads/chunk";

type Admin = ReturnType<typeof createClient<Database>>;

/** Remove stored recordings (object paths, not legacy http URLs) for the given
 *  calls from the private bucket. Best-effort. */
export async function removeCallRecordings(
  admin: Admin,
  callIds: string[],
): Promise<void> {
  for (const ids of chunk(callIds, ID_CHUNK)) {
    const { data: rows } = await admin
      .from("calls")
      .select("recording_path")
      .in("id", ids);
    const objects = (rows ?? [])
      .map((r) => r.recording_path)
      .filter(
        (p): p is string => Boolean(p) && !/^https?:\/\//i.test(p as string),
      );
    if (objects.length > 0) {
      await admin.storage.from("call-recordings").remove(objects);
    }
  }
}

/** Permanently delete calls: remove their recordings, then delete the rows
 *  (chunked). Returns an error string on the first failed delete. */
export async function hardDeleteCalls(
  admin: Admin,
  callIds: string[],
): Promise<{ error: string | null }> {
  const clean = [...new Set(callIds.filter(Boolean))];
  if (clean.length === 0) return { error: null };
  await removeCallRecordings(admin, clean);
  for (const ids of chunk(clean, ID_CHUNK)) {
    const { error } = await admin.from("calls").delete().in("id", ids);
    if (error) return { error: "Could not delete calls." };
  }
  return { error: null };
}
```

- [ ] **Step 2: Refactor `deleteCalls` to use `hardDeleteCalls`**

In `src/lib/calls/actions.ts`, replace the inline recording-removal + `admin.from("calls").delete()` block (the part after the admin client is created) with:

```ts
const { error } = await hardDeleteCalls(admin, clean);
if (error) return { error: "Could not delete the selected calls." };
```

Add the import at the top: `import { hardDeleteCalls } from "./delete-calls-core";`. Remove the now-unused inline `rows`/`objects`/`storage.remove` code.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit 2>&1 | grep -v "twilio-inbound\|twilio-status"` → no output. `npx eslint src/lib/calls/delete-calls-core.ts src/lib/calls/actions.ts` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/calls/delete-calls-core.ts src/lib/calls/actions.ts
git commit -m "refactor(calls): extract hardDeleteCalls/removeCallRecordings helper"
```

---

### Task 2: Lead call-state recompute helper (Feature A core)

**Files:**

- Create: `src/lib/leads/recompute-call-state.ts`

- [ ] **Step 1: Create the helper**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { syncLeadNextCallToEarliestCallback } from "@/lib/callbacks/sync-next-call";
import {
  CONVERSATION_OUTCOMES,
  DM_REACHED_OUTCOMES,
} from "@/lib/calls/outcomes";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;
type LeadUpdate = Database["public"]["Tables"]["leads"]["Update"];

const TERMINAL_WON = new Set(["goal_met", "transferred_to_human"]);
const DNC_OUTCOMES = new Set(["dnc", "invalid_number", "language_barrier"]);

/**
 * Recompute one lead's call-derived fields from its REMAINING calls, after some
 * of its calls were deleted. No calls remain → fresh reset. Calls remain →
 * rewind to reflect them, never un-winning a booked lead or un-blocking a DNC'd
 * one. The forward retry ladder resets to neutral (intentional — the lead
 * re-enters normal rotation; we don't replay the engine).
 */
export async function recomputeLeadCallState(
  admin: Admin,
  leadId: string,
): Promise<void> {
  const { data: calls } = await admin
    .from("calls")
    .select("created_at, ended_at, outcome")
    .eq("lead_id", leadId);
  const remaining = calls ?? [];

  const base: LeadUpdate = {
    retry_counter: 0,
    retry_position: 0,
    call_back_later_count: 0,
    resting_until: null,
    next_call_at: null,
    updated_at: new Date().toISOString(),
  };

  if (remaining.length === 0) {
    await admin
      .from("leads")
      .update({
        ...base,
        status: "ready_to_call",
        last_call_at: null,
        call_attempts: 0,
        conversations: 0,
        decision_maker_reached: false,
      })
      .eq("id", leadId);
  } else {
    const lastCallAt =
      remaining
        .map((c) => c.ended_at ?? c.created_at)
        .filter((v): v is string => Boolean(v))
        .sort()
        .at(-1) ?? null;
    const conversations = remaining.filter(
      (c) => c.outcome && CONVERSATION_OUTCOMES.has(c.outcome),
    ).length;
    const dmReached = remaining.some(
      (c) => c.outcome && DM_REACHED_OUTCOMES.has(c.outcome),
    );

    let status = "ready_to_call";
    if (remaining.some((c) => c.outcome && TERMINAL_WON.has(c.outcome))) {
      status = "goal_met";
    } else if (
      remaining.some((c) => c.outcome && DNC_OUTCOMES.has(c.outcome))
    ) {
      status = "dnc";
    } else {
      const { data: lead } = await admin
        .from("leads")
        .select("business_phone")
        .eq("id", leadId)
        .maybeSingle();
      if (lead?.business_phone) {
        const { data: dnc } = await admin
          .from("dnc_entries")
          .select("phone")
          .eq("phone", lead.business_phone)
          .maybeSingle();
        if (dnc) status = "dnc";
      }
    }

    await admin
      .from("leads")
      .update({
        ...base,
        status,
        last_call_at: lastCallAt,
        call_attempts: remaining.length,
        conversations,
        decision_maker_reached: dmReached,
      })
      .eq("id", leadId);
  }

  // A callback from a call we did NOT delete keeps the lead in 'callback' and
  // pointed at its earliest pending callback.
  const { data: pendingCb } = await admin
    .from("callbacks")
    .select("id")
    .eq("lead_id", leadId)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (pendingCb) {
    await admin.from("leads").update({ status: "callback" }).eq("id", leadId);
    await syncLeadNextCallToEarliestCallback(admin, leadId);
  }
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (filtered) clean; `npx eslint src/lib/leads/recompute-call-state.ts` clean. (If `syncLeadNextCallToEarliestCallback`'s client type complains, cast the admin client the same way other callers do.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/leads/recompute-call-state.ts
git commit -m "feat(leads): recomputeLeadCallState from remaining calls"
```

---

### Task 3: Feature A — reset lead inside deleteCalls

**Files:**

- Modify: `src/lib/calls/actions.ts` (`deleteCalls`)

- [ ] **Step 1: Capture affected leads + delete originating callbacks, then recompute**

In `deleteCalls`, after the admin client is created and BEFORE `hardDeleteCalls`:

```ts
// Which leads are affected, so we can reset them after deletion.
const { data: affected } = await admin
  .from("calls")
  .select("lead_id")
  .in("id", clean);
const leadIds = [
  ...new Set((affected ?? []).map((c) => c.lead_id).filter(Boolean)),
];

// Remove callbacks these calls scheduled (artifacts of the deleted calls).
// Keep dnc_entries (do-not-call blocks survive a call deletion).
await admin.from("callbacks").delete().in("originating_call_id", clean);
```

After `hardDeleteCalls` succeeds, before `revalidatePath`:

```ts
for (const leadId of leadIds) {
  await recomputeLeadCallState(admin, leadId);
}
```

Add imports: `import { recomputeLeadCallState } from "@/lib/leads/recompute-call-state";` and add `revalidatePath("/leads");` to the existing revalidate list.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (filtered) clean; `npx eslint src/lib/calls/actions.ts` clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/calls/actions.ts
git commit -m "feat(calls): reset the lead when its calls are deleted"
```

---

### Task 4: Meta audience removal helper

**Files:**

- Create: `src/lib/meta/remove-leads.ts`

- [ ] **Step 1: Create the helper** (best-effort; groups leads by owner, removes synced ones from each owner's audience)

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { leadToHashedRow, type LeadForAudience } from "./audience-fields";
import { META_BATCH, removeUsers } from "./api";
import { getUserMetaSettings } from "./settings";
import type { Database } from "@/lib/supabase/database.types";

type Admin = ReturnType<typeof createClient<Database>>;

type SyncedLead = LeadForAudience & {
  owner_id: string;
  meta_synced_at: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Best-effort: remove the given Meta-synced leads from their OWNERS' Custom
 *  Audiences before the leads are deleted (otherwise they'd be stranded in the
 *  audience with no row left for the sync to remove). Owners with no Meta
 *  connection are skipped. Never throws. */
export async function removeLeadsFromOwnerAudiences(
  admin: Admin,
  leads: SyncedLead[],
): Promise<void> {
  const synced = leads.filter((l) => l.meta_synced_at);
  if (synced.length === 0) return;

  const byOwner = new Map<string, SyncedLead[]>();
  for (const l of synced) {
    const arr = byOwner.get(l.owner_id) ?? [];
    arr.push(l);
    byOwner.set(l.owner_id, arr);
  }

  for (const [ownerId, ownerLeads] of byOwner) {
    try {
      const s = await getUserMetaSettings(ownerId);
      if (!s.accessToken || !s.customAudienceId) continue;
      const rows = ownerLeads.map((l) => leadToHashedRow(l));
      for (const batch of chunk(rows, META_BATCH)) {
        await removeUsers(s.customAudienceId, s.accessToken, batch);
      }
    } catch {
      // best-effort — never block a deletion on a Meta hiccup
    }
  }
}
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (filtered) clean; `npx eslint src/lib/meta/remove-leads.ts` clean. (Confirm `getUserMetaSettings` returns `accessToken`/`customAudienceId` — it does, from Task context.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/meta/remove-leads.ts
git commit -m "feat(meta): removeLeadsFromOwnerAudiences helper"
```

---

### Task 5: Feature B — hard-delete leads

**Files:**

- Modify: `src/lib/leads/bulk-actions.ts` (`bulkDeleteLeads`)

- [ ] **Step 1: Rewrite `bulkDeleteLeads` as a permanent delete**

```ts
import { createClient as createAdminClient } from "@supabase/supabase-js";

import { hardDeleteCalls } from "@/lib/calls/delete-calls-core";
import { removeLeadsFromOwnerAudiences } from "@/lib/meta/remove-leads";
import type { Database } from "@/lib/supabase/database.types";

/** Permanently delete every selected lead and everything tied to it: calls
 *  (+ recordings), callbacks, custom-field values, emails. Synced leads are
 *  pulled out of their owner's Meta audience first. No undo. */
export async function bulkDeleteLeads(input: {
  leadIds: string[];
}): Promise<BulkResult> {
  const ids = [...new Set(input.leadIds.filter(Boolean))];
  if (ids.length === 0) return { error: "No leads selected." };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const { data: me } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAdmin = me?.role === "admin";

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return { error: "Server is missing Supabase credentials." };
  const admin = createAdminClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Load the target leads (for ownership check + Meta cleanup).
  const { data: leads } = await admin
    .from("leads")
    .select(
      "id, owner_id, business_email, business_phone, city, state, meta_synced_at",
    )
    .in("id", ids);
  const targets = leads ?? [];
  if (targets.length === 0) return { error: null };

  // Permission: non-admins may only delete leads they own.
  if (!isAdmin && targets.some((l) => l.owner_id !== user.id)) {
    return { error: "You can only delete leads you own." };
  }

  // 1) Pull synced leads out of their owners' Meta audiences (best-effort).
  await removeLeadsFromOwnerAudiences(admin, targets);

  // 2) Delete their calls first (calls.lead_id is ON DELETE RESTRICT).
  const callIds: string[] = [];
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    const { data: cs } = await admin
      .from("calls")
      .select("id")
      .in("lead_id", idsChunk);
    for (const c of cs ?? []) callIds.push(c.id);
  }
  const del = await hardDeleteCalls(admin, callIds);
  if (del.error) return { error: "Could not delete the leads' calls." };

  // 3) Delete the lead rows (callbacks / custom values / emails cascade).
  for (const idsChunk of chunk(ids, ID_CHUNK)) {
    const { error } = await admin.from("leads").delete().in("id", idsChunk);
    if (error) return { error: "Could not delete the leads." };
  }

  revalidatePath("/leads");
  revalidatePath("/calls");
  revalidatePath("/analytics");
  revalidatePath("/costs");
  revalidatePath("/today");
  return { error: null };
}
```

(Keep the existing `import { ID_CHUNK, chunk } from "./chunk";` at the top of the file.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (filtered) clean; `npx eslint src/lib/leads/bulk-actions.ts` clean; `npx next build` exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/lib/leads/bulk-actions.ts
git commit -m "feat(leads): permanent hard delete (calls/recordings/meta cleanup)"
```

---

### Task 6: Ship the PR

- [ ] **Step 1:** Branch `feat/deletion-behavior`, push, open PR against `main` describing Features A + B and the deferred one-off purge. Verify locally first: `npx next build` exits 0.
- [ ] **Step 2:** Merge (admin) + let Vercel deploy.

---

### Task 7: One-off purge of the 173 soft-deleted leads (AFTER deploy)

Run once, locally, using the same permanent path. NOT committed app code.

- [ ] **Step 1:** Read-only probe — count `leads where deleted_at is not null` (expect 173) and how many have calls / `meta_synced_at`.
- [ ] **Step 2:** For those lead ids: `removeLeadsFromOwnerAudiences` → collect their call ids → `hardDeleteCalls` → delete the lead rows (chunked). (A small `node` script reading `.env.local`, mirroring `bulkDeleteLeads`.)
- [ ] **Step 3:** Re-probe — `leads where deleted_at is not null` = 0; overall lead count dropped by 173. Report.

---

## Self-review notes

- **Spec coverage:** A (Tasks 1–3), B (Tasks 4–5), C (Task 7). Shared helpers (Task 1, 2, 4). ✓
- **Type consistency:** `hardDeleteCalls(admin, callIds)`, `recomputeLeadCallState(admin, leadId)`, `removeLeadsFromOwnerAudiences(admin, leads)` used consistently. `getUserMetaSettings` → `{ accessToken, customAudienceId }`. ✓
- **No double-reset:** lead delete (Task 5) deletes calls via `hardDeleteCalls` directly, NOT via `deleteCalls`, so Feature A's recompute never runs for a lead being deleted. ✓
