# Reporting redesign — Phase 2: generalized sentiment + Voice of Customer

**Date:** 2026-06-26
**Status:** Design approved, pending spec review

Phase 2 of the Reporting redesign (Phase 1 = #228). Phase 3 (Hot Leads) deferred.

## Problem

Reporting's sentiment features are hardcoded to Market Research's `interest`
(yes/no/maybe) field. Other campaigns collect their own equivalents (e.g.
Conversion: `lead_source_satisfaction` happy/mixed/unhappy + `followup_process_detail`),
which never surface. Phase 2 makes the **Dashboard sentiment columns** and the
**Voice of Customer tab** work for any campaign by auto-detecting its fields, adds
**inline call-recording playback** (incl. the public share), and makes **lead
names clickable** on the admin view (not the public share).

## Key data facts (verified live, 2026-06-26)

- `agents.extra_data_collection` is empty for all agents — custom fields are
  defined in ElevenLabs but land in `calls.extracted_data`. So detection reads
  `extracted_data` keys, not the agent config.
- Per-campaign custom fields: **AI Market Research** = `ai_call_answering_interest`
  (yes/no/maybe) + `ai_call_answering_reason` (text); **Conversion Market
  Research** = `lead_source_satisfaction` (happy/mixed/unhappy) +
  `followup_process_detail` (text). `current_ai_tools` also appears (varied,
  not categorical) and is ignored by detection.
- ~93–100% of calls have `recording_path`. Signed URLs:
  `supabase.storage.from("call-recordings").createSignedUrl(path, 3600)`; legacy
  `http(s)` paths are used directly (see `src/lib/calls/actions.ts` getCallDetail).
- Lead route exists: `/leads/[id]`.

## Decisions (approved)

1. **Auto-detect** each campaign's sentiment + notes fields from its call data
   (no manual config, no override).
2. **Combined ("All campaigns") view hides** the sentiment columns AND the Voice
   of Customer tab. Both appear only when a single campaign with a detected
   sentiment field is selected — showing **that campaign's own labels**.
3. **Inline play button per row** for recordings; works on the public share via a
   token-checked signed-URL link.
4. **Clickable lead names** → `/leads/<id>` on admin; plain text on public share.
5. **Hot Leads tab stays as-is** (Market-Research-only, Phase 3 redesigns it) — so
   it does not show an empty tab for non-MR campaigns.
6. **The public share gets a read-only campaign picker.** Because Voice of
   Customer (and its recordings) only show for a single campaign, the share can no
   longer be a fixed combined view. It becomes scope-aware: a read-only picker lets
   a viewer choose All campaigns (Dashboard + Changelog + Prompt Log) or one
   campaign (its Dashboard sentiment + Voice of Customer + playable recordings).
   Lead names stay plain text on the share.

## Non-goals (Phase 3 / later)

- Hot Leads redesign (yes+maybe across campaigns, delete, list column, stripped
  columns, lead links).
- Per-campaign override of the auto-detected fields.
- Showing more than one categorical or one text field per campaign.

## Detection: `detectCampaignSentiment` + `detectCampaignNotes`

New helper in `src/lib/agent-analytics/field-detect.ts`:

```
type DetectedFields = {
  sentimentKey: string | null;   // extracted_data key, e.g. "ai_call_answering_interest"
  sentimentValues: string[];     // ordered distinct values, e.g. ["yes","maybe","no"]
  notesKey: string | null;       // e.g. "ai_call_answering_reason"
};
export async function detectCampaignFields(supabase, campaignId): Promise<DetectedFields>
```

Algorithm (sample: up to 1000 outbound calls for the campaign in the last 90
days, paginated once):

- **Custom keys** = union of `extracted_data` keys across the sample, minus the
  standard `DATA_COLLECTION_FIELDS` ids (disposition, decision_maker_reached,
  business_email, owner_name, manager_name, employee_name, callback_datetime).
- **sentimentKey** = the custom key whose distinct non-empty values (trimmed,
  lowercased) number **2–6**. Tie-break: most values recognized by the SENTIMENT
  lexicon, then fewest distinct, then alphabetical. `null` if none qualifies.
- **sentimentValues** = that key's distinct values, ordered by lexicon rank
  (positive → neutral → negative → unrecognized-alphabetical).
- **notesKey** = among remaining custom keys (excluding sentimentKey), the one
  with the longest average value length and avg length ≥ 20 chars. `null` if none.

**SENTIMENT lexicon** (lowercased) drives both ordering and Warm %:

- positive: yes, happy, good, great, interested, satisfied, positive
- neutral: maybe, mixed, neutral, unsure, somewhat
- negative: no, unhappy, bad, not_interested, dissatisfied, negative
- unrecognized values rank last and count as non-warm.

`Warm %` = (positive + neutral) / total answered.

This helper is computed **once per page render** when a single campaign is
selected, and passed to both the dashboard fetch and the Voice fetch.

## Components & changes

### Dashboard generalization

- `src/lib/agent-analytics/stats.ts`:
  - `DailyKpi` drops `interestYes/interestMaybe/interestNo` and gains
    `sentimentCounts: Record<string, number>` (keyed by lowercased value);
    `warmPct` stays.
  - `computeDailyKpis(rows, sentimentKey?)`: when `sentimentKey` is given, bucket
    each call's `extracted_data[sentimentKey]` (lowercased/trimmed) into
    `sentimentCounts` per day and compute `warmPct` via the lexicon; when omitted,
    `sentimentCounts = {}` and `warmPct = 0`.
- `src/lib/agent-analytics/report-data.ts`: `fetchDashboardKpis(supabase, scope,
sentimentKey?)` threads `sentimentKey` into `computeDailyKpis`.
- `src/app/(app)/reporting/dashboard-view.tsx`: accept `sentimentValues: string[]`
  (default `[]`). Render one numeric column per value (header = value, title-cased;
  cell = `k.sentimentCounts[value] ?? 0`) plus the **Warm %** column, only when
  `sentimentValues.length > 0`. Drop the old fixed Yes/Maybe/No code. The Warm %
  summary tile shows only when `sentimentValues.length > 0`. CSV columns follow the
  same dynamic set. (The `showSentiment` boolean is replaced by
  `sentimentValues.length > 0`.)
- `src/app/(app)/reporting/page.tsx`: when `scope.kind === "campaign"`, run
  `detectCampaignFields`; pass `sentimentKey` to `fetchDashboardKpis` and
  `sentimentValues` to `DashboardView`.

### Voice of Customer generalization

- `src/lib/agent-analytics/report-data.ts`:
  - `VoiceRow` becomes: `{ id, day, company, list, leadId, sentiment, notes,
recordingPath }` (replaces `interest/reason/theme/suggestedAction`).
  - `fetchVoiceRows(supabase, scope, detected)` filters the campaign's calls where
    `extracted_data[detected.sentimentKey]` is non-empty, ordered newest first;
    maps `sentiment = extracted_data[sentimentKey]` (lowercased), `notes =
extracted_data[notesKey]`, plus `leadId` and `recordingPath`.
- `src/app/(app)/reporting/voice-table.tsx`: columns **Day · Company · List ·
  Sentiment · Notes · Recording**. Sentiment pill colored by lexicon (positive
  green, neutral amber, negative rose, unrecognized neutral). The filter pills are
  built from the distinct sentiment values present. Company links to
  `/leads/<leadId>` unless `readOnly`. Recording = inline play button (below).
  **Remove** the Theme / Suggested-action editable cells and the
  `saveCallAnnotation` usage. Props gain `sentimentValues: string[]` and
  `recordingSrcFor: (callId: string) => string`.
- `src/app/(app)/reporting/page.tsx` / share page: render the Voice tab only when
  a single campaign has a detected sentiment field; pass `detected` +
  `recordingSrcFor`.

### Public share (now scope-aware)

- `src/app/share/reporting/[token]/page.tsx`: load campaigns (service client),
  parse `?scope=` (validate against the campaign list → else all), and — when a
  campaign is selected — run `detectCampaignFields` and render the same scoped
  Dashboard (with sentiment columns) + Voice of Customer (recordings via the token
  route, lead names as plain text) as the admin page. Combined view shows Dashboard
  - Changelog + Prompt Log only. Render a **read-only `ScopePicker`** whose links
    point at `/share/reporting/<token>`.
- `src/app/(app)/reporting/scope-picker.tsx`: add a `basePath: string` prop so the
  picker builds links for either surface (`/reporting` or
  `/share/reporting/<token>`); it preserves the existing query params and sets
  `scope`. Admin passes `basePath="/reporting"`; share passes
  `basePath={\`/share/reporting/${token}\`}`.

### Tab visibility

- `reporting-tabs.tsx` `reportingTabsFor` takes `{ showVoice, showHotLeads }`:
  - `showVoice = scope.kind === "campaign" && detected.sentimentKey !== null`.
  - `showHotLeads = scope.kind === "campaign" && (await hasInterestData(scope))`
    (unchanged MR-specific gate; Phase 3 generalizes).
  - Changelog + Prompt Log always shown.
- The `INTEREST_COMBINED_NOTE` is no longer needed (tabs are hidden in combined
  view); remove its usage. Keep `hasInterestData` (Hot Leads + Phase 3).

### Recording playback (lazy, public-safe)

- **Admin route:** `src/app/api/reporting/recording/[callId]/route.ts` — GET,
  admin-checked (same profile/role check pattern), looks up the call's
  `recording_path`, mints a signed URL (or uses the legacy http path), and 302
  redirects to it.
- **Public route:** `src/app/share/reporting/[token]/recording/[callId]/route.ts`
  — GET, validates the share token against `app_settings`, confirms the call
  exists, mints a signed URL with the service-role client, 302 redirects.
- `voice-table.tsx`: each row with a `recordingPath` shows a play button; clicking
  it renders `<audio controls preload="none" src={recordingSrcFor(row.id)} />`
  inline (lazy — the browser only fetches when played). Admin passes
  `recordingSrcFor = (id) => `/api/reporting/recording/${id}``; the share passes
  `(id) => `/share/reporting/${token}/recording/${id}``. Rows without a recording
  show "—".

### Lead linking

- `VoiceRow.leadId` (added above). In `voice-table.tsx`, the Company cell is a
  `next/link` to `/leads/${leadId}` when `!readOnly`; plain `<span>` when
  `readOnly`. (The lead route preserves its own context; a bare `/leads/<id>` is
  fine.)

## Error / edge handling

- Campaign with no detectable sentiment field → Voice tab hidden, dashboard shows
  no sentiment columns (just call-ops metrics). No error.
- Combined view → no detection runs; sentiment hidden everywhere; Voice/Hot Leads
  tabs hidden.
- Call with no `recording_path` → "—", no play button.
- Recording route: unknown call / bad token / missing object → 404.
- `sentimentValues` ordering is deterministic (lexicon then alphabetical) so the
  dashboard columns are stable across renders.

## Testing (Playwright, live env only)

Extend `tests/reporting-scope.spec.ts` (or a new `reporting-voice.spec.ts`):

- Seed a campaign whose calls carry a custom categorical field with 3 values +
  a long-text field + a `recording_path`.
- Selecting that campaign: the dashboard shows columns named after the 3 values;
  the Voice of Customer tab shows the sentiment pill + notes + a play button +
  a Company link to `/leads/<id>`.
- A campaign with no categorical field: no Voice tab, no dashboard sentiment cols.
- The recording route returns a redirect (3xx) for a seeded recording_path
  (assert status is 3xx/2xx, not 404). Public route requires the valid token.

## Verification gates (run locally)

`npx tsc --noEmit`, `npx eslint`, `npm run build` — clean on changed files (only
the 3 pre-existing `twilio-*.spec.ts` tsc errors). **No DB migration.**
