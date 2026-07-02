# Handoff note detail + UTM attribution on the Close lead — Design

**Date:** 2026-07-01
**Status:** Design approved, pending spec review

## Problem

Feedback on the live handoff note (#239/#240):

1. **`lead_response_time` shows up twice** in KEY ANSWERS. It's captured both as a hardcoded key answer (from the call's `extracted_data.lead_response_time`) AND as the "Lead response time" custom field we created (mirrored to `lead_custom_values`), so `buildHandoffNote` prints both.
2. **The summary is from one call only.** The note packages a single call (most recent with a summary), but a lead can have several calls — the closer should see them all.
3. **The note should be more detailed** — specifically, a **per-call breakdown** (each call's date, outcome, summary).
4. **UTM attribution is missing on the Close lead.** The team wants each handed-off Close lead stamped with UTM fields marking it as sourced from the AI calling.

## Decisions (approved)

1. **Dedup:** exclude any custom field whose slug collides with a hardcoded key answer (`lead_response_time`, `decision_maker_reached`) — so each shows once.
2. **Per-call breakdown:** the action fetches **all** the lead's calls; the note renders a chronological **CALL HISTORY** — each call: `{date} · {outcome}` → summary → recording link. This satisfies both "all-call summary" and "more detailed".
3. **Key answers** (lead response time, decision-maker reached) stay, pulled from the most informative call (the most recent call that has `extracted_data`).
4. **UTM on the Close lead (best-effort):** ensure the Close org has lead custom fields `utm_source` / `utm_medium` / `utm_campaign` (auto-create missing via the Close API), then set on the lead:
   - `utm_source` = `smile-and-dial`
   - `utm_medium` = `ai_call`
   - `utm_campaign` = the Smile & Dial campaign name the lead was called under (from the most recent call's campaign).
     A UTM failure never fails the handoff (wrapped like the task block).

## Non-goals (YAGNI)

- Populating UTM from Meta / real ad attribution (no such data on leads today; these are fixed attribution values).
- Per-call key-answers (lead response time etc. are shown once, from the best call).
- Changing the task text or the audit log shape.
- A DB migration.

## Reuse / current state

- `buildHandoffNote` (`src/lib/close/handoff.ts`) takes a single `call` and a `customFields` list; the KEY ANSWERS section pushes `leadResponseTime`, `decisionMakerReached`, then every custom field — the source of the duplicate.
- `handoffLeadToClose` (`src/lib/close/actions.ts`) already fetches up to 20 calls (`callRows`) and picks one `packaged` call; builds `customFields` from `lead_custom_values` + `custom_field_defs` (currently selects `id, name` — no slug); finds/creates the Close lead (`ref.leadId`).
- Close client (`src/lib/close/api.ts`): Basic auth; existing `createCloseLead`/`createCloseNote`/etc. Base `https://api.close.com/api/v1`.
- Close lead custom fields: defs live at `/custom_field/lead/` (`GET` lists `{ data: [{ id, name }] }`; `POST { name, type: "text" }` creates one → `{ id }`). Values are set on a lead via `PUT /lead/{id}` with keys `"custom.<field_id>": "<value>"`.

## Components & changes

### 1. `buildHandoffNote` — per-call history + dedup-safe key answers (`src/lib/close/handoff.ts`)

Change `HandoffNoteInput`:

- Replace the single `call: {...} | null` with:
  - `calls: { startedAt: string | null; outcome: string | null; summary: string | null; recordingUrl: string | null }[]` (chronological, oldest→newest).
  - `leadResponseTime: string | null` and `decisionMakerReached: string | null` at the top level (the key answers, from the primary call).
- Keep `lead`, `appointment`, `customFields` as-is.

Rendering:

- Replace the single "AI CALL SUMMARY" block with **`CALL HISTORY (N call[s]):`** followed by one entry per call:
  `— {fmtInZone(startedAt, tz)} · {outcome or "—"}` then the summary on the next line (indented), then `  Recording: {recordingUrl}` when present. Calls with neither a summary nor an outcome are skipped.
- KEY ANSWERS: push `leadResponseTime` / `decisionMakerReached` (unchanged), then the `customFields` (now pre-deduped by the caller). Omit the section when empty.

### 2. `handoffLeadToClose` — gather all calls, dedup customFields, resolve campaign (`src/lib/close/actions.ts`)

- **Call select:** add `outcome` and `campaign:campaigns(name)` to the existing `calls` query; keep `summary, extracted_data, started_at, elevenlabs_conversation_id, agent:agents(elevenlabs_agent_id)`.
- **`calls` array for the note:** map every call (ascending by `started_at`) → `{ startedAt, outcome, summary, recordingUrl }`, where `recordingUrl` is the EL history link built from that call's `elevenlabs_conversation_id` + its agent's `elevenlabs_agent_id` (or null).
- **Primary call for key answers:** the most recent call with non-empty `extracted_data` (fallback: most recent). Derive `leadResponseTime` / `decisionMakerReached` from its `extracted_data` (typeof-string guarded, as today).
- **Dedup customFields:** extend the `custom_field_defs` select to `id, name, slug`; when building `customFields`, drop any whose `slug` is in `{ "lead_response_time", "decision_maker_reached" }`.
- **UTM campaign name:** the most recent call's `campaign.name` (or null).

### 3. Close API — lead custom fields (`src/lib/close/api.ts`)

- `ensureCloseLeadCustomFields(apiKey, names: string[]): Promise<Record<string, string>>` — `GET /custom_field/lead/?_limit=200`, map existing name→id (case-insensitive); for each requested name not present, `POST /custom_field/lead/ { name, type: "text" }` and add its id. Returns the name→id map (best-effort: omits any it couldn't resolve/create).
- `setCloseLeadCustomFields(apiKey, closeLeadId, values: { fieldId: string; value: string }[]): Promise<boolean>` — `PUT /lead/{closeLeadId}` with a body of `{ ["custom." + fieldId]: value }`. Returns ok.

### 4. Wire UTM into `handoffLeadToClose` (best-effort)

After the Close lead is resolved (`ref.leadId`) and the note posts, in a `try/catch` (never fails the handoff):

```
const utm = {
  utm_source: "smile-and-dial",
  utm_medium: "ai_call",
  utm_campaign: <most-recent-call campaign name> ?? "",
};
const ids = await ensureCloseLeadCustomFields(closeKey, ["utm_source","utm_medium","utm_campaign"]);
const values = Object.entries(utm)
  .filter(([name]) => ids[name])
  .map(([name, value]) => ({ fieldId: ids[name], value }));
if (values.length) await setCloseLeadCustomFields(closeKey, ref.leadId, values);
```

`console.error` on any throw. (Placed near the existing task block; can share one try/catch or use its own.)

## Data flow

Handoff → find/create Close lead → **set UTM custom fields on it (best-effort)** → build note from **all calls** (deduped custom fields) → post note → create task → audit log → success.

## Error / edge handling

- Duplicate: removed by slug-based dedup.
- Lead with 0 calls → CALL HISTORY omitted (note still posts appointment + contact).
- Calls with no summary AND no outcome → skipped in the history.
- UTM: any Close custom-field list/create/set failure → `console.error`, handoff unaffected. `utm_campaign` empty when the lead has no calls (source/medium still set).
- Everything else (admin gate, not-connected, note failure, task best-effort) unchanged.

## Testing (Playwright live-env + unit)

- **Unit (`buildHandoffNote`):** update the existing test for the new `calls`/`leadResponseTime`/`decisionMakerReached` shape; add a case with **two calls** asserting both summaries + both dates appear under CALL HISTORY, and a case asserting a custom field with slug `lead_response_time` is NOT double-listed (the caller dedups, so the test passes pre-deduped input and asserts a single line — i.e. the note prints exactly what it's given; the dedup is covered at the action level, verified in the smoke test).
- `buildHandoffTaskText` tests unchanged.
- The Close custom-field calls are external → covered by the manual smoke test (confirm the Close lead shows utm_source/medium/campaign and the note shows all calls with no duplicate).

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean (only the 3 pre-existing `twilio-*.spec.ts` baseline errors). **No DB migration.**
