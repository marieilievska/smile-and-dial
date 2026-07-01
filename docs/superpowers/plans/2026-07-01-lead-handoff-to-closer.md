# Send a lead to a closer (push to Close) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only "Send to closer" button on the lead detail page that pushes the lead + a rich context note into the owner's connected Close CRM and logs the handoff.

**Architecture:** A server action (`handoffLeadToClose`) gathers the lead, its most useful call, and any booked appointment; finds/creates the lead in Close (reusing the existing Close client); posts one Note activity built by a pure `buildHandoffNote` helper; then records a `lead_handoff` row in `system_events`. The lead detail page renders the button (admin-only) and a "Handed off" badge read from that log. No lead status or dialer change. No DB migration.

**Tech Stack:** Next.js (App Router / RSC + server actions), Supabase (service-role writes), Close CRM REST API, Playwright (live-env tests).

**Spec:** `docs/superpowers/specs/2026-07-01-lead-handoff-to-closer-design.md`

**Branch:** `feat/lead-handoff-to-closer` (created; spec committed).

**Testing note:** No local unit runner — Playwright runs against the live env only. Verify each task with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build` on the final wiring task). Baseline: the 3 pre-existing `twilio-*.spec.ts` tsc errors are expected and unrelated. **No migration.**

---

## File structure

- **Modify** `src/lib/close/api.ts` — add `createCloseNote`; make `createCloseLead`'s `email` optional (so a lead with no email can still be created by company+phone).
- **Create** `src/lib/close/handoff.ts` — pure `buildHandoffNote(input)` (no `server-only` import, so it's unit-testable).
- **Modify** `src/lib/close/actions.ts` — add the `handoffLeadToClose` server action.
- **Create** `src/app/(app)/leads/[id]/send-to-closer.tsx` — the `SendToCloserButton` client component + "Handed off" badge.
- **Modify** `src/app/(app)/leads/[id]/page.tsx` — derive the latest handoff from the already-fetched `eventRows`; pass a `handoff` prop.
- **Modify** `src/app/(app)/leads/[id]/lead-page-client.tsx` — accept `handoff`; render the button admin-only; add a `lead_handoff` case to `describeFeedItem` label map (in `page.tsx`).
- **Create** `tests/lead-handoff.spec.ts` — note-builder assertions + not-connected UI contract + button visibility.

---

## Task 1: Close API — note activity + optional-email lead creation

**Files:** Modify `src/lib/close/api.ts`

- [ ] **Step 1: Add `createCloseNote`**

Append after `createCloseLead` (before `closeSenderEmail`):

```ts
/** Post a plain-text Note activity onto a Close lead (POST /activity/note/).
 *  Returns the new activity id, or null on failure so the caller can surface a
 *  clear error instead of logging a half-completed handoff. */
export async function createCloseNote(
  apiKey: string,
  input: { closeLeadId: string; note: string },
): Promise<{ id: string } | null> {
  const res = await fetch(`${BASE}/activity/note/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ lead_id: input.closeLeadId, note: input.note }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}
```

- [ ] **Step 2: Make `createCloseLead`'s email optional**

Replace the existing `createCloseLead` function body's signature + `body` construction so `email` is optional and the `emails` array is only included when present:

```ts
export async function createCloseLead(
  apiKey: string,
  input: {
    companyName: string | null;
    contactName: string | null;
    email?: string | null;
    phone?: string | null;
  },
): Promise<CloseLeadRef | null> {
  const email = input.email?.trim() || null;
  const body = {
    name: input.companyName || input.contactName || email || "New lead",
    contacts: [
      {
        name: input.contactName || input.companyName || undefined,
        ...(email ? { emails: [{ email, type: "office" }] } : {}),
        ...(input.phone
          ? { phones: [{ phone: input.phone, type: "office" }] }
          : {}),
      },
    ],
  };
  const res = await fetch(`${BASE}/lead/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    id: string;
    contacts?: { id: string }[];
  };
  return { leadId: json.id, contactId: json.contacts?.[0]?.id ?? null };
}
```

(The existing caller in `actions.ts` passes `email: toAddress` — still valid.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → clean except the 3 baseline `twilio-*.spec.ts` errors.
Run: `npx eslint "src/lib/close/api.ts"` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/close/api.ts
git commit -m "feat(close): add createCloseNote + allow email-less lead creation"
```

---

## Task 2: Pure handoff-note builder (TDD)

**Files:** Create `src/lib/close/handoff.ts`, Create `tests/lead-handoff.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lead-handoff.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

// Relative import (not the `@/` alias): keeps the pure helper resolvable under
// Playwright's loader, matching how the other specs import. buildHandoffNote has
// no server-only/Next imports, so pulling it into a test is safe.
import { buildHandoffNote } from "../src/lib/close/handoff";

test.describe("buildHandoffNote", () => {
  test("renders appointment (lead tz), summary, key answers, recording", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Aqua-Tots Lone Tree",
        ownerName: null,
        managerName: "Liam",
        employeeName: "Danica",
        businessPhone: "+13037311363",
        businessEmail: "info@aqua-tots.com",
        timezone: "America/Denver",
        city: "Lone Tree",
        state: "CO",
      },
      call: {
        summary: "Booked a demo with Liam.",
        disposition: "goal_met",
        leadResponseTime: "within 10 minutes",
        decisionMakerReached: "no",
        startedAt: "2026-06-30T22:00:37.910Z",
        recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C",
      },
      appointment: {
        scheduledAt: "2026-07-01T16:30:00.000Z", // 10:30 AM Mountain
        eventLink: null,
      },
      customFields: [{ label: "Current AI tools", value: "None" }],
    });

    expect(note).toContain("WHO TO MEET: Liam (Manager)");
    expect(note).toContain("Aqua-Tots Lone Tree");
    expect(note).toContain("10:30"); // appointment in Mountain time
    expect(note).toContain("America/Denver");
    expect(note).toContain("Booked a demo with Liam.");
    expect(note).toContain("Lead response time: within 10 minutes");
    expect(note).toContain("Decision-maker reached: no");
    expect(note).toContain("Current AI tools: None");
    expect(note).toContain(
      "RECORDING: https://elevenlabs.io/app/agents/agents/A/history/C",
    );
  });

  test("omits sections with no data", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Solo Co",
        ownerName: null,
        managerName: null,
        employeeName: null,
        businessPhone: null,
        businessEmail: null,
        timezone: null,
        city: null,
        state: null,
      },
      call: null,
      appointment: null,
      customFields: [],
    });
    expect(note).toContain("COMPANY: Solo Co");
    expect(note).not.toContain("BOOKED APPOINTMENT");
    expect(note).not.toContain("AI CALL SUMMARY");
    expect(note).not.toContain("KEY ANSWERS");
    expect(note).not.toContain("RECORDING");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test tests/lead-handoff.spec.ts -g "buildHandoffNote"`
Expected: FAIL — cannot resolve `@/lib/close/handoff` (module not created yet).
(Playwright runs against the live env; these two cases need no server, but if the runner can't start locally, at minimum `npx tsc --noEmit` will fail on the missing import — that failure counts as red.)

- [ ] **Step 3: Implement `buildHandoffNote`**

Create `src/lib/close/handoff.ts` (NOTE: do **not** add `import "server-only"` — this must stay importable by the test):

```ts
/**
 * Build the plain-text Note we post onto a Close lead when an operator hands the
 * lead to a closer. Pure + deterministic (no I/O, no `server-only`) so it can be
 * unit-tested. Lines with no data are omitted. Times render in the LEAD's
 * timezone so the closer reads the appointment the way the customer agreed to it.
 */
export type HandoffNoteInput = {
  lead: {
    company: string | null;
    ownerName: string | null;
    managerName: string | null;
    employeeName: string | null;
    businessPhone: string | null;
    businessEmail: string | null;
    timezone: string | null;
    city: string | null;
    state: string | null;
  };
  call: {
    summary: string | null;
    disposition: string | null;
    leadResponseTime: string | null;
    decisionMakerReached: string | null;
    startedAt: string | null;
    recordingUrl: string | null;
  } | null;
  appointment: { scheduledAt: string | null; eventLink: string | null } | null;
  customFields: { label: string; value: string }[];
};

function fmtInZone(iso: string, tz: string | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz || "America/New_York",
  });
}

export function buildHandoffNote(input: HandoffNoteInput): string {
  const { lead, call, appointment, customFields } = input;
  const lines: string[] = ["Handed off from Smile & Dial.", ""];

  const who = lead.ownerName
    ? `${lead.ownerName} (Owner)`
    : lead.managerName
      ? `${lead.managerName} (Manager)`
      : lead.employeeName
        ? `${lead.employeeName} (Contact)`
        : null;
  if (who) lines.push(`WHO TO MEET: ${who}`);

  const place = [lead.city, lead.state].filter(Boolean).join(", ");
  lines.push(`COMPANY: ${lead.company ?? "—"}${place ? ` · ${place}` : ""}`);

  const contactBits = [
    lead.businessPhone ? `PHONE: ${lead.businessPhone}` : null,
    lead.businessEmail ? `EMAIL: ${lead.businessEmail}` : null,
  ].filter(Boolean);
  if (contactBits.length) lines.push(contactBits.join("   "));

  if (appointment?.scheduledAt) {
    const tz = lead.timezone || "America/New_York";
    const when = fmtInZone(appointment.scheduledAt, lead.timezone);
    const link = appointment.eventLink
      ? `   [Calendly: ${appointment.eventLink}]`
      : "";
    lines.push("", `BOOKED APPOINTMENT: ${when} (${tz})${link}`);
  }

  if (call?.summary) {
    const on = call.startedAt
      ? ` (${fmtInZone(call.startedAt, lead.timezone)})`
      : "";
    lines.push("", `AI CALL SUMMARY${on}:`, call.summary);
  }

  const answers: string[] = [];
  if (call?.leadResponseTime)
    answers.push(`• Lead response time: ${call.leadResponseTime}`);
  if (call?.decisionMakerReached)
    answers.push(`• Decision-maker reached: ${call.decisionMakerReached}`);
  for (const cf of customFields) answers.push(`• ${cf.label}: ${cf.value}`);
  if (answers.length) lines.push("", "KEY ANSWERS:", ...answers);

  if (call?.recordingUrl) lines.push("", `RECORDING: ${call.recordingUrl}`);

  return lines.join("\n");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx playwright test tests/lead-handoff.spec.ts -g "buildHandoffNote"` (live env) — both cases PASS.
Local fallback: `npx tsc --noEmit` clean (import resolves) + eyeball the two assertions against the code.

- [ ] **Step 5: Commit**

```bash
git add src/lib/close/handoff.ts tests/lead-handoff.spec.ts
git commit -m "feat(close): pure buildHandoffNote helper + tests"
```

---

## Task 3: `handoffLeadToClose` server action

**Files:** Modify `src/lib/close/actions.ts`

- [ ] **Step 1: Extend the imports**

At the top import block from `./api`, add `createCloseNote`:

```ts
import {
  closeSenderEmail,
  createCloseLead,
  createCloseNote,
  findCloseLeadByEmail,
  sendCloseEmail,
} from "./api";
```

Add these imports below the existing ones:

```ts
import { buildHandoffNote } from "./handoff";
```

- [ ] **Step 2: Append the action** (end of file)

```ts
const EL_HISTORY_BASE = "https://elevenlabs.io/app/agents/agents";

/** Push a lead to the closer's Close CRM: find/create the Close lead + contact,
 *  attach a rich handoff note, and log the handoff. Admin-only. Does NOT change
 *  the lead's status or dialer eligibility. Re-runnable (a fresh note each time;
 *  the Close lead is deduped by email). */
export async function handoffLeadToClose(
  leadId: string,
): Promise<{ error: string | null; closeLeadId?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You are not signed in." };

  const { data: me } = await supabase
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .single();
  if (me?.role !== "admin") return { error: "Admins only." };

  const admin = makeServiceClient();

  // Lead.
  const { data: lead } = await admin
    .from("leads")
    .select(
      "id, owner_id, company, owner_name, manager_name, employee_name, " +
        "business_phone, business_email, timezone, city, state",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (!lead) return { error: "Lead not found." };

  // Owner's Close key.
  const { data: integ } = await admin
    .from("user_integrations")
    .select("close_api_key")
    .eq("user_id", lead.owner_id)
    .maybeSingle();
  const closeKey = integ?.close_api_key?.trim() || null;
  if (!closeKey) {
    return { error: "Connect Close in Settings → Integrations first." };
  }

  // Packaged call: most recent WITH a summary, else most recent.
  const { data: callRows } = await admin
    .from("calls")
    .select(
      "id, summary, extracted_data, started_at, elevenlabs_conversation_id, " +
        "agent:agents(elevenlabs_agent_id)",
    )
    .eq("lead_id", leadId)
    .order("started_at", { ascending: false })
    .limit(20);
  const calls = (callRows ?? []) as unknown as {
    id: string;
    summary: string | null;
    extracted_data: Record<string, unknown> | null;
    started_at: string | null;
    elevenlabs_conversation_id: string | null;
    agent: { elevenlabs_agent_id: string | null } | null;
  }[];
  const packaged = calls.find((c) => c.summary) ?? calls[0] ?? null;

  // Appointment: earliest upcoming, else most recent.
  const nowIso = new Date().toISOString();
  const { data: upcoming } = await admin
    .from("calendly_events")
    .select("scheduled_at, event_uri")
    .eq("lead_id", leadId)
    .eq("status", "scheduled")
    .gte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let appt = upcoming ?? null;
  if (!appt) {
    const { data: recent } = await admin
      .from("calendly_events")
      .select("scheduled_at, event_uri")
      .eq("lead_id", leadId)
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    appt = recent ?? null;
  }

  // Custom field values → {label, value}[].
  const [{ data: cvRows }, { data: defs }] = await Promise.all([
    admin
      .from("lead_custom_values")
      .select("custom_field_id, value")
      .eq("lead_id", leadId),
    admin.from("custom_field_defs").select("id, name"),
  ]);
  const defName = new Map((defs ?? []).map((d) => [d.id, d.name] as const));
  const customFields = (cvRows ?? [])
    .map((v) => ({
      label: defName.get(v.custom_field_id) ?? "",
      value: v.value == null ? "" : String(v.value),
    }))
    .filter((f) => f.label && f.value.trim().length > 0);

  const extracted = packaged?.extracted_data ?? {};
  const recordingUrl =
    packaged?.elevenlabs_conversation_id && packaged.agent?.elevenlabs_agent_id
      ? `${EL_HISTORY_BASE}/${packaged.agent.elevenlabs_agent_id}/history/${packaged.elevenlabs_conversation_id}`
      : null;

  const note = buildHandoffNote({
    lead: {
      company: lead.company,
      ownerName: lead.owner_name,
      managerName: lead.manager_name,
      employeeName: lead.employee_name,
      businessPhone: lead.business_phone,
      businessEmail: lead.business_email,
      timezone: lead.timezone,
      city: lead.city,
      state: lead.state,
    },
    call: packaged
      ? {
          summary: packaged.summary,
          disposition:
            typeof extracted.disposition === "string"
              ? extracted.disposition
              : null,
          leadResponseTime:
            typeof extracted.lead_response_time === "string"
              ? extracted.lead_response_time
              : null,
          decisionMakerReached:
            typeof extracted.decision_maker_reached === "string"
              ? extracted.decision_maker_reached
              : null,
          startedAt: packaged.started_at,
          recordingUrl,
        }
      : null,
    appointment: appt
      ? { scheduledAt: appt.scheduled_at, eventLink: null }
      : null,
    customFields,
  });

  // Find/create the Close lead, then attach the note.
  const contactName =
    lead.owner_name || lead.manager_name || lead.employee_name || null;
  const email = lead.business_email?.trim() || null;
  let ref = email ? await findCloseLeadByEmail(closeKey, email) : null;
  if (!ref) {
    ref = await createCloseLead(closeKey, {
      companyName: lead.company,
      contactName,
      email,
      phone: lead.business_phone,
    });
  }
  if (!ref) return { error: "Could not create the lead in Close." };

  const posted = await createCloseNote(closeKey, {
    closeLeadId: ref.leadId,
    note,
  });
  if (!posted) return { error: "Could not post the handoff note to Close." };

  await admin.from("system_events").insert({
    kind: "lead_handoff",
    actor_user_id: user.id,
    ref_table: "leads",
    ref_id: leadId,
    payload: {
      close_lead_id: ref.leadId,
      note_id: posted.id,
      packaged_call_id: packaged?.id ?? null,
      by_name: me?.full_name ?? null,
      at: new Date().toISOString(),
    },
  });

  revalidatePath("/leads/[id]", "page");
  return { error: null, closeLeadId: ref.leadId };
}
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` → clean (baseline twilio excepted).
Run: `npx eslint "src/lib/close/actions.ts"` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/close/actions.ts
git commit -m "feat(close): handoffLeadToClose server action"
```

---

## Task 4: `SendToCloserButton` client component

**Files:** Create `src/app/(app)/leads/[id]/send-to-closer.tsx`

- [ ] **Step 1: Write the component**

```tsx
"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { handoffLeadToClose } from "@/lib/close/actions";
import { exactDateTime, relativeTime } from "@/lib/relative-time";

export type HandoffInfo = { at: string; byName: string | null } | null;

/** Admin-only "Send to closer" action on the lead detail page: pushes the lead
 *  + a context note into the owner's Close CRM. Shows when it was last handed
 *  off (from the lead_handoff audit event). Re-clicking re-sends a fresh note. */
export function SendToCloserButton({
  leadId,
  handoff,
}: {
  leadId: string;
  handoff: HandoffInfo;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    const confirmMsg = handoff
      ? "This lead was already handed off. Re-send an updated note to Close?"
      : "Send this lead to the closer in Close?";
    if (!window.confirm(confirmMsg)) return;
    startTransition(async () => {
      const res = await handoffLeadToClose(leadId);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Sent to closer in Close.");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onClick}
        disabled={pending}
      >
        <Send className="size-4" />
        {pending ? "Sending…" : "Send to closer"}
      </Button>
      {handoff ? (
        <span
          className="text-muted-foreground text-xs"
          title={exactDateTime(handoff.at)}
        >
          Handed off {relativeTime(handoff.at)}
          {handoff.byName ? ` by ${handoff.byName}` : ""}
        </span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → clean.
Run: `npx eslint "src/app/(app)/leads/[id]/send-to-closer.tsx"` → clean.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/leads/[id]/send-to-closer.tsx"
git commit -m "feat(leads): SendToCloserButton component"
```

---

## Task 5: Wire the button + badge into the lead page

**Files:** Modify `src/app/(app)/leads/[id]/page.tsx`, `src/app/(app)/leads/[id]/lead-page-client.tsx`

- [ ] **Step 1: Derive the handoff from the already-fetched events (`page.tsx`)**

The page already fetches `eventRows` (system_events for this lead, newest-first). After the `feedItems` are built (right before the `return`), add:

```tsx
const lastHandoffEvent = (eventRows ?? []).find(
  (e) => e.kind === "lead_handoff",
);
const handoff = lastHandoffEvent
  ? {
      at: lastHandoffEvent.created_at,
      byName:
        ((lastHandoffEvent.payload as Record<string, unknown> | null)
          ?.by_name as string | null) ?? null,
    }
  : null;
```

- [ ] **Step 2: Pass `handoff` to the client (`page.tsx`)**

In the `<LeadPageClient … />` JSX, add the prop:

```tsx
isAdmin = { isAdmin };
callbacks = { callbacks };
handoff = { handoff };
```

- [ ] **Step 3: Add a friendly feed label (`page.tsx`)**

In `describeFeedItem`'s `switch (item.eventKind)`, add a case above `default`:

```tsx
    case "lead_handoff":
      return "Handed off to closer";
```

- [ ] **Step 4: Accept `handoff` + render the button (`lead-page-client.tsx`)**

Add the import near the other local imports:

```tsx
import { SendToCloserButton, type HandoffInfo } from "./send-to-closer";
```

In the `LeadPageClient({ … })` destructure add `handoff,`; in its prop type add:

```tsx
handoff: HandoffInfo;
```

Find where `<LeadHeroActions … />` is rendered and render the button immediately after it, admin-gated:

```tsx
{
  isAdmin ? <SendToCloserButton leadId={leadId} handoff={handoff} /> : null;
}
```

(If `<LeadHeroActions>` is wrapped in an admin check already, place `SendToCloserButton` inside that same block. It sits in the hero action row alongside Mark DNC / Delete.)

- [ ] **Step 5: Verify (full)**

Run: `npx tsc --noEmit` → clean (baseline twilio excepted).
Run: `npx eslint "src/app/(app)/leads/[id]/page.tsx" "src/app/(app)/leads/[id]/lead-page-client.tsx"` → clean.
Run: `npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/leads/[id]/page.tsx" "src/app/(app)/leads/[id]/lead-page-client.tsx"
git commit -m "feat(leads): render Send to closer + handoff badge on lead detail"
```

---

## Task 6: Playwright contract — not-connected path + button visibility

**Files:** Modify `tests/lead-handoff.spec.ts` (extend the file from Task 2)

- [ ] **Step 1: Add the UI contract cases**

Append to `tests/lead-handoff.spec.ts` (reuses the seeding style of `tests/connected-filter-transcript.spec.ts` — service client + `E2E_TEST_EMAIL`, which is an admin owner):

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

test.describe("Send to closer (UI)", () => {
  const stamp = Date.now();
  let admin: SupabaseClient;
  let ownerId: string;
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
    // Ensure the owner has NO Close key so we exercise the friendly error.
    await admin
      .from("user_integrations")
      .update({ close_api_key: null })
      .eq("user_id", ownerId);
    const { data: lead } = await admin
      .from("leads")
      .insert({
        owner_id: ownerId,
        company: `E2E Handoff ${stamp}`,
        business_phone: `+1555${String(stamp).slice(-7)}`,
        status: "goal_met",
      })
      .select("id")
      .single();
    leadId = lead!.id;
  });

  test.afterAll(async () => {
    await admin
      .from("system_events")
      .delete()
      .eq("ref_id", leadId ?? "");
    await admin
      .from("leads")
      .delete()
      .eq("id", leadId ?? "");
  });

  test("admin sees the button; not-connected shows the connect error and logs nothing", async ({
    page,
  }) => {
    await page.goto(`/leads/${leadId}`);
    const button = page.getByRole("button", { name: /send to closer/i });
    await expect(button).toBeVisible();

    page.on("dialog", (d) => d.accept()); // confirm()
    await button.click();
    await expect(page.getByText(/connect close in settings/i)).toBeVisible();

    const { count } = await admin
      .from("system_events")
      .select("id", { count: "exact", head: true })
      .eq("ref_id", leadId)
      .eq("kind", "lead_handoff");
    expect(count ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` → clean (baseline twilio excepted).
Run: `npx eslint "tests/lead-handoff.spec.ts"` → clean.
(The spec runs against the live env when validated there; do not expect it to run in CI.)

- [ ] **Step 3: Commit**

```bash
git add tests/lead-handoff.spec.ts
git commit -m "test(leads): handoff not-connected path + button visibility"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean except the 3 baseline `twilio-*.spec.ts` errors.
- [ ] `npx eslint` on all created/modified files — clean.
- [ ] `npm run build` — succeeds.
- [ ] Manual smoke (optional, needs a real connected Close key): open a `goal_met` lead as admin → **Send to closer** → confirm a Close lead + Note appear, a toast shows success, and the "Handed off …" badge renders. Re-click → a second note; no duplicate Close lead.
- [ ] Open a PR: branch `feat/lead-handoff-to-closer` → title "Send a lead to a closer (push to Close)". Body summarizes the trigger (manual button), the payload (find/create Close lead + handoff note), and log-only behavior. No migration.
