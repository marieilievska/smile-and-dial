# Assign a Close task to the appointment's closer on handoff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing "Send to closer" handoff so it also creates a Close **Task** — assigned to the appointment's host (resolved via the Calendly event, matched to a Close user) — that lands in that closer's Close Inbox.

**Architecture:** Add a Calendly helper to read a scheduled event's host email, three Close helpers (find user by email, get the key's own user, create a task), and a pure task-text builder. Wire them into `handoffLeadToClose` after the note posts: resolve the host email → match a Close user (fallback to the account owner, then unassigned) → create a task due today → record its id in the audit log.

**Tech Stack:** Next.js server action, Supabase (service-role), Close CRM REST API, Calendly REST API, Playwright (live-env tests).

**Spec:** `docs/superpowers/specs/2026-07-01-handoff-close-task-design.md`

**Branch:** `feat/handoff-close-task` (created; spec committed).

**Testing note:** No local unit runner — Playwright runs against the live env only. Verify each task with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build` on the final task). Baseline: the 3 pre-existing `twilio-*.spec.ts` tsc errors are expected. **No migration.** The Close `assigned_to`/`date` fields and Calendly `event_memberships[].user_email` field are standard but should be confirmed in a live smoke test.

---

## File structure

- **Modify** `src/lib/calendly/api.ts` — add `getScheduledEventHostEmail`.
- **Modify** `src/lib/close/api.ts` — add `findCloseUserByEmail`, `getCloseMe`, `createCloseTask`.
- **Modify** `src/lib/close/handoff.ts` — add pure `buildHandoffTaskText` (reuses the existing private `fmtInZone`).
- **Modify** `src/lib/close/actions.ts` — in `handoffLeadToClose`: read the owner's Calendly token, resolve host → assignee, create the task, add its id to the audit payload.
- **Modify** `tests/lead-handoff.spec.ts` — add a `buildHandoffTaskText` unit describe.

---

## Task 1: Calendly API — resolve a scheduled event's host email

**Files:** Modify `src/lib/calendly/api.ts`

Context: the file has `const CAL_API = "https://api.calendly.com"`, a private `authHeaders(token)` returning `{ Authorization: \`Bearer ${token}\`, "Content-Type": "application/json" }`, and existing exports (`getIdentity`, `createInvitee`, `cancelScheduledEvent`, …). The scheduled-event URI we store on `calendly_events.event_uri`is a full URL like`https://api.calendly.com/scheduled_events/{uuid}` — GET it directly.

- [ ] **Step 1: Add the helper**

Append after `cancelScheduledEvent` (near the end of the file):

```ts
type ScheduledEventResponse = {
  resource?: {
    event_memberships?: { user?: string; user_email?: string }[];
  };
};

/**
 * Resolve the HOST of a scheduled Calendly event — the rep who ran the booking —
 * by email, so a handoff task can be assigned to the right closer. `eventUri` is
 * the full scheduled-event URI stored on `calendly_events.event_uri`
 * (…/scheduled_events/{uuid}); we GET it and read
 * `event_memberships[0].user_email`. Best-effort: returns null on any failure or
 * missing field so the caller can fall back to another assignee.
 */
export async function getScheduledEventHostEmail(
  eventUri: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(eventUri, { headers: authHeaders(token) });
    if (!res.ok) return null;
    const data = (await res.json()) as ScheduledEventResponse;
    const email = data.resource?.event_memberships?.[0]?.user_email;
    return email && email.trim() ? email.trim() : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Verify**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit` → clean except the 3 baseline `twilio-*.spec.ts` errors.
Run: `npx eslint "src/lib/calendly/api.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/calendly/api.ts
git commit -m "feat(calendly): resolve a scheduled event's host email"
```

---

## Task 2: Close API — user lookup, current user, task creation

**Files:** Modify `src/lib/close/api.ts`

Context: the file has `const BASE = "https://api.close.com/api/v1"` and a private `authHeader(apiKey)` returning the Basic-auth header string. Existing exports include `findCloseLeadByEmail`, `createCloseLead`, `createCloseNote`. Add three new exports following the same defensive style (null on failure, typed `as` casts).

- [ ] **Step 1: Add the three helpers**

Append at the end of `src/lib/close/api.ts`:

```ts
/** Find a Close USER by email — used to assign a task to the appointment's host.
 *  GET /user/ lists the org's users; match by email case-insensitively. Returns
 *  the user id, or null when there is no match / the request fails. */
export async function findCloseUserByEmail(
  apiKey: string,
  email: string,
): Promise<{ id: string } | null> {
  const res = await fetch(`${BASE}/user/`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { id: string; email?: string }[];
  };
  const lower = email.trim().toLowerCase();
  const user = (json.data ?? []).find((u) => u.email?.toLowerCase() === lower);
  return user ? { id: user.id } : null;
}

/** The Close user that owns this API key (GET /me/) — the fallback task assignee.
 *  Returns the user id, or null on failure. */
export async function getCloseMe(
  apiKey: string,
): Promise<{ id: string } | null> {
  const res = await fetch(`${BASE}/me/`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}

/** Create a Task on a Close lead (POST /task/), which appears in the assignee's
 *  Inbox. `assignedTo` (a Close user id) omitted → unassigned. `dueDate` is a
 *  YYYY-MM-DD string. Returns the task id, or null on failure. */
export async function createCloseTask(
  apiKey: string,
  input: {
    closeLeadId: string;
    text: string;
    assignedTo?: string | null;
    dueDate: string;
  },
): Promise<{ id: string } | null> {
  const body: Record<string, unknown> = {
    lead_id: input.closeLeadId,
    text: input.text,
    date: input.dueDate,
    is_complete: false,
  };
  if (input.assignedTo) body.assigned_to = input.assignedTo;
  const res = await fetch(`${BASE}/task/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id?: string };
  return json.id ? { id: json.id } : null;
}
```

- [ ] **Step 2: Verify**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit` → clean except the 3 baseline errors.
Run: `npx eslint "src/lib/close/api.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/close/api.ts
git commit -m "feat(close): user lookup + createCloseTask helpers"
```

---

## Task 3: Pure task-text builder (TDD)

**Files:** Modify `src/lib/close/handoff.ts`, Modify `tests/lead-handoff.spec.ts`

Context: `handoff.ts` already has a private `fmtInZone(iso, tz)` (formats a time in the lead's timezone with a malformed-tz fallback) and exports `buildHandoffNote`. Add `buildHandoffTaskText` in the same file so it can reuse `fmtInZone`. The test file already does `import { buildHandoffNote } from "../src/lib/close/handoff";`.

- [ ] **Step 1: Write the failing test**

In `tests/lead-handoff.spec.ts`, change the handoff import line to also import the new function:

```ts
import {
  buildHandoffNote,
  buildHandoffTaskText,
} from "../src/lib/close/handoff";
```

Then append this describe block after the existing `buildHandoffNote` describe block (keep everything else):

```ts
test.describe("buildHandoffTaskText", () => {
  test("includes company, appt time in lead tz, and contact", () => {
    const text = buildHandoffTaskText({
      company: "Aqua-Tots Lone Tree",
      ownerName: null,
      managerName: "Liam",
      employeeName: null,
      businessPhone: "+13037311363",
      businessEmail: "info@aqua-tots.com",
      timezone: "America/Denver",
      appointmentAt: "2026-07-01T16:30:00.000Z", // 10:30 AM Mountain
    });
    expect(text).toContain("Aqua-Tots Lone Tree");
    expect(text).toContain("10:30");
    expect(text).toContain("America/Denver");
    expect(text).toContain("Liam");
    expect(text).toContain("info@aqua-tots.com");
    expect(text).toContain("handoff note");
  });

  test("degrades gracefully with no appointment", () => {
    const text = buildHandoffTaskText({
      company: "Solo Co",
      ownerName: null,
      managerName: null,
      employeeName: null,
      businessPhone: null,
      businessEmail: null,
      timezone: null,
      appointmentAt: null,
    });
    expect(text).toContain("Solo Co");
    expect(text).not.toContain("—"); // the em-dash only appears with an appt time
    expect(text).toContain("handoff note");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit 2>&1 | grep -i "buildHandoffTaskText\|handoff"` → expect an error that `buildHandoffTaskText` is not exported (the function doesn't exist yet). That is the red state. (Playwright needs the live env; the tsc missing-export error is the reliable red signal.)

- [ ] **Step 3: Implement `buildHandoffTaskText`**

In `src/lib/close/handoff.ts`, append after `buildHandoffNote`:

```ts
export type HandoffTaskInput = {
  company: string | null;
  ownerName: string | null;
  managerName: string | null;
  employeeName: string | null;
  businessPhone: string | null;
  businessEmail: string | null;
  timezone: string | null;
  appointmentAt: string | null;
};

/** The text of the Close Task the closer sees in their Inbox. Pure; reuses
 *  `fmtInZone` so the appointment time renders in the LEAD's timezone. Contact /
 *  appointment fragments are omitted when their data is absent. */
export function buildHandoffTaskText(input: HandoffTaskInput): string {
  const who =
    input.ownerName || input.managerName || input.employeeName || null;
  const when = input.appointmentAt
    ? `${fmtInZone(input.appointmentAt, input.timezone)} (${input.timezone || "America/New_York"})`
    : null;
  const contactBits = [who, input.businessPhone, input.businessEmail].filter(
    Boolean,
  );
  const parts: string[] = [
    `Run the booked demo with ${input.company ?? "this lead"}${when ? ` — ${when}` : ""}.`,
  ];
  if (contactBits.length) parts.push(`Contact: ${contactBits.join(" · ")}.`);
  parts.push("Full context is in the handoff note.");
  return parts.join(" ");
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit` → clean except the 3 baseline errors (the `buildHandoffTaskText` export error is gone).
Run: `npx eslint "src/lib/close/handoff.ts" "tests/lead-handoff.spec.ts"` → clean.
Trace the assertions against the code: `fmtInZone("2026-07-01T16:30:00.000Z", "America/Denver")` → "…10:30 AM" (contains "10:30"); the no-appointment case produces `"Run the booked demo with Solo Co. Full context is in the handoff note."` (no "—"). Both hold.

- [ ] **Step 5: Commit**

```bash
git add src/lib/close/handoff.ts tests/lead-handoff.spec.ts
git commit -m "feat(close): buildHandoffTaskText helper + tests"
```

---

## Task 4: Wire the task into `handoffLeadToClose`

**Files:** Modify `src/lib/close/actions.ts`

Context: `handoffLeadToClose` currently (see lines ~254–459): auth + admin gate → load `lead` → read `integ` (`user_integrations.close_api_key`) into `closeKey` → package call → resolve `appt` (`{ scheduled_at, event_uri }`) → build custom fields → `buildHandoffNote` → find/create Close lead (`ref`) → `createCloseNote` (`posted`) → best-effort `system_events` insert (`lead_handoff`) → `revalidatePath` → return. The service client (`admin`) is untyped, so `appt.event_uri` / `appt.scheduled_at` are loosely typed (no cast needed — the existing code already reads `appt.scheduled_at`).

- [ ] **Step 1: Extend the imports**

Change the `./api` import block to add the three new helpers (keep the existing names; alphabetical):

```ts
import {
  closeSenderEmail,
  createCloseLead,
  createCloseNote,
  createCloseTask,
  findCloseLeadByEmail,
  findCloseUserByEmail,
  getCloseMe,
  sendCloseEmail,
} from "./api";
```

Change the `./handoff` import to also import the task-text builder:

```ts
import { buildHandoffNote, buildHandoffTaskText } from "./handoff";
```

Add this import near the other `@/lib` imports at the top of the file:

```ts
import { getScheduledEventHostEmail } from "@/lib/calendly/api";
```

- [ ] **Step 2: Read the owner's Calendly token alongside the Close key**

Change the `integ` query to select both keys, and derive the Calendly token:

```ts
const { data: integ } = await admin
  .from("user_integrations")
  .select("close_api_key, calendly_api_key")
  .eq("user_id", lead.owner_id)
  .maybeSingle();
const closeKey = integ?.close_api_key?.trim() || null;
const calendlyToken = integ?.calendly_api_key?.trim() || null;
if (!closeKey) {
  return { error: "Connect Close in Settings → Integrations first." };
}
```

- [ ] **Step 3: Create the assigned task after the note posts**

Immediately after the note-post guard:

```ts
const posted = await createCloseNote(closeKey, {
  closeLeadId: ref.leadId,
  note,
});
if (!posted) return { error: "Could not post the handoff note to Close." };
```

…and BEFORE the `// Best-effort audit log.` block, insert:

```ts
// Also create a Close TASK assigned to the appointment's closer, so it lands
// in that person's Close Inbox. Assignee = the Calendly event's host (matched
// to a Close user by email); falls back to the account owner (/me), then
// unassigned. Best-effort: a failed task never fails the handoff.
const hostEmail =
  appt?.event_uri && calendlyToken
    ? await getScheduledEventHostEmail(appt.event_uri, calendlyToken)
    : null;
const assignee =
  (hostEmail ? await findCloseUserByEmail(closeKey, hostEmail) : null) ??
  (await getCloseMe(closeKey));
const taskText = buildHandoffTaskText({
  company: lead.company,
  ownerName: lead.owner_name,
  managerName: lead.manager_name,
  employeeName: lead.employee_name,
  businessPhone: lead.business_phone,
  businessEmail: lead.business_email,
  timezone: lead.timezone,
  appointmentAt: appt?.scheduled_at ?? null,
});
const task = await createCloseTask(closeKey, {
  closeLeadId: ref.leadId,
  text: taskText,
  assignedTo: assignee?.id ?? null,
  dueDate: new Date().toISOString().slice(0, 10),
});
if (!task) {
  console.error("lead_handoff task creation failed", { leadId });
}
```

- [ ] **Step 4: Record the task in the audit payload**

In the `system_events` insert `payload`, add two fields (after `by_name`):

```ts
    payload: {
      close_lead_id: ref.leadId,
      note_id: posted.id,
      packaged_call_id: packaged?.id ?? null,
      by_name: me?.full_name ?? null,
      task_id: task?.id ?? null,
      task_assigned_to: assignee?.id ?? null,
      at: new Date().toISOString(),
    },
```

- [ ] **Step 5: Verify (full)**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit` → clean except the 3 baseline errors.
Run: `npx eslint "src/lib/close/actions.ts"` → clean.
Run: `npm run build` → succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/lib/close/actions.ts
git commit -m "feat(close): create an assigned Close task on handoff"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean except the 3 baseline `twilio-*.spec.ts` errors.
- [ ] `npx eslint` on all modified files — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Manual smoke (needs a real connected Close + Calendly key):** hand off a lead that has a booked appointment. Confirm in Close: a Task appears on the lead, assigned to the host (or the account owner as fallback), due today, with text naming the company + appointment time; and it shows in that user's Inbox. This also validates the exact Close (`assigned_to`/`date`) and Calendly (`event_memberships[].user_email`) field names — if a field name differs, fix the corresponding helper (Task 1 or Task 2) and re-verify.
- [ ] Open a PR: branch `feat/handoff-close-task` → title "Assign a Close task to the appointment's closer on handoff". Body: the handoff now also creates an assigned Close task (inbox item) for the appointment's host; fallback to account owner then unassigned; due today; best-effort; no migration.
