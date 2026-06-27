# Delete calls & callbacks from the lead page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins delete a call (from the call detail popup) and a callback (from a new Callbacks section) on the lead detail page, reusing the existing `deleteCalls` / `deleteCallbacks` server actions.

**Architecture:** The lead page resolves the viewer's admin status and fetches the lead's callbacks, threading both to the client. The `CallDetailModal` gains an admin-only Delete button; a new `LeadCallbacks` client component lists callbacks with an admin-only Delete. Both call the existing (admin-gated, lead-recomputing) delete actions and `router.refresh()`.

**Tech Stack:** Next.js (App Router/RSC), Supabase, shadcn, Playwright (live-env).

**Testing note:** No local test runner — Playwright runs against the live env only. Verify with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build`). Transient mid-plan tsc errors expected; clean (except the 3 pre-existing `twilio-*.spec.ts`) after the final task. **No migration.**

**Branch:** `feat/lead-delete-calls-callbacks` (created; spec committed).

---

## File structure

- **Modify** `src/app/(app)/leads/[id]/page.tsx` — fetch callbacks + viewer role; pass `isAdmin` + `callbacks` down.
- **Modify** `src/app/(app)/leads/[id]/lead-page-client.tsx` — accept `isAdmin` + `callbacks`; thread `isAdmin` to the modal; render `<LeadCallbacks>`.
- **Create** `src/app/(app)/leads/[id]/lead-callbacks.tsx` — callbacks list + admin delete.
- **Modify** `src/app/(app)/calls/call-detail-modal.tsx` — `isAdmin` prop + Delete call button.
- **Modify** `tests/lead-detail.spec.ts` (or add `tests/lead-delete.spec.ts`) — contract.

---

## Task 1: Lead page — fetch callbacks + admin status

**Files:** Modify `src/app/(app)/leads/[id]/page.tsx`

- [ ] **Step 1: Fetch the lead's callbacks**

In the big `Promise.all` (the fan-out destructured as `{ data: lead }, … , { data: activeCallRows }`), add one more query at the end of the array and one more destructured binding `{ data: callbackRows }`:

```tsx
    supabase
      .from("callbacks")
      .select("id, scheduled_at, status")
      .eq("lead_id", id)
      .order("scheduled_at", { ascending: false })
      .limit(50),
```

(So the destructure becomes `…, { data: activeCallRows }, { data: callbackRows }] = await Promise.all([ … , <the activeCall query>, <the new callbacks query> ]);`)

- [ ] **Step 2: Read the viewer's role**

The page already queries `profiles` for `active_campaign_id`. Extend that select to include `role`:

```tsx
const { data: profileWithActive } = await supabase
  .from("profiles")
  .select("active_campaign_id, role")
  .eq("id", user.id)
  .single();
const isAdmin = profileWithActive?.role === "admin";
```

- [ ] **Step 3: Map callbacks + pass new props to the client**

After the `meta` object (before the `return`), add:

```tsx
const callbacks = (callbackRows ?? []).map((c) => ({
  id: c.id,
  scheduledAt: c.scheduled_at,
  status: c.status,
}));
```

In the `<LeadPageClient … />` JSX, add two props:

```tsx
isAdmin = { isAdmin };
callbacks = { callbacks };
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit` (LeadPageClient prop errors until Task 2); `npx eslint "src/app/(app)/leads/[id]/page.tsx"` clean.
- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/leads/[id]/page.tsx"
git commit -m "feat(leads): lead page fetches callbacks + viewer admin status"
```

---

## Task 2: Lead page client — thread admin + render callbacks

**Files:** Modify `src/app/(app)/leads/[id]/lead-page-client.tsx`

- [ ] **Step 1: Import the new component + type**

Add near the other local imports:

```tsx
import { LeadCallbacks, type LeadCallbackRow } from "./lead-callbacks";
```

- [ ] **Step 2: Add the props**

In the `LeadPageClient({ … })` destructure add `isAdmin,` and `callbacks,`; in its prop type add:

```tsx
  isAdmin: boolean;
  callbacks: LeadCallbackRow[];
```

- [ ] **Step 3: Pass `isAdmin` to the modal**

Change the mounted modal near the bottom from `<CallDetailModal />` to:

```tsx
<CallDetailModal isAdmin={isAdmin} />
```

- [ ] **Step 4: Render the Callbacks section**

In the RIGHT column, immediately after the `</section>` that closes the Activity block (the `data-testid="lead-activity-column"` section), add:

```tsx
<section
  data-testid="lead-callbacks-column"
  className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm"
>
  <h2 className="text-foreground text-sm font-semibold">Callbacks</h2>
  <LeadCallbacks callbacks={callbacks} isAdmin={isAdmin} />
</section>
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` (modal `isAdmin` prop error until Task 4); `npx eslint "src/app/(app)/leads/[id]/lead-page-client.tsx"` clean.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/leads/[id]/lead-page-client.tsx"
git commit -m "feat(leads): thread admin status + render callbacks section"
```

---

## Task 3: Callbacks list component

**Files:** Create `src/app/(app)/leads/[id]/lead-callbacks.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { useState, useTransition } from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { deleteCallbacks } from "@/lib/callbacks/actions";
import { exactDateTime, relativeTimeSigned } from "@/lib/relative-time";

export type LeadCallbackRow = {
  id: string;
  scheduledAt: string | null;
  status: string;
};

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "outline" | "destructive"
> = {
  pending: "default",
  completed: "secondary",
  missed: "destructive",
  cancelled: "outline",
};

/** The lead's callbacks, newest first. Admins can permanently delete one
 *  (reuses deleteCallbacks, which re-syncs the lead's next-call timing). */
export function LeadCallbacks({
  callbacks,
  isAdmin,
}: {
  callbacks: LeadCallbackRow[];
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();

  const visible = callbacks.filter((c) => !removed.has(c.id));

  function remove(id: string) {
    if (!window.confirm("Delete this callback? This can't be undone.")) return;
    setRemoved((s) => new Set(s).add(id)); // optimistic
    startTransition(async () => {
      const res = await deleteCallbacks([id]);
      if (res.error) {
        toast.error(res.error);
        setRemoved((s) => {
          const n = new Set(s);
          n.delete(id);
          return n;
        });
        return;
      }
      toast.success("Callback deleted");
      router.refresh();
    });
  }

  if (visible.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No callbacks scheduled.</p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((c) => (
        <li
          key={c.id}
          className="border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className="text-foreground font-medium"
              title={exactDateTime(c.scheduledAt)}
            >
              {relativeTimeSigned(c.scheduledAt)}
            </span>
            <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>
              {c.status}
            </Badge>
          </div>
          {isAdmin ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => remove(c.id)}
              aria-label="Delete callback"
              className="text-muted-foreground hover:text-destructive size-8"
            >
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
```

(Confirm `relativeTimeSigned` + `exactDateTime` are exported from `@/lib/relative-time` — they're already imported by `lead-page-client.tsx`. Confirm `Badge` variants include the names used; if `destructive`/`secondary` aren't valid Badge variants, fall back to `"outline"`.)

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for this file; `npx eslint "src/app/(app)/leads/[id]/lead-callbacks.tsx"` clean.
- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/leads/[id]/lead-callbacks.tsx"
git commit -m "feat(leads): callbacks list with admin delete"
```

---

## Task 4: Delete call from the call detail popup

**Files:** Modify `src/app/(app)/calls/call-detail-modal.tsx`

- [ ] **Step 1: Import `deleteCalls` + `Trash2`**

Add `Trash2` to the `lucide-react` import. Add `deleteCalls` to the `@/lib/calls/actions` import:

```tsx
import {
  deleteCalls,
  getCallDetail,
  overrideCallOutcome,
  scheduleManualCallback,
  type CallDetail,
  type TranscriptTurn,
} from "@/lib/calls/actions";
```

- [ ] **Step 2: Accept the `isAdmin` prop**

Change the component signature:

```tsx
export function CallDetailModal({ isAdmin = false }: { isAdmin?: boolean }) {
```

(All other mount sites — `/calls`, `/callbacks` — render `<CallDetailModal />` with no prop, so they default to `false` and show no delete button; only the lead page passes `isAdmin`.)

- [ ] **Step 3: Add a delete handler**

Inside the component, near `callAgain`, add (uses the existing `close`, `router`, and `useTransition` — add a transition state):

```tsx
const [deleting, startDelete] = useTransition();

function deleteThisCall() {
  if (!call) return;
  if (
    !window.confirm(
      "Delete this call? It's removed permanently and drops out of cost/analytics totals.",
    )
  )
    return;
  startDelete(async () => {
    const res = await deleteCalls([call.id]);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Call deleted");
    close();
    router.refresh();
  });
}
```

(`useTransition` is already imported at the top of the file.)

- [ ] **Step 4: Add the Delete button to the action bar**

In the sticky bottom action bar (the `<div … justify-end … border-t …>` containing `<ScheduleCallbackDialog>` + Call again), add a destructive Delete button pinned left, only for admins:

```tsx
{
  call ? (
    <div className="border-border bg-card flex flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
      {isAdmin ? (
        <Button
          type="button"
          variant="ghost"
          onClick={deleteThisCall}
          disabled={deleting}
          className="text-muted-foreground hover:text-destructive mr-auto"
        >
          <Trash2 className="size-4" />
          Delete call
        </Button>
      ) : null}
      <ScheduleCallbackDialog callId={call.id} />
      {call.leadId ? (
        <Button
          onClick={callAgain}
          className="bg-primary hover:bg-primary/90 text-white"
        >
          <PhoneCall className="size-4" />
          Call again
        </Button>
      ) : null}
    </div>
  ) : null;
}
```

- [ ] **Step 5: Verify (full)**
  - `npx tsc --noEmit` → only the 3 pre-existing `twilio-*.spec.ts` errors.
  - `npx eslint "src/app/(app)/calls/call-detail-modal.tsx" "src/app/(app)/leads"` → clean.
  - `npm run build` → success.
- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/calls/call-detail-modal.tsx"
git commit -m "feat(calls): admin Delete call button in the call detail popup"
```

---

## Task 5: Playwright contract

**Files:** Modify `tests/lead-detail.spec.ts` if it exists, else create `tests/lead-delete.spec.ts`

- [ ] **Step 1: Write the spec**

Seed (service-role, `E2E_TEST_EMAIL` owner): a lead with one completed `call` (lead_id set) and one `pending` callback (lead_id set, scheduled_at in the future). The E2E user is an admin (the existing reporting specs rely on admin access). Assert:

- The lead page (`/leads/<id>`) shows a "Callbacks" section listing the callback (its status text), with a "Delete callback" control.
- Clicking Delete callback (accept the confirm via `page.on("dialog", d => d.accept())`) removes it — the row disappears and the `callbacks` row is gone from the DB.
- Opening the call (`/leads/<id>?call=<callId>`) shows a "Delete call" button; clicking it (accept confirm) closes the popup and removes the call (gone from the feed; `calls` row deleted; `leads.call_attempts` decremented).

Use `page.getByRole("button", { name: /delete callback/i })`, `page.getByRole("button", { name: /delete call/i })`, and `page.on("dialog", …)` for the `window.confirm`. Verify DB state via the service client. Clean up any remaining seeded rows in `afterAll`.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean for the spec; `npx eslint <spec>` clean. (Do not run Playwright.)
- [ ] **Step 3: Commit**

```bash
git add tests/
git commit -m "test(leads): delete call + callback from the lead page"
```

---

## Task 6: Final verification + PR

- [ ] **Step 1: Full gates**

```bash
npx tsc --noEmit
npx eslint "src/app/(app)/leads" "src/app/(app)/calls/call-detail-modal.tsx"
npm run build
```

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/lead-delete-calls-callbacks
gh pr create --base main --head feat/lead-delete-calls-callbacks \
  --title "feat(leads): delete calls & callbacks from the lead page" \
  --body "Admins can delete a call (button in the call detail popup) and a callback (new Callbacks section) on the lead detail page. Reuses the existing admin-only deleteCalls / deleteCallbacks (which recompute the lead's counters / re-sync next-call timing). No DB migration. Spec/plan in docs/superpowers."
```

- [ ] **Step 3: Confirm with Marija before merging** (production-facing; merge auto-deploys).

---

## Self-review notes

- **Spec coverage:** admin-only (Task 1 role, Tasks 3/4 gate on `isAdmin`; server actions already admin-gated) ✓; call delete in the popup (Task 4) ✓; new Callbacks section + delete (Tasks 1–3) ✓; hard delete reusing existing actions + recompute/re-sync (Tasks 3/4) ✓; confirms on both ✓; no migration ✓.
- **Type consistency:** `LeadCallbackRow {id, scheduledAt, status}` defined in `lead-callbacks.tsx`, produced by `page.tsx`'s `callbacks` map, consumed by `LeadPageClient` → `LeadCallbacks`. `CallDetailModal({ isAdmin })` matches the lead page's `<CallDetailModal isAdmin={isAdmin} />` and defaults `false` for the other two mount sites. `deleteCalls`/`deleteCallbacks` return `{ error, deleted? }` — handled.
- **Placeholder scan:** none. (Two "confirm X is exported/valid" notes are verification asks, not placeholders — the imports already exist in sibling files.)
