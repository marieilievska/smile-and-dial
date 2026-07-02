# Per-campaign call summaries — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the summary/notes context passed to ElevenLabs to the current campaign (no cross-campaign bleed), make the rolling summary facts-only (no stale "next time do X"), and let operators edit/clear a lead's per-campaign summary — while `leads.ai_summary` stays as a denormalized "latest campaign summary" for the leads list + CSV.

**Architecture:** A new `lead_campaign_summaries` table holds one rolling summary per (lead, campaign). The post-call merge writes the per-campaign row AND copies it into `leads.ai_summary`; conversation-init reads the current campaign's row; the merge prompt is rewritten to facts-only; the lead page shows a per-campaign breakdown with edit/clear.

**Tech Stack:** Next.js (server actions/RSC), Supabase (migration + typed + service-role clients), OpenAI (gpt-4o-mini merge), ElevenLabs webhooks, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-01-per-campaign-summary-design.md`

**Branch:** `feat/per-campaign-summary` (created; spec committed).

**Testing note:** No local unit runner — Playwright runs against the live env only. Verify each task with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build` on UI tasks). Baseline: the 3 pre-existing `twilio-*.spec.ts` tsc errors are expected.

**⚠️ Migration + types (Task 1) touch the LIVE DB — controller-run, not a fire-and-forget subagent.** The migration is additive (safe) and must be applied (`supabase db push --linked`) BEFORE the code deploy; `database.types.ts` is then regenerated from the live schema so the typed client compiles.

---

## File structure

- **Create** `supabase/migrations/<ts>_lead_campaign_summaries.sql` — table + RLS + backfill.
- **Modify** `src/lib/supabase/database.types.ts` — regenerated (adds the new table).
- **Modify** `src/lib/openai/summary-merger.ts` — per-campaign read/write + dual-write `leads.ai_summary` + facts-only prompt.
- **Modify** `src/lib/elevenlabs/post-call-webhook.ts` — pass `campaignId` to `mergeLeadSummary`.
- **Modify** `src/lib/elevenlabs/conversation-init.ts` — read the per-campaign summary; campaign-gate `last_callback_notes`.
- **Modify** `src/lib/leads/recompute-call-state.ts` — clear the lead's per-campaign rows on reset.
- **Create** `src/app/(app)/leads/[id]/campaign-summaries.tsx` — per-campaign display + edit/clear (client).
- **Modify** `src/lib/leads/lead-actions.ts` — `updateLeadCampaignSummary` / `clearLeadCampaignSummary` actions; extend the name-scrub to the per-campaign rows.
- **Modify** `src/app/(app)/leads/[id]/page.tsx` + `lead-page-client.tsx` — fetch + render the per-campaign section.
- **Modify** `tests/` — a spec for the merge scoping + the actions.

---

## Task 1: Migration + type regen (controller-run; touches live DB)

**Files:** Create `supabase/migrations/<timestamp>_lead_campaign_summaries.sql`; regenerate `src/lib/supabase/database.types.ts`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/<timestamp>_lead_campaign_summaries.sql` (use a timestamp later than the latest existing migration). Mirror the RLS shape of an existing per-lead table (`lead_custom_values`) — open that table's policies first and match the `is_admin`/owner predicate style exactly. Content:

```sql
-- Per-(lead, campaign) rolling AI summary, so call context is scoped to the
-- campaign instead of bleeding across campaigns. leads.ai_summary stays as a
-- denormalized "latest campaign summary" for the leads list + CSV.
create table if not exists public.lead_campaign_summaries (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  ai_summary text,
  updated_at timestamptz not null default now(),
  unique (lead_id, campaign_id)
);

create index if not exists lead_campaign_summaries_lead_id_idx
  on public.lead_campaign_summaries (lead_id);

alter table public.lead_campaign_summaries enable row level security;

-- Owner (or admin) can READ their leads' per-campaign summaries (the lead page
-- reads via the typed RLS client). WRITES go through service-role server actions
-- with an in-code owner/admin check (merger, reset, backfill, manual edit) —
-- matching the convention for other derived tables (hot_lead_dismissals,
-- dashboard_notes). Service-role bypasses RLS, so no write policy is needed.
create policy "read own lead campaign summaries"
  on public.lead_campaign_summaries for select
  to authenticated
  using (
    exists (
      select 1 from public.leads l
      where l.id = lead_campaign_summaries.lead_id
        and (l.owner_id = (select auth.uid()) or public.is_admin((select auth.uid())))
    )
  );

-- Backfill: seed each lead's existing rolling summary into the campaign of its
-- most recent call, so existing context isn't lost.
insert into public.lead_campaign_summaries (lead_id, campaign_id, ai_summary)
select distinct on (l.id) l.id, c.campaign_id, l.ai_summary
from public.leads l
join public.calls c on c.lead_id = l.id and c.campaign_id is not null
where coalesce(trim(l.ai_summary), '') <> ''
order by l.id, c.started_at desc nulls last
on conflict (lead_id, campaign_id) do nothing;
```

NOTE: verify `public.is_admin(uuid)` exists (it's used by other RLS policies per the repo). If the admin predicate differs, match the exact form used by `lead_custom_values` / another per-lead table.

- [ ] **Step 2: Apply to the live DB (controller)**

Run: `supabase db push --linked`
Expected: the migration applies cleanly (additive). This is a prod write — run deliberately, before any code deploy.

- [ ] **Step 3: Regenerate types**

Regenerate `src/lib/supabase/database.types.ts` from the live schema so the typed client knows `lead_campaign_summaries` (either the Supabase MCP `generate_typescript_types` tool, or `supabase gen types typescript --linked`). Confirm the file now contains a `lead_campaign_summaries` table type.

- [ ] **Step 4: Verify + commit**

Run: `npx tsc --noEmit` → still only the 3 baseline errors (the regenerated types add the table; nothing references it yet).

```bash
git add supabase/migrations src/lib/supabase/database.types.ts
git commit -m "feat(db): lead_campaign_summaries table + backfill + regen types"
```

---

## Task 2: Per-campaign merge + facts-only prompt

**Files:** Modify `src/lib/openai/summary-merger.ts`, `src/lib/elevenlabs/post-call-webhook.ts`

Context: `mergeLeadSummary({ leadId, latestSummary })` reads `leads.ai_summary`, pulls the last 5 call summaries for the lead (any campaign), merges via gpt-4o-mini (or `mockMerge`), writes `leads.ai_summary`, returns `{ newSummary, cost, mode }`. The post-call webhook step 39 calls it with `{ leadId: call.lead_id, latestSummary }`. The merge uses a service-role `createClient` (untyped — so `.from("lead_campaign_summaries")` needs no generated type there).

- [ ] **Step 1: Change `mergeLeadSummary` to per-campaign + dual-write**

In `src/lib/openai/summary-merger.ts`, change the signature to accept `campaignId` and rework the read/pull/write:

- Signature: `mergeLeadSummary(input: { leadId: string; campaignId: string; latestSummary?: string | null })`.
- Read the existing summary from the per-campaign row:

```ts
const { data: existingRow } = await supabase
  .from("lead_campaign_summaries")
  .select("ai_summary")
  .eq("lead_id", input.leadId)
  .eq("campaign_id", input.campaignId)
  .maybeSingle();
const existing = (existingRow?.ai_summary ?? "").trim();
```

(Remove the old `leads.ai_summary` read.)

- Scope the recent-calls pull to the campaign: add `.eq("campaign_id", input.campaignId)` to the `calls` query.
- After computing `newSummary`, upsert the per-campaign row AND copy to `leads.ai_summary` (the denormalized latest):

```ts
await supabase.from("lead_campaign_summaries").upsert(
  {
    lead_id: input.leadId,
    campaign_id: input.campaignId,
    ai_summary: newSummary,
    updated_at: new Date().toISOString(),
  },
  { onConflict: "lead_id,campaign_id" },
);
await supabase
  .from("leads")
  .update({ ai_summary: newSummary })
  .eq("id", input.leadId);
```

(Replace the old single `leads` update.)

- [ ] **Step 2: Rewrite the merge prompt to facts-only**

In `callOpenAi`, replace the `userPrompt` so it drops the prescriptive "Next time: Z" line and instead captures reachability as facts. New `userPrompt`:

```ts
const userPrompt = `Existing note about this lead:
${existing || "(none yet)"}

Newest call summary:
${latest}

Rewrite the running note as a FACTUAL record for the next caller. Past tense
(these calls already happened). Capture ONLY:
- Who/what we know about the lead (name/role IF given, business specifics, hours).
- What actually happened and what the LEAD said — their questions, objections,
  stated interest/disinterest. If they didn't engage (hold, hang-up, voicemail,
  gatekeeper only), say plainly what blocked us.
- REACHABILITY as facts: who we can/can't reach and who handles things — e.g.
  "owner is never on-site; the front desk/manager <name> handles leads; best
  contact is email <x>". State the facts; do NOT prescribe a next action.
- The lead's own stated pain point, ONLY if the LEAD raised it. Never guess one.
- A commitment ONLY if the lead explicitly agreed (callback time, permission to
  send info). If none, say no commitment was made.

Do NOT restate the agent's pitch/questions as the lead's interest. Do NOT invent
details. Do NOT include dates or "X ago" timing. Do NOT tell the next caller what
to DO ("email the owner", "call back and pitch X") — record the facts and let the
caller decide. Write 2–5 short sentences. Max 200 words. No filler.`;
```

Leave the system prompt (attribution guardrails) unchanged.

- [ ] **Step 3: Pass `campaignId` from the post-call webhook**

In `src/lib/elevenlabs/post-call-webhook.ts` step 39, change the merge call to pass the campaign, and guard on it:

```ts
  if (latestSummary && call.campaign_id) {
    const { cost } = await mergeLeadSummary({
      leadId: call.lead_id,
      campaignId: call.campaign_id,
      latestSummary,
    });
```

(Keep the existing cost-bump block inside. If `call.campaign_id` is null — non-campaign dial — skip the merge.) Confirm `call.campaign_id` is available on the `call` object in scope; if the local `call` doesn't select `campaign_id`, add it to that call's select.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` → only baseline errors. `npx eslint "src/lib/openai/summary-merger.ts" "src/lib/elevenlabs/post-call-webhook.ts"` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/openai/summary-merger.ts src/lib/elevenlabs/post-call-webhook.ts
git commit -m "feat(summary): per-campaign rolling summary + facts-only merge prompt"
```

---

## Task 3: Per-campaign read in conversation-init

**Files:** Modify `src/lib/elevenlabs/conversation-init.ts`

Context: `buildVarsForCall(supabase, call)` (call has `id`, `lead_id`, `campaign_id`) builds the dynamic vars. It reads `leads.ai_summary` into `summaryText` (line ~262) and computes `last_call_summary` with a recency prefix. `last_callback_notes` comes from the pending callback's originating call `summary` (line ~248-254). `supabase` here is the service-role admin client (untyped for new tables).

- [ ] **Step 1: Read the per-campaign summary**

Replace the `leads` select's `ai_summary` usage. Drop `ai_summary` from the `leads` select (line ~220) — it's no longer needed there. After the `Promise.all`, fetch the per-campaign summary:

```ts
let summaryText = "";
if (call.campaign_id) {
  const { data: cs } = await supabase
    .from("lead_campaign_summaries")
    .select("ai_summary")
    .eq("lead_id", call.lead_id)
    .eq("campaign_id", call.campaign_id)
    .maybeSingle();
  summaryText = cs?.ai_summary?.trim() ?? "";
}
```

Then keep the existing recency-prefix logic building `lastCallSummary` from `summaryText`.

- [ ] **Step 2: Campaign-gate `last_callback_notes`**

Change the originating-call fetch to also select `campaign_id`, and only use its summary when it matches the current call's campaign:

```ts
let lastCallbackNotes = "";
if (pendingCallback?.originating_call_id) {
  const { data: originating } = await supabase
    .from("calls")
    .select("summary, campaign_id")
    .eq("id", pendingCallback.originating_call_id)
    .maybeSingle();
  if (originating?.campaign_id === call.campaign_id) {
    lastCallbackNotes = originating?.summary?.trim() ?? "";
  }
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/elevenlabs/conversation-init.ts"` → clean. Confirm `ai_summary` no longer referenced in this file (`grep -n ai_summary src/lib/elevenlabs/conversation-init.ts` → none).

- [ ] **Step 4: Commit**

```bash
git add src/lib/elevenlabs/conversation-init.ts
git commit -m "feat(elevenlabs): read per-campaign summary + campaign-gate callback notes"
```

---

## Task 4: Clear per-campaign rows on reset

**Files:** Modify `src/lib/leads/recompute-call-state.ts`

Context: `recomputeLeadCallState` runs after calls are deleted; it rebuilds lead fields including `leads.ai_summary` (kept — it's the denormalized latest). `admin` is the service-role client.

- [ ] **Step 1: Delete the lead's per-campaign rows**

Near the top of the function (after `admin` is available, before/after the `leads` update), add:

```ts
// Per-campaign rolling summaries rebuild from subsequent calls; clear them on
// reset so stale campaign memory doesn't survive a wipe. (leads.ai_summary,
// the denormalized latest, is still handled below.)
await admin.from("lead_campaign_summaries").delete().eq("lead_id", leadId);
```

Leave the existing `leads.ai_summary` reset logic as-is.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/leads/recompute-call-state.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/leads/recompute-call-state.ts
git commit -m "feat(leads): clear per-campaign summaries on reset"
```

---

## Task 5: Server actions + name-scrub extension

**Files:** Modify `src/lib/leads/lead-actions.ts`

Context: `lead-actions.ts` is `"use server"`, uses the TYPED `createClient` from `@/lib/supabase/server` (so `lead_campaign_summaries` must be in `database.types.ts` — done in Task 1). It has `updateLeadField` with a name-scrub that rewrites `leads.ai_summary` (lines ~59-96). `lead_campaign_summaries` has SELECT-only RLS (Task 1), so every WRITE to it (the scrub below and both actions in Step 2) must go through a service-role client behind an in-code owner/admin gate — matching `src/lib/close/actions.ts`.

- [ ] **Step 1: Add the service-role helper + owner/admin gate**

At the top of `lead-actions.ts`, add the import and helpers (mirroring `close/actions.ts` — do NOT duplicate if some already exist):

```ts
import { createClient as createAdminClient } from "@supabase/supabase-js";

function makeServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createAdminClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Owner/admin gate for a lead. Returns an error object when denied, else null. */
async function assertLeadAccess(
  supabase: Awaited<ReturnType<typeof createClient>>,
  leadId: string,
): Promise<{ error: string } | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };
  const [{ data: lead }, { data: me }] = await Promise.all([
    supabase.from("leads").select("owner_id").eq("id", leadId).maybeSingle(),
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  if (!lead) return { error: "Lead not found." };
  if (lead.owner_id !== user.id && me?.role !== "admin") {
    return { error: "You don't have access to this lead." };
  }
  return null;
}
```

- [ ] **Step 2: Extend the name-scrub to the per-campaign rows**

After the existing `scrub` block that updates `leads.ai_summary` (inside `updateLeadField`), also rewrite the name across the lead's `lead_campaign_summaries` rows. The scrub writes those rows via the service-role client (`updateLeadField` already verified the caller owns the lead before reaching here, so no extra gate is needed):

```ts
if (scrub) {
  const admin = makeServiceClient();
  const re = new RegExp(`\\b${escapeRegExp(scrub.old)}\\b`, "gi");
  const { data: rows } = await admin
    .from("lead_campaign_summaries")
    .select("id, ai_summary")
    .eq("lead_id", input.leadId);
  for (const row of rows ?? []) {
    const cur = row.ai_summary ?? "";
    const fixed = cur.replace(re, scrub.next);
    if (fixed !== cur) {
      await admin
        .from("lead_campaign_summaries")
        .update({ ai_summary: fixed })
        .eq("id", row.id);
    }
  }
}
```

(Place this alongside the existing `leads.ai_summary` scrub — both run.)

- [ ] **Step 3: Add the two actions**

Append two server actions. Each gates on `assertLeadAccess` (owner/admin) using the typed client, then writes via the service-role client (the SELECT-only RLS blocks a typed-client write). Mirrors `handoffLeadToClose`:

```ts
/** Edit a lead's per-campaign rolling summary (the memory the next same-campaign
 *  call sees). Owner/admin only. */
export async function updateLeadCampaignSummary(input: {
  leadId: string;
  campaignId: string;
  summary: string;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const gate = await assertLeadAccess(supabase, input.leadId);
  if (gate) return gate;

  const admin = makeServiceClient();
  const { error } = await admin
    .from("lead_campaign_summaries")
    .update({
      ai_summary: input.summary.trim(),
      updated_at: new Date().toISOString(),
    })
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId);
  if (error) return { error: "Could not save the summary." };

  revalidatePath(`/leads/${input.leadId}`);
  return { error: null };
}

/** Clear (delete) a lead's per-campaign summary so the next same-campaign call
 *  starts fresh. Owner/admin only. */
export async function clearLeadCampaignSummary(input: {
  leadId: string;
  campaignId: string;
}): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const gate = await assertLeadAccess(supabase, input.leadId);
  if (gate) return gate;

  const admin = makeServiceClient();
  const { error } = await admin
    .from("lead_campaign_summaries")
    .delete()
    .eq("lead_id", input.leadId)
    .eq("campaign_id", input.campaignId);
  if (error) return { error: "Could not clear the summary." };

  revalidatePath(`/leads/${input.leadId}`);
  return { error: null };
}
```

NOTE: the service-role client bypasses RLS; `assertLeadAccess` is the real
protection. `lead_campaign_summaries` keeps SELECT-only RLS (Task 1) so the lead
page can READ these rows with the typed client, while all WRITES flow through
these gated actions — the same convention used for `hot_lead_dismissals` and
`handoffLeadToClose`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "src/lib/leads/lead-actions.ts"` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/leads/lead-actions.ts
git commit -m "feat(leads): per-campaign summary edit/clear actions + name-scrub"
```

---

## Task 6: Lead page — per-campaign summary section (display + edit/clear)

**Files:** Create `src/app/(app)/leads/[id]/campaign-summaries.tsx`; Modify `src/app/(app)/leads/[id]/page.tsx`, `src/app/(app)/leads/[id]/lead-page-client.tsx`

Context: the lead page (`page.tsx`) builds `meta` (incl. `aiSummary: lead.ai_summary`) and renders `<LeadPageClient>`. `lead-detail-parts.tsx` renders the "AI summary" card from `meta.aiSummary`. We ADD a per-campaign section; leave the existing `meta.aiSummary` card as-is (it now shows the "latest" — fine).

- [ ] **Step 1: Fetch per-campaign summaries in `page.tsx`**

In the page's `Promise.all` fan-out, add a query for the lead's per-campaign summaries with the campaign name:

```ts
    supabase
      .from("lead_campaign_summaries")
      .select("campaign_id, ai_summary, updated_at, campaign:campaigns(name)")
      .eq("lead_id", id)
      .order("updated_at", { ascending: false }),
```

Destructure it as `{ data: campaignSummaryRows }`, map to a plain array:

```ts
const campaignSummaries = (campaignSummaryRows ?? []).map((r) => ({
  campaignId: r.campaign_id as string,
  campaignName:
    (r.campaign as { name: string | null } | null)?.name ?? "Campaign",
  summary: (r.ai_summary as string | null) ?? "",
}));
```

Pass `campaignSummaries={campaignSummaries}` and `isAdmin={isAdmin}` (already passed) to `<LeadPageClient>`.

- [ ] **Step 2: Create the client component**

Create `src/app/(app)/leads/[id]/campaign-summaries.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  clearLeadCampaignSummary,
  updateLeadCampaignSummary,
} from "@/lib/leads/lead-actions";

export type CampaignSummary = {
  campaignId: string;
  campaignName: string;
  summary: string;
};

/** Per-campaign rolling summaries — the memory each campaign's next call sees.
 *  Admins can edit or clear one (clear = fresh start next call). */
export function CampaignSummaries({
  leadId,
  summaries,
  isAdmin,
}: {
  leadId: string;
  summaries: CampaignSummary[];
  isAdmin: boolean;
}) {
  if (summaries.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No campaign summaries yet — they build up as this lead is called.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {summaries.map((s) => (
        <SummaryCard
          key={s.campaignId}
          leadId={leadId}
          summary={s}
          isAdmin={isAdmin}
        />
      ))}
    </div>
  );
}

function SummaryCard({
  leadId,
  summary,
  isAdmin,
}: {
  leadId: string;
  summary: CampaignSummary;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.summary);
  const [pending, startTransition] = useTransition();

  function save() {
    startTransition(async () => {
      const res = await updateLeadCampaignSummary({
        leadId,
        campaignId: summary.campaignId,
        summary: draft,
      });
      if (res.error) return toast.error(res.error);
      toast.success("Summary updated.");
      setEditing(false);
      router.refresh();
    });
  }

  function clear() {
    if (!confirm("Clear this campaign's summary? The next call starts fresh."))
      return;
    startTransition(async () => {
      const res = await clearLeadCampaignSummary({
        leadId,
        campaignId: summary.campaignId,
      });
      if (res.error) return toast.error(res.error);
      toast.success("Summary cleared.");
      router.refresh();
    });
  }

  return (
    <div className="border-border/60 rounded-lg border p-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-foreground text-xs font-semibold">
          {summary.campaignName}
        </span>
        {isAdmin && !editing ? (
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={pending}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={pending}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
          />
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              Save
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraft(summary.summary);
                setEditing(false);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-foreground text-sm whitespace-pre-line">
          {summary.summary || "—"}
        </p>
      )}
    </div>
  );
}
```

(Confirm `@/components/ui/textarea` exists; if not, use a styled `<textarea className="border-border rounded-md border p-2 text-sm" />`.)

- [ ] **Step 3: Render it in `lead-page-client.tsx`**

Import it and add the prop:

```tsx
import { CampaignSummaries, type CampaignSummary } from "./campaign-summaries";
```

Add `campaignSummaries: CampaignSummary[];` to the props type and `campaignSummaries,` to the destructure. In the RIGHT column, near the existing AI-summary card (find where `meta.aiSummary` renders), add a section:

```tsx
<section className="border-border bg-card flex flex-col gap-3 rounded-2xl border p-4 shadow-sm">
  <h2 className="text-foreground text-sm font-semibold">Campaign summaries</h2>
  <CampaignSummaries
    leadId={leadId}
    summaries={campaignSummaries}
    isAdmin={isAdmin}
  />
</section>
```

- [ ] **Step 4: Verify (full)**

Run: `npx tsc --noEmit` → baseline only. `npx eslint` on the 3 files → clean. `npm run build` → succeeds.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/leads/[id]/campaign-summaries.tsx" "src/app/(app)/leads/[id]/page.tsx" "src/app/(app)/leads/[id]/lead-page-client.tsx"
git commit -m "feat(leads): per-campaign summaries section with edit/clear"
```

---

## Task 7: Tests

**Files:** Create `tests/per-campaign-summary.spec.ts`

- [ ] **Step 1: Write the contract (live-env)**

```ts
import { test, expect } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { mergeLeadSummary } from "../src/lib/openai/summary-merger";

test.describe.configure({ mode: "serial" });

/** The rolling summary is scoped per (lead, campaign): a merge under campaign A
 *  must not touch campaign B's row, and it copies into leads.ai_summary. */
test.describe("per-campaign summary", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
  let leadId: string;
  let campA: string;
  let campB: string;

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
    const mkCamp = async (n: string) => {
      const { data } = await admin
        .from("campaigns")
        .insert({
          owner_id: ownerId,
          name: `E2E ${n} ${stamp}`,
          status: "active",
        })
        .select("id")
        .single();
      return data!.id as string;
    };
    campA = await mkCamp("A");
    campB = await mkCamp("B");
    const { data: lead } = await admin
      .from("leads")
      .insert({ owner_id: ownerId, company: `E2E PCS ${stamp}` })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("lead_campaign_summaries")
      .delete()
      .eq("lead_id", leadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
    await admin
      .from("campaigns")
      .delete()
      .in("id", [campA ?? "", campB ?? ""]);
  });

  test("merge writes the campaign's row (mock) and not the other", async () => {
    await mergeLeadSummary({
      leadId,
      campaignId: campA,
      latestSummary:
        "Reached front desk; owner never in; manager Jane handles leads.",
    });
    const { data: a } = await admin
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", leadId)
      .eq("campaign_id", campA)
      .maybeSingle();
    const { data: b } = await admin
      .from("lead_campaign_summaries")
      .select("ai_summary")
      .eq("lead_id", leadId)
      .eq("campaign_id", campB)
      .maybeSingle();
    expect(a?.ai_summary ?? "").not.toEqual("");
    expect(b).toBeNull();
    const { data: leadRow } = await admin
      .from("leads")
      .select("ai_summary")
      .eq("id", leadId)
      .maybeSingle();
    expect(leadRow?.ai_summary ?? "").not.toEqual(""); // dual-write
  });
});
```

(Relative import of `mergeLeadSummary`; runs against the live env like the other specs. In mock mode — no OPENAI_LIVE — the merge uses `mockMerge`, so no external call.)

- [ ] **Step 2: Verify + commit**

Run: `npx tsc --noEmit` → baseline only. `npx eslint "tests/per-campaign-summary.spec.ts"` → clean.

```bash
git add tests/per-campaign-summary.spec.ts
git commit -m "test(summary): per-campaign merge scoping"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean except the 3 baseline `twilio-*.spec.ts` errors.
- [ ] `npx eslint` on all changed files — clean.
- [ ] `npm run build` — succeeds.
- [ ] Migration applied to prod (`supabase db push --linked`) BEFORE deploy; types regenerated.
- [ ] **Manual smoke:** call a lead under campaign A, then under campaign B — confirm the campaign B call's context does NOT contain campaign A's notes; confirm the lead page shows both campaigns' summaries with edit/clear; edit one and clear one and confirm the DB row changes; confirm the leads-list column + CSV still show a (latest) summary.
- [ ] Open a PR: branch `feat/per-campaign-summary` → title "Per-campaign call summaries (scoping + facts-only + manual edit)". Body: summaries scoped per campaign (no cross-campaign bleed), facts-only merge prompt, per-campaign edit/clear on the lead page; leads.ai_summary kept as the denormalized latest. Migration is additive + already applied.
