# Call Reviewer — clearer curation UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Call Reviewer's curation actions clear and give real tuning power — split "review calls" from "tune the AI," plain-language the per-call actions, and add an "AI's checklist" (active flags + track record + turn off/on + edit).

**Architecture:** Reframe copy in `CallReviewPanel`; add two admin actions (`setFlagActive`, `updateFlagDef`) + a `fetchChecklistFlags` reader (active flags joined to JS-tallied confirmed/rejected counts, no schema change); a new `AiChecklistPanel` that lists them with turn off/on + edit and embeds the existing suggestions; split the Call Review tab into two labeled sections.

**Tech Stack:** Next.js (App Router, server actions), Supabase (service-role + admin-RLS), React, Vitest.

**Spec:** [docs/superpowers/specs/2026-07-15-call-review-curation-ux-design.md](../specs/2026-07-15-call-review-curation-ux-design.md) — **no migration.**

---

## File structure

- **Modify** `src/lib/review/actions.ts` — add `setFlagActive`, `updateFlagDef`.
- **Modify** `src/lib/review/buckets.ts` — add `ChecklistFlag`, pure `shapeChecklist`, `fetchChecklistFlags`.
- **Create** `tests/review-checklist.unit.test.ts` — `shapeChecklist` tests.
- **Modify** `src/app/(app)/calls/call-detail-modal.tsx` — reframe the per-flag + panel copy.
- **Create** `src/app/(app)/reporting/ai-checklist-panel.tsx` — the checklist UI (embeds `SuggestedFlagsPanel`).
- **Modify** `src/app/(app)/reporting/page.tsx` — `CallReviewTab`: fetch checklist, render two labeled sections.
- **Modify** `src/app/(app)/reporting/suggested-flags-panel.tsx` — clarify copy only.

---

### Task 0: Branch + commit docs

- [ ] `git checkout -b feat/call-review-curation-ux`
- [ ] `git add docs/superpowers/specs/2026-07-15-call-review-curation-ux-design.md docs/superpowers/plans/2026-07-15-call-review-curation-ux.md && git commit -m "docs: call review curation UX design/plan"`

---

### Task 1: Curation actions (`review/actions.ts`)

- [ ] **Step 1: Add both actions** (after `dismissCandidate`, mirroring its admin-gate + service-role pattern)

```ts
/** Turn an active flag off (retire — Pass 1 stops checking it, its bucket
 *  disappears) or back on. Admin-only. Scoped to non-candidate defs so it can
 *  never flip a discovery candidate. */
export async function setFlagActive(input: {
  key: string;
  active: boolean;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update({ active: input.active })
    .eq("key", input.key)
    .eq("is_candidate", false);
  if (error) return { error: "Could not update the flag." };
  revalidatePath("/reporting");
  return { error: null };
}

/** Edit an active flag's wording/severity so it fires more precisely. Admin-only.
 *  Empty fields are left unchanged; severity clamps to 1-4. */
export async function updateFlagDef(input: {
  key: string;
  label?: string;
  guidance?: string;
  severity?: number;
}): Promise<{ error: string | null }> {
  if (!(await currentAdminId())) return { error: "Admins only." };
  const patch: Record<string, unknown> = {};
  if (input.label?.trim()) patch.label = input.label.trim();
  if (input.guidance?.trim()) patch.guidance = input.guidance.trim();
  if (typeof input.severity === "number")
    patch.severity = Math.min(4, Math.max(1, Math.round(input.severity)));
  if (Object.keys(patch).length === 0) return { error: null };
  const { error } = await adminClient()
    .from("review_flag_defs")
    .update(patch)
    .eq("key", input.key)
    .eq("is_candidate", false);
  if (error) return { error: "Could not save the flag." };
  revalidatePath("/reporting");
  return { error: null };
}
```

- [ ] **Step 2:** `npx tsc --noEmit && npx eslint src/lib/review/actions.ts` → clean.
- [ ] **Step 3:** `git add src/lib/review/actions.ts && git commit -m "feat(review): setFlagActive + updateFlagDef curation actions"`

---

### Task 2: Checklist reader + pure helper (TDD)

**Files:** Modify `src/lib/review/buckets.ts`; Test `tests/review-checklist.unit.test.ts`.

- [ ] **Step 1: Write the failing test**

`tests/review-checklist.unit.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { shapeChecklist, type ChecklistDef } from "../src/lib/review/buckets";

const def = (key: string, active: boolean): ChecklistDef => ({
  key,
  label: key,
  lens: "quality",
  severity: 2,
  guidance: `check ${key}`,
  active,
});

describe("shapeChecklist", () => {
  it("tallies confirmed/rejected per flag and keeps active first", () => {
    const defs = [def("tool_error", true), def("old_flag", false)];
    const rows = [
      { flag_key: "tool_error", status: "confirmed" },
      { flag_key: "tool_error", status: "rejected" },
      { flag_key: "tool_error", status: "confirmed" },
      { flag_key: "old_flag", status: "rejected" },
      { flag_key: "gone", status: "confirmed" }, // no def → ignored
    ];
    const out = shapeChecklist(defs, rows);
    expect(out.map((f) => f.key)).toEqual(["tool_error", "old_flag"]);
    expect(out[0]).toMatchObject({ active: true, confirmed: 2, rejected: 1 });
    expect(out[1]).toMatchObject({ active: false, confirmed: 0, rejected: 1 });
  });
  it("returns zero tallies when a flag has no history", () => {
    expect(shapeChecklist([def("x", true)], [])[0]).toMatchObject({
      confirmed: 0,
      rejected: 0,
    });
  });
});
```

- [ ] **Step 2: Run it, watch it fail** — `npx vitest run tests/review-checklist.unit.test.ts` → not exported.

- [ ] **Step 3: Implement** (append to `buckets.ts`)

```ts
/** An active (or retired) rubric flag + its human track record, for the checklist. */
export type ChecklistDef = Pick<
  ReviewFlagDef,
  "key" | "label" | "lens" | "severity" | "guidance"
> & { active: boolean };

export type ChecklistFlag = ChecklistDef & {
  confirmed: number;
  rejected: number;
};

/** Join non-candidate defs to their confirmed/rejected tallies. Pure. Active
 *  flags first (both groups keep def order), so the running checklist leads and
 *  retired flags trail. Flag rows with no matching def are ignored. */
export function shapeChecklist(
  defs: ChecklistDef[],
  rows: { flag_key: string | null; status: string }[],
): ChecklistFlag[] {
  const conf = new Map<string, number>();
  const rej = new Map<string, number>();
  for (const r of rows) {
    if (!r.flag_key) continue;
    if (r.status === "confirmed")
      conf.set(r.flag_key, (conf.get(r.flag_key) ?? 0) + 1);
    else if (r.status === "rejected")
      rej.set(r.flag_key, (rej.get(r.flag_key) ?? 0) + 1);
  }
  const shaped = defs.map((d) => ({
    ...d,
    confirmed: conf.get(d.key) ?? 0,
    rejected: rej.get(d.key) ?? 0,
  }));
  return [
    ...shaped.filter((f) => f.active),
    ...shaped.filter((f) => !f.active),
  ];
}

/** Load the checklist: every non-candidate flag + its confirm/reject tallies.
 *  Paginates call_review_flags (PostgREST 1000-row cap) and tallies in JS —
 *  no group-by view needed. Admin-gated via the caller's RLS client. */
export async function fetchChecklistFlags(
  client: ServerClient,
): Promise<ChecklistFlag[]> {
  const { data: defs } = await client
    .from("review_flag_defs")
    .select("key, label, lens, severity, guidance, active")
    .eq("is_candidate", false)
    .order("severity", { ascending: true })
    .order("label", { ascending: true });

  const rows: { flag_key: string | null; status: string }[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("call_review_flags")
      .select("flag_key, status")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) break;
    const page = data ?? [];
    for (const r of page) rows.push({ flag_key: r.flag_key, status: r.status });
    if (page.length < PAGE) break;
  }
  return shapeChecklist((defs ?? []) as ChecklistDef[], rows);
}
```

- [ ] **Step 4: Run it, watch it pass** — `npx vitest run tests/review-checklist.unit.test.ts` → passes.
- [ ] **Step 5:** `git add src/lib/review/buckets.ts tests/review-checklist.unit.test.ts && git commit -m "feat(review): checklist reader + track-record tally (+tests)"`

---

### Task 3: Reframe the per-call panel (`call-detail-modal.tsx`)

**Files:** Modify `CallReviewPanel` (~260-329).

- [ ] **Step 1: Header — add a one-line explainer** under the "Call review" title row. After the header `</div>` (the flex row with the Mark-reviewed button, ~272) insert:

```tsx
<p className="text-muted-foreground -mt-1 text-xs">
  Tell the AI if each flag is right — it sharpens future reviews. &ldquo;Mark
  reviewed&rdquo; just means you&apos;ve handled this call.
</p>
```

- [ ] **Step 2: Relabel Confirm/Reject** (~308-323). Replace the two buttons' text and add a title, keeping the same `updateFlag` calls:

```tsx
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || f.status === "confirmed"}
                  onClick={() => updateFlag(f.id, "confirmed")}
                  title="This flag is correct"
                >
                  Looks right
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || f.status === "rejected"}
                  onClick={() => updateFlag(f.id, "rejected")}
                  title="False alarm — removes it from this bucket and counts against this flag's accuracy"
                >
                  False alarm
                </Button>
```

- [ ] **Step 3:** `npx tsc --noEmit && npx eslint "src/app/(app)/calls/call-detail-modal.tsx"` → clean.
- [ ] **Step 4:** `git add "src/app/(app)/calls/call-detail-modal.tsx" && git commit -m "feat(review): plain-language the per-flag review actions"`

---

### Task 4: The AI's checklist panel

**Files:** Create `src/app/(app)/reporting/ai-checklist-panel.tsx`.

- [ ] **Step 1: Implement** — an active-flags list with track record + turn off/on + an edit dialog, and the suggestions panel embedded.

```tsx
"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListChecks, Power, Pencil } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { setFlagActive, updateFlagDef } from "@/lib/review/actions";
import type { ChecklistFlag, CandidateFlag } from "@/lib/review/buckets";
import { SuggestedFlagsPanel } from "./suggested-flags-panel";

export function AiChecklistPanel({
  flags,
  candidates,
}: {
  flags: ChecklistFlag[];
  candidates: CandidateFlag[];
}) {
  const active = flags.filter((f) => f.active);
  const retired = flags.filter((f) => !f.active);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ListChecks className="text-muted-foreground size-5" />
        <h3 className="text-foreground text-sm font-semibold">
          The AI&apos;s checklist
        </h3>
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">
        What the reviewer looks for on every call. Turn off ones that misfire,
        edit what a flag means to sharpen it, or add a suggestion below.
      </p>
      <SuggestedFlagsPanel candidates={candidates} />
      <div className="border-border overflow-hidden rounded-xl border">
        {active.map((f, i) => (
          <ChecklistRow key={f.key} flag={f} topBorder={i > 0} />
        ))}
      </div>
      {retired.length > 0 ? (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">
            Turned off ({retired.length})
          </summary>
          <div className="border-border mt-2 overflow-hidden rounded-xl border">
            {retired.map((f, i) => (
              <ChecklistRow key={f.key} flag={f} topBorder={i > 0} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ChecklistRow({
  flag,
  topBorder,
}: {
  flag: ChecklistFlag;
  topBorder: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const total = flag.confirmed + flag.rejected;
  const falseAlarmPct =
    total > 0 ? Math.round((flag.rejected / total) * 100) : 0;

  function toggle() {
    start(async () => {
      const r = await setFlagActive({ key: flag.key, active: !flag.active });
      if (r.error) return toast.error(r.error);
      toast.success(flag.active ? "Turned off." : "Turned on.");
      router.refresh();
    });
  }

  return (
    <div
      className={`flex items-start justify-between gap-3 px-4 py-3 ${
        topBorder ? "border-border border-t" : ""
      } ${flag.active ? "" : "opacity-60"}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-medium">
            {flag.label}
          </span>
          <Badge variant="outline">sev {flag.severity}</Badge>
          {total > 0 ? (
            <span
              className={`text-xs ${
                falseAlarmPct >= 40 ? "text-amber-700" : "text-muted-foreground"
              }`}
            >
              {flag.confirmed} right · {flag.rejected} false alarm
              {falseAlarmPct >= 40 ? ` (${falseAlarmPct}% off)` : ""}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              no history yet
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{flag.guidance}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <EditFlagDialog flag={flag} onDone={() => router.refresh()} />
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={toggle}
          title={flag.active ? "Turn this flag off" : "Turn this flag back on"}
        >
          <Power className="size-4" />
          {flag.active ? "Turn off" : "Turn on"}
        </Button>
      </div>
    </div>
  );
}

function EditFlagDialog({
  flag,
  onDone,
}: {
  flag: ChecklistFlag;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [label, setLabel] = useState(flag.label);
  const [guidance, setGuidance] = useState(flag.guidance);

  function save() {
    start(async () => {
      const r = await updateFlagDef({ key: flag.key, label, guidance });
      if (r.error) return toast.error(r.error);
      toast.success("Saved.");
      setOpen(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" title="Edit what this flag means">
          <Pencil className="size-4" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit flag</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flag-label">Name</Label>
            <Input
              id="flag-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="flag-guidance">
              What it checks (the AI reads this)
            </Label>
            <Textarea
              id="flag-guidance"
              rows={4}
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2:** `npx tsc --noEmit && npx eslint "src/app/(app)/reporting/ai-checklist-panel.tsx"` → clean.
- [ ] **Step 3:** `git add "src/app/(app)/reporting/ai-checklist-panel.tsx" && git commit -m "feat(review): AI checklist panel (track record + turn off/on + edit)"`

---

### Task 5: Split the tab + wire it (`reporting/page.tsx`)

- [ ] **Step 1: Imports** — add `fetchChecklistFlags` to the buckets import and import the panel:

```ts
import {
  fetchReviewBuckets,
  fetchCandidateFlags,
  fetchChecklistFlags,
} from "@/lib/review/buckets";
import { AiChecklistPanel } from "./ai-checklist-panel";
```

- [ ] **Step 2: `CallReviewTab`** — fetch the checklist and render two labeled sections (buckets first, checklist second; the old `SuggestedFlagsPanel` moves _inside_ `AiChecklistPanel`, so drop its standalone render):

```tsx
async function CallReviewTab() {
  const supabase = await createClient();
  const [{ summary, buckets }, candidates, checklist] = await Promise.all([
    fetchReviewBuckets(supabase),
    fetchCandidateFlags(supabase),
    fetchChecklistFlags(supabase),
  ]);
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-foreground text-base font-semibold">
          Review flagged calls
        </h2>
        <CallReviewTable summary={summary} buckets={buckets} />
      </section>
      <section className="flex flex-col gap-3">
        <AiChecklistPanel flags={checklist} candidates={candidates} />
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Recopy the suggestions panel** (`suggested-flags-panel.tsx`) — tighten the header/blurb so it reads as part of the checklist (e.g. title "New flags the AI suggests", blurb "Add one to the checklist, or dismiss it."). Cosmetic only.

- [ ] **Step 4:** `npx tsc --noEmit && npx eslint "src/app/(app)/reporting/page.tsx" "src/app/(app)/reporting/suggested-flags-panel.tsx"` → clean.
- [ ] **Step 5:** `git add "src/app/(app)/reporting/page.tsx" "src/app/(app)/reporting/suggested-flags-panel.tsx" && git commit -m "feat(review): split Call Review tab into review + checklist"`

---

### Task 6: Full verification gate

- [ ] `npx tsc --noEmit`
- [ ] `npx eslint src/lib/review "src/app/(app)/reporting" "src/app/(app)/calls/call-detail-modal.tsx" tests/review-checklist.unit.test.ts`
- [ ] `npm run build`
- [ ] `npx vitest run tests/review-checklist.unit.test.ts tests/call-reviewer.unit.test.ts`
      Expected: all clean; checklist + existing review tests pass.

---

### Task 7: Ship + re-run all calls

- [ ] **Push + PR + merge** to `main`.
- [ ] **Re-run ALL calls** (one-time, guarded, service role): for **every** `call_reviews` row with `status='done'` (including the 20 human-reviewed) — delete its `call_review_flags`, set `status='pending'`, clear `reviewed_at/needs_review/analyzed_at`. Print before/after counts. The cron re-analyzes them with the playbook. (Deploy first, then re-queue, so re-analysis uses current code.)
- [ ] **Verify** on Reporting → Call Review: two labeled sections render; a flag's "Turn off" removes its bucket + reactivate restores it; Edit changes the guidance; the track record reflects Looks-right/False-alarm actions. Report to Marija.

---

## Self-review notes

- **Spec coverage:** two sections (Task 5), plain-language per-flag (Task 3), checklist with track record + turn off/on + edit (Tasks 1/2/4), suggestions moved in (Task 4/5), re-run all (Task 7). No migration. All covered.
- **Type consistency:** `ChecklistDef`/`ChecklistFlag`/`shapeChecklist`/`fetchChecklistFlags` defined in Task 2, consumed by `AiChecklistPanel` (Task 4) + `CallReviewTab` (Task 5); `setFlagActive`/`updateFlagDef` defined in Task 1, called in Task 4.
- **No-migration confirmed:** retire=`active` (exists), edit=`label`/`guidance`/`severity` (exist), track record tallied from `call_review_flags.status` (exists).
