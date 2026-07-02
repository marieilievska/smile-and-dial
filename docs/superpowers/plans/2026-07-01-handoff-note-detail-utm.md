# Handoff note detail + UTM attribution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the handoff note show a per-call CALL HISTORY (all calls) with no duplicated key answer, and stamp each handed-off Close lead with UTM attribution custom fields.

**Architecture:** Change `buildHandoffNote` to take a `calls[]` array + top-level key answers and render a CALL HISTORY. Add two Close API helpers (ensure lead custom-field defs; set lead custom-field values). Rework `handoffLeadToClose` to gather all calls, dedup custom fields by slug, and — best-effort — stamp the Close lead with `utm_source`/`utm_medium`/`utm_campaign`.

**Tech Stack:** Next.js server action, Supabase (service-role), Close CRM REST API, Playwright (live-env tests).

**Spec:** `docs/superpowers/specs/2026-07-01-handoff-note-detail-utm-design.md`

**Branch:** `feat/handoff-note-detail-utm` (created; spec committed).

**Testing note:** No local unit runner — Playwright runs against the live env only. Verify each task with `npx tsc --noEmit` + `npx eslint <files>` (+ `npm run build` on the final task). Baseline: the 3 pre-existing `twilio-*.spec.ts` tsc errors are expected. **No migration.** The Close custom-field endpoints (`/custom_field/lead/`, `PUT /lead/{id}/` with `custom.<id>` keys) are standard but should be confirmed in a live smoke test.

---

## File structure

- **Modify** `src/lib/close/handoff.ts` — new `HandoffNoteInput` shape (`calls[]` + `leadResponseTime`/`decisionMakerReached`); render CALL HISTORY.
- **Modify** `tests/lead-handoff.spec.ts` — update the `buildHandoffNote` describe to the new shape (two-call history + single key-answer).
- **Modify** `src/lib/close/api.ts` — add `ensureCloseLeadCustomFields`, `setCloseLeadCustomFields`.
- **Modify** `src/lib/close/actions.ts` — in `handoffLeadToClose`: gather all calls, dedup custom fields, derive key answers + campaign name, call the new `buildHandoffNote`, and stamp UTM (best-effort).

---

## Task 1: `buildHandoffNote` — per-call history + top-level key answers (TDD)

**Files:** Modify `src/lib/close/handoff.ts`, Modify `tests/lead-handoff.spec.ts`

Context: `handoff.ts` has a private `fmtInZone(iso, tz)` (formats a time in the lead's timezone, malformed-tz safe) and exports `buildHandoffNote`/`HandoffNoteInput` + `buildHandoffTaskText`/`HandoffTaskInput`. The current `HandoffNoteInput` has a single `call` field and a `customFields` list; KEY ANSWERS pushes `call.leadResponseTime`, `call.decisionMakerReached`, then every custom field. Leave `buildHandoffTaskText` and its describe block untouched.

- [ ] **Step 1: Rewrite the `buildHandoffNote` tests to the new shape**

In `tests/lead-handoff.spec.ts`, REPLACE the entire existing `test.describe("buildHandoffNote", …)` block (keep the `buildHandoffTaskText` and `Send to closer (UI)` blocks) with:

```ts
test.describe("buildHandoffNote", () => {
  test("renders a per-call history, appointment (lead tz), single key answer", () => {
    const note = buildHandoffNote({
      lead: {
        company: "Aqua-Tots Myers Park",
        ownerName: null,
        managerName: "Jessica",
        employeeName: null,
        businessPhone: "+17045858155",
        businessEmail: "myersparkgm@aqua-tots.com",
        timezone: "America/New_York",
        city: "Charlotte",
        state: "NC",
      },
      calls: [
        {
          startedAt: "2026-06-30T13:45:57.940Z", // 9:45 AM ET
          outcome: "callback",
          summary: "First call — reached Clover, got response time.",
          recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C1",
        },
        {
          startedAt: "2026-06-30T16:30:00.000Z", // 12:30 PM ET
          outcome: "goal_met",
          summary: "Booked a demo for 3 PM.",
          recordingUrl: "https://elevenlabs.io/app/agents/agents/A/history/C2",
        },
      ],
      leadResponseTime: "within a couple hours",
      decisionMakerReached: "unknown",
      appointment: { scheduledAt: "2026-06-30T19:00:00.000Z", eventLink: null }, // 3 PM ET
      customFields: [{ label: "Current ai tools", value: "None" }],
    });

    expect(note).toContain("CALL HISTORY (2 calls)");
    expect(note).toContain("First call — reached Clover, got response time.");
    expect(note).toContain("Booked a demo for 3 PM.");
    expect(note).toContain("9:45"); // first call, ET
    expect(note).toContain("12:30"); // second call, ET
    expect(note).toContain("goal met"); // outcome underscores → spaces
    expect(note).toContain("history/C1");
    expect(note).toContain("history/C2");
    expect(note).toContain("3:00 PM"); // appointment, ET
    // Lead response time appears exactly once (the caller dedups custom fields).
    expect(note.match(/Lead response time/g)?.length).toBe(1);
    expect(note).toContain("Current ai tools: None");
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
      calls: [],
      leadResponseTime: null,
      decisionMakerReached: null,
      appointment: null,
      customFields: [],
    });
    expect(note).toContain("COMPANY: Solo Co");
    expect(note).not.toContain("CALL HISTORY");
    expect(note).not.toContain("BOOKED APPOINTMENT");
    expect(note).not.toContain("KEY ANSWERS");
  });

  test("a malformed timezone does not throw (falls back)", () => {
    expect(() =>
      buildHandoffNote({
        lead: {
          company: "Bad TZ Co",
          ownerName: null,
          managerName: null,
          employeeName: null,
          businessPhone: null,
          businessEmail: null,
          timezone: "America/Denverrr",
          city: null,
          state: null,
        },
        calls: [],
        leadResponseTime: null,
        decisionMakerReached: null,
        appointment: {
          scheduledAt: "2026-07-01T16:30:00.000Z",
          eventLink: null,
        },
        customFields: [],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit 2>&1 | grep -i "handoff\|calls\|leadResponseTime"` → expect type errors (the tests pass `calls`/`leadResponseTime`/`decisionMakerReached`, which don't exist on the current `HandoffNoteInput`). That's the red state.

- [ ] **Step 3: Update `HandoffNoteInput` + `buildHandoffNote`**

In `src/lib/close/handoff.ts`, replace the `HandoffNoteInput` type and the `buildHandoffNote` function with:

```ts
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
  calls: {
    startedAt: string | null;
    outcome: string | null;
    summary: string | null;
    recordingUrl: string | null;
  }[];
  leadResponseTime: string | null;
  decisionMakerReached: string | null;
  appointment: { scheduledAt: string | null; eventLink: string | null } | null;
  customFields: { label: string; value: string }[];
};

export function buildHandoffNote(input: HandoffNoteInput): string {
  const {
    lead,
    calls,
    leadResponseTime,
    decisionMakerReached,
    appointment,
    customFields,
  } = input;
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

  // CALL HISTORY — one entry per call (the caller passes them oldest→newest).
  const history = calls.filter((c) => c.summary || c.outcome);
  if (history.length) {
    lines.push(
      "",
      `CALL HISTORY (${history.length} call${history.length === 1 ? "" : "s"}):`,
    );
    for (const c of history) {
      const when = c.startedAt ? fmtInZone(c.startedAt, lead.timezone) : "—";
      const outcome = c.outcome ? c.outcome.replace(/_/g, " ") : "—";
      lines.push(`— ${when} · ${outcome}`);
      if (c.summary) lines.push(`  ${c.summary}`);
      if (c.recordingUrl) lines.push(`  Recording: ${c.recordingUrl}`);
    }
  }

  const answers: string[] = [];
  if (leadResponseTime)
    answers.push(`• Lead response time: ${leadResponseTime}`);
  if (decisionMakerReached)
    answers.push(`• Decision-maker reached: ${decisionMakerReached}`);
  for (const cf of customFields) answers.push(`• ${cf.label}: ${cf.value}`);
  if (answers.length) lines.push("", "KEY ANSWERS:", ...answers);

  return lines.join("\n");
}
```

(The old single-call `AI CALL SUMMARY` + bottom `RECORDING` lines are removed — recordings now render inline per call. The unused `disposition` field is dropped.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc --noEmit` → clean except the 3 baseline errors. The `handoff`/`calls` type errors are gone.
Run: `npx eslint "src/lib/close/handoff.ts" "tests/lead-handoff.spec.ts"` → clean.
Trace: `fmtInZone("2026-06-30T13:45:57.940Z","America/New_York")` → "…9:45 AM"; `16:30Z` → "12:30 PM"; `19:00Z` → "3:00 PM". `"goal_met".replace(/_/g," ")` → "goal met". `Lead response time` appears once (only the top-level `leadResponseTime`; the custom field is "Current ai tools").

- [ ] **Step 5: Commit**

```bash
git add src/lib/close/handoff.ts tests/lead-handoff.spec.ts
git commit -m "feat(close): per-call CALL HISTORY in the handoff note"
```

---

## Task 2: Close API — lead custom-field helpers

**Files:** Modify `src/lib/close/api.ts`

Context: the file has `const BASE = "https://api.close.com/api/v1"` and a private `authHeader(apiKey)`. Existing exports include `createCloseLead`, `createCloseNote`, `findCloseUserByEmail`, `createCloseTask`. Add two exports in the same defensive style.

- [ ] **Step 1: Add the two helpers**

Append at the end of `src/lib/close/api.ts`:

```ts
/** Ensure the org has lead custom-field definitions for `names` — GET the lead
 *  custom fields, create any missing ones (type "text"). Returns a name→field-id
 *  map. Best-effort: silently omits any it couldn't list or create. Used to stamp
 *  UTM attribution onto a handed-off lead. */
export async function ensureCloseLeadCustomFields(
  apiKey: string,
  names: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const res = await fetch(`${BASE}/custom_field/lead/?_limit=200`, {
    headers: { Authorization: authHeader(apiKey) },
  });
  const existing = res.ok
    ? (((await res.json()) as { data?: { id: string; name?: string }[] })
        .data ?? [])
    : [];
  const byName = new Map(
    existing.map((f) => [(f.name ?? "").toLowerCase(), f.id] as const),
  );
  for (const name of names) {
    const found = byName.get(name.toLowerCase());
    if (found) {
      out[name] = found;
      continue;
    }
    const cr = await fetch(`${BASE}/custom_field/lead/`, {
      method: "POST",
      headers: {
        Authorization: authHeader(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, type: "text" }),
    });
    if (cr.ok) {
      const j = (await cr.json()) as { id?: string };
      if (j.id) out[name] = j.id;
    }
  }
  return out;
}

/** Set lead custom-field values on a Close lead — PUT /lead/{id}/ with
 *  `custom.<field_id>` keys. Returns true on success. */
export async function setCloseLeadCustomFields(
  apiKey: string,
  closeLeadId: string,
  values: { fieldId: string; value: string }[],
): Promise<boolean> {
  if (values.length === 0) return true;
  const body: Record<string, unknown> = {};
  for (const v of values) body[`custom.${v.fieldId}`] = v.value;
  const res = await fetch(`${BASE}/lead/${closeLeadId}/`, {
    method: "PUT",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}
```

- [ ] **Step 2: Verify**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit` → clean except the 3 baseline errors.
Run: `npx eslint "src/lib/close/api.ts"` → clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/close/api.ts
git commit -m "feat(close): ensure/set lead custom fields (for UTM)"
```

---

## Task 3: Wire it into `handoffLeadToClose` (all calls + dedup + UTM) + build

**Files:** Modify `src/lib/close/actions.ts`

Context: read `handoffLeadToClose`. It selects `callRows` (`id, summary, extracted_data, started_at, elevenlabs_conversation_id, agent:agents(elevenlabs_agent_id)`, desc, limit 20) → cast `calls` → picks `packaged`. Builds `customFields` from `lead_custom_values` + `custom_field_defs.select("id, name")`. Computes `extracted` + `recordingUrl` from `packaged`, then calls `buildHandoffNote({ …, call: packaged ? {…} : null, …, customFields })`. Then finds/creates the Close lead (`ref`), posts the note (`posted`), runs the best-effort task block, then the audit log. `const EL_HISTORY_BASE = "https://elevenlabs.io/app/agents/agents";` already exists in the file.

- [ ] **Step 1: Extend the `./api` import**

Add `ensureCloseLeadCustomFields` and `setCloseLeadCustomFields` to the existing `./api` import block (keep the others; alphabetical):

```ts
import {
  closeSenderEmail,
  createCloseLead,
  createCloseNote,
  createCloseTask,
  ensureCloseLeadCustomFields,
  findCloseLeadByEmail,
  findCloseUserByEmail,
  getCloseMe,
  sendCloseEmail,
  setCloseLeadCustomFields,
} from "./api";
```

- [ ] **Step 2: Gather all calls (with outcome + campaign) and derive the pieces**

Replace the call query + `calls` cast + `packaged` line (the block from `// Packaged call:` through `const packaged = …`) with:

```ts
// All calls for the lead (newest first), with outcome + campaign for the note.
const { data: callRows } = await admin
  .from("calls")
  .select(
    "id, summary, extracted_data, started_at, outcome, " +
      "elevenlabs_conversation_id, agent:agents(elevenlabs_agent_id), " +
      "campaign:campaigns(name)",
  )
  .eq("lead_id", leadId)
  .order("started_at", { ascending: false })
  .limit(20);
const calls = (callRows ?? []) as unknown as {
  id: string;
  summary: string | null;
  extracted_data: Record<string, unknown> | null;
  started_at: string | null;
  outcome: string | null;
  elevenlabs_conversation_id: string | null;
  agent: { elevenlabs_agent_id: string | null } | null;
  campaign: { name: string | null } | null;
}[];
// Key answers come from the most recent call that captured extracted data.
const primary =
  calls.find(
    (c) => c.extracted_data && Object.keys(c.extracted_data).length > 0,
  ) ??
  calls[0] ??
  null;
const utmCampaign = calls[0]?.campaign?.name ?? null;
```

- [ ] **Step 3: Dedup the custom fields by slug**

Replace the custom-fields block (`const [{ data: cvRows }, { data: defs }] = …` through the `customFields` assignment) with (adds `slug` to the defs select and drops reserved slugs):

```ts
// Custom field values → {label, value}[], excluding any that duplicate a
// hardcoded key answer (they'd otherwise show twice).
const RESERVED_CF_SLUGS = new Set([
  "lead_response_time",
  "decision_maker_reached",
]);
const [{ data: cvRows }, { data: defs }] = await Promise.all([
  admin
    .from("lead_custom_values")
    .select("custom_field_id, value")
    .eq("lead_id", leadId),
  admin.from("custom_field_defs").select("id, name, slug"),
]);
const defById = new Map((defs ?? []).map((d) => [d.id, d] as const));
const customFields = (cvRows ?? [])
  .map((v) => {
    const d = defById.get(v.custom_field_id);
    return {
      slug: d?.slug ?? "",
      label: d?.name ?? "",
      value: v.value == null ? "" : String(v.value),
    };
  })
  .filter(
    (f) =>
      f.label && f.value.trim().length > 0 && !RESERVED_CF_SLUGS.has(f.slug),
  )
  .map((f) => ({ label: f.label, value: f.value }));
```

- [ ] **Step 4: Build the note from all calls + top-level key answers**

Replace the `const extracted = …`, `const recordingUrl = …`, and the whole `const note = buildHandoffNote({ … })` call (through its closing `});`) with:

```ts
const pex = primary?.extracted_data ?? {};
const callsForNote = [...calls].reverse().map((c) => ({
  startedAt: c.started_at,
  outcome: c.outcome,
  summary: c.summary,
  recordingUrl:
    c.elevenlabs_conversation_id && c.agent?.elevenlabs_agent_id
      ? `${EL_HISTORY_BASE}/${c.agent.elevenlabs_agent_id}/history/${c.elevenlabs_conversation_id}`
      : null,
}));

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
  calls: callsForNote,
  leadResponseTime:
    typeof pex.lead_response_time === "string" ? pex.lead_response_time : null,
  decisionMakerReached:
    typeof pex.decision_maker_reached === "string"
      ? pex.decision_maker_reached
      : null,
  appointment: appt
    ? // eventLink is null on purpose: calendly_events only stores the API
      // event URI (api.calendly.com/scheduled_events/…), not a human-openable
      // link, so the note shows the time only.
      { scheduledAt: appt.scheduled_at, eventLink: null }
    : null,
  customFields,
});
```

- [ ] **Step 5: Stamp UTM attribution on the Close lead (best-effort)**

Immediately AFTER the best-effort task block (the `} catch (err) { … }` that ends the task block) and BEFORE the `// Best-effort audit log.` block, insert:

```ts
// UTM attribution on the Close lead so the sales team can see these came from
// the AI calling. Best-effort — a Close custom-field hiccup never fails the
// handoff (the note already posted).
try {
  const ids = await ensureCloseLeadCustomFields(closeKey, [
    "utm_source",
    "utm_medium",
    "utm_campaign",
  ]);
  const utm: Record<string, string> = {
    utm_source: "smile-and-dial",
    utm_medium: "ai_call",
    utm_campaign: utmCampaign ?? "",
  };
  const utmValues = Object.entries(utm)
    .filter(([name]) => ids[name])
    .map(([name, value]) => ({ fieldId: ids[name], value }));
  if (utmValues.length) {
    await setCloseLeadCustomFields(closeKey, ref.leadId, utmValues);
  }
} catch (err) {
  console.error("lead_handoff utm block failed", {
    leadId,
    message: err instanceof Error ? err.message : String(err),
  });
}
```

- [ ] **Step 5b: Fix the audit-payload reference (packaged → primary)**

The old code removed the `packaged` variable (Step 2 replaced it with `primary`), but the audit-log `payload` still references it. In the `system_events` insert payload, change:

```ts
      packaged_call_id: packaged?.id ?? null,
```

to:

```ts
      packaged_call_id: primary?.id ?? null,
```

(This is the ONLY remaining reference to the old `packaged` variable — after this change, `packaged` no longer exists anywhere. If `npx tsc` still reports `packaged` as undefined, search for any other stray reference and repoint it to `primary`.)

- [ ] **Step 6: Verify (full)**

Run: `cd "C:/Users/Marija/Documents/smile-and-dial-finalVersion" && npx tsc --noEmit` → clean except the 3 baseline errors. (The untyped service client keeps `c.outcome` / `c.campaign` / `pex.*` loosely typed — no cast issues. If a NEW error appears, report it rather than forcing a cast.)
Run: `npx eslint "src/lib/close/actions.ts"` → clean.
Run: `npm run build` → succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/lib/close/actions.ts
git commit -m "feat(close): all-call handoff note, slug dedup, UTM on the Close lead"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean except the 3 baseline `twilio-*.spec.ts` errors.
- [ ] `npx eslint` on all modified files — clean.
- [ ] `npm run build` — succeeds.
- [ ] **Manual smoke (needs a real connected Close key):** hand off a lead with 2+ calls. In Close, confirm: the note shows a **CALL HISTORY** with every call (date · outcome · summary · recording) and **no duplicated** "Lead response time"; and the Close lead has `utm_source = smile-and-dial`, `utm_medium = ai_call`, `utm_campaign = <campaign name>`. This also validates the Close custom-field endpoints (`/custom_field/lead/`, `PUT /lead/{id}/` with `custom.<id>`).
- [ ] Open a PR: branch `feat/handoff-note-detail-utm` → title "Handoff note: per-call history + UTM on the Close lead". Body: per-call CALL HISTORY (all calls), duplicate lead_response_time fixed, and UTM attribution custom fields on the Close lead (best-effort). No migration.
