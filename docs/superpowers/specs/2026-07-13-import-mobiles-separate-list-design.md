# Import mobile numbers into a separate list (never auto-dialed)

- **Date:** 2026-07-13
- **Status:** Approved design, pending implementation plan
- **Author:** Marija (PM) + Claude

## Summary (plain English)

Today, when you import a CSV, every phone number is checked by Twilio Lookup.
Numbers that come back as **mobile** are dropped entirely — they never become
leads. That is the app's TCPA guardrail, because Smile & Dial auto-dials with an
AI voice and auto-dialing cell phones is the legally sensitive part.

This change lets you **keep** those mobiles by routing them into a **separate
lead list** of your choosing, instead of throwing them away. Crucially, the AI
will **never auto-dial** anything tagged as mobile — not via Autopilot, not via
the manual "Call Now" button. The separate list is for humans to call/text
manually or to export elsewhere.

The behavior is **opt-in**: a checkbox in the import wizard. When it's off,
imports behave exactly as they do today (mobiles dropped). Nothing changes for
existing leads or existing imports.

## Goal

Allow importing mobile numbers into a dedicated list while making it
structurally impossible for the system to auto-dial them.

## Current behavior (as-is)

- `src/lib/leads/twilio-lookup.ts` — `lookupLineType(phone)` classifies a number
  as `landline | mobile | voip | invalid | unknown`. Real lookups run only in
  live mode; otherwise a deterministic mock (`+1700…` → mobile, `+1999…` →
  invalid, else landline).
- `src/lib/leads/import-actions.ts`
  - `analyzeImport(...)` runs the lookup on every row, counts importable / mobile
    / invalid, and lists skipped rows for the downloadable error report. Mobiles
    get `reason: "Mobile number (TCPA compliance)"`.
  - `importLeads(...)` receives `rowLineTypes` and, in the row loop, **drops**
    mobiles (`skippedMobile++`) and invalids (`skippedInvalid++`). Everything
    else is inserted into the single `input.listId`.
  - Line type is computed at import time and **never stored** on the lead.
- `src/app/(app)/leads/import/import-wizard.tsx` — one destination list picker, a
  dedup mode, and a "Skip Twilio number verification" toggle. The review step
  shows "Mobile numbers (skipped)".
- **Dialer eligibility** lives in two DB objects (latest definitions in
  `supabase/migrations/20260705120000_weekend_callbacks.sql`):
  - View `public.dial_queue` — a lead is a candidate only if its list has an
    active campaign attached (or matches an audience search / smart list), it's
    not deleted, has a phone, status in (`ready_to_call`, `callback`), not on
    DNC, etc.
  - Function `public.pre_call_check(in_lead_id, in_campaign_id)` — the shared
    per-call safety gate. Returns a `text` reason (or `null` when safe). Used by
    **both** the Autopilot cron (`src/lib/dialer/tick.ts`) and the manual
    "Call Now" button (`src/lib/dialer/call-now.ts`). This is the single
    chokepoint through which every outbound dial passes.

## Desired behavior (to-be)

When the new "Also import mobile numbers into a separate list" checkbox is on and
a mobile list is chosen:

| Twilio Lookup result                          | Destination           |
| --------------------------------------------- | --------------------- |
| landline                                      | main list (unchanged) |
| voip                                          | main list (unchanged) |
| unknown (lookup failed / not run confidently) | main list (unchanged) |
| **mobile**                                    | **mobile list (new)** |
| invalid / disconnected                        | dropped (unchanged)   |

When the checkbox is off: mobiles are dropped exactly as today.

## Design decisions (with rationale)

1. **Opt-in checkbox, not always-on.** Backward-compatible; users who don't want
   mobiles keep today's behavior with zero new required inputs.
2. **Mutually exclusive with "Skip Twilio verification."** Skipping the lookup
   means we don't know which numbers are mobile, so there's nothing to split. The
   two controls disable each other in the UI.
3. **Unknowns go to the main list** (PM decision, 2026-07-13). Only numbers Twilio
   _positively confirms_ as mobile are split off — matches today's dial behavior
   for unknowns and avoids diverting real landlines into a no-call list.
4. **Store line type on the lead + hard lock in the shared gate.** Rather than
   relying on "don't attach a campaign to the mobile list" (a human can break
   that), we persist the line type and block mobiles in `pre_call_check`, which
   both dial paths share. Compliance is enforced by the database.
5. **Mobile list must differ from the main list**, or the split is meaningless.
   Enforced by wizard validation.
6. **No campaign-attach warning UI** (PM decision, 2026-07-13). The database lock
   is the sole guarantee — attaching a campaign to the mobile list simply has no
   effect on those leads — so a preventive warning isn't needed. Could be added
   later as polish if desired.

## Detailed changes

### 1. Database migration (new file under `supabase/migrations/`)

All three parts are backward-compatible: existing leads have `line_type = null`,
which reads as "not mobile" everywhere, so no existing lead's dialability
changes.

**a. New column**

```sql
alter table public.leads
  add column if not exists line_type text;

comment on column public.leads.line_type is
  'Twilio Lookup line-type classification captured at import '
  '(landline|mobile|voip|invalid|unknown). NULL for leads imported before this '
  'feature or with the lookup skipped. Leads tagged ''mobile'' are never '
  'auto-dialed (see pre_call_check + dial_queue).';
```

Optional hardening (nice-to-have, not required): a `check` constraint limiting
`line_type` to the known set.

**b. Block mobiles in the shared safety gate** — `create or replace function
public.pre_call_check(...)`, re-declared verbatim from the latest version
(`20260705120000`) with one added guard placed right after the DNC check
(it's the same category of rule — "who we must never call"):

```sql
  -- Never auto-dial a number classified as mobile. Smile & Dial uses an AI
  -- (artificial) voice; auto-dialing cell phones is TCPA-restricted, so mobiles
  -- imported for manual handling are hard-blocked here. NULL line_type (older
  -- leads, or lookup skipped) is NOT blocked — unchanged behavior.
  if v_lead.line_type = 'mobile' then
    return 'lead_is_mobile';
  end if;
```

`v_lead` is already `public.leads%rowtype`, so `v_lead.line_type` is available
once the column exists. This single change locks **both** Autopilot and Call Now.

**c. Keep mobiles out of the Autopilot queue (defense-in-depth)** —
`create or replace view public.dial_queue`, re-declared from the latest version
with one clause added to the inner `where`:

```sql
    and l.line_type is distinct from 'mobile'
```

`is distinct from` treats `null` as "not mobile", so untagged leads are
unaffected. This is secondary to `pre_call_check` (which is the airtight lock)
but avoids mobiles ever consuming candidate slots if a campaign is mistakenly
attached to the mobile list.

**d. Regenerate types** — `src/lib/supabase/database.types.ts` must be
regenerated so `leads` Row/Insert/Update include `line_type`.

### 2. Types — `src/lib/leads/import-fields.ts`

- `ImportResult`: add `mobileImported: number` (mobiles newly inserted/revived
  into the mobile list). `skippedMobile` remains for the split-off path (mobiles
  dropped when the checkbox is off).
- `analyzeImport` input gains `splitMobiles?: boolean`; `importLeads` input gains
  `mobileListId?: string`.

### 3. Import logic — `src/lib/leads/import-actions.ts`

- **`analyzeImport({ ..., splitMobiles })`**
  - When `splitMobiles` is true, do **not** push mobile rows into `skipped[]`
    (they're a destination, not an error). Keep counting them in `mobile`.
  - `countImportDuplicates(...)` stays **landline-only (unchanged)**. The "new
    leads" headline is `importable − duplicates`, and `importable` never includes
    mobiles, so counting mobile duplicates here would corrupt that math. Mobile
    de-duplication is handled at commit time in `importLeads` (its `seen` /
    `phoneToLead` logic already covers every row regardless of destination).
- **`importLeads({ ..., mobileListId })`**
  - Compute each row's target list: `const targetListId =
(lineType === 'mobile' && mobileListId) ? mobileListId : input.listId`.
    If `lineType === 'mobile'` and no `mobileListId`, keep dropping it
    (`skippedMobile++`) — preserves current behavior when split is off.
  - Validate `mobileListId` (when provided) is a real list the user owns, same as
    `input.listId`.
  - Stamp `line_type` from `rowLineTypes[index]`. On **insert**, always set it
    (`line_type: lineType ?? null`). On **update / revive**, set it only when the
    row's type is a positive classification (not `"unknown"`), so re-importing a
    known mobile with the lookup skipped can never silently **downgrade** a
    `'mobile'` stamp and unlock it. New leads carry `list_id: targetListId`.
  - Accounting: select `list_id` back from the insert upsert and count inserts
    per destination — landlines into `imported`, mobiles into `mobileImported`.
    Revived mobiles move into `mobileListId` (mirrors the existing revive-relist
    behavior) and count toward `mobileImported`. Updates refresh fields in place
    without moving lists (unchanged); a live main-list lead re-classified as
    mobile therefore stays put but gets stamped `'mobile'` and thus becomes
    non-dialable — an intended safety outcome.

### 4. Wizard — `src/app/(app)/leads/import/import-wizard.tsx`

- **Upload step:** new checkbox "Also import mobile numbers into a separate
  list." When checked, reveal a second list `<Select>` ("Put mobile numbers
  in…") reusing the existing list options + `CreateListInlineDialog`. Disable
  the checkbox when `skipLookup` is on (and disable `skipLookup` when the split
  is on). Validation: if split is on, require a mobile list, and it must differ
  from the main list; extend `canContinue` / `blockedReason` accordingly.
- Thread `splitMobiles` into `analyzeImport` and `mobileListId` into
  `importLeads`.
- **Review step:** when split is on, replace "Mobile numbers (skipped)" with
  "Mobile numbers → {mobileListName}" and exclude mobiles from the "Download
  skipped rows" report (invalids still listed).
- **Done step:** show both destinations, e.g. "120 leads into Main · 34 mobiles
  into Mobiles." Only the main list's active-campaign / Autopilot nudge applies;
  the mobile list intentionally has no campaign.

### 5. New pre-call reason (typing + friendly message)

- `src/lib/dialer/queue.ts` — add `"lead_is_mobile"` to the `PreCallReason`
  union so the cron's reason logging stays type-complete.
- `src/lib/dialer/call-now.ts` — add to `PRE_CALL_REASON_LABELS`:

```ts
lead_is_mobile:
  "This is a mobile number — Smile & Dial doesn't auto-dial cell phones.",
```

## What the lock does NOT cover (explicit limitations)

- **Only positively-confirmed mobiles** (`line_type = 'mobile'`) are blocked.
  Leads imported before this feature, or with the lookup skipped, have
  `line_type = null` and are unaffected — they already went through the old
  keep/drop logic at their import time. No retroactive re-classification.
- **The business number only.** A lead's separate "owner direct line"
  (`owner_phone`) was never lookup-classified, so an owner-line Call Now isn't
  covered by this lock — same as today. Out of scope.
- **VoIP is unchanged** — still treated as dialable and routed to the main list.
  Not part of this request.

## Compliance note (TCPA)

The whole point of the hard lock is to honor the reason mobiles are dropped
today: auto-dialing cell phones with an artificial/prerecorded voice is
restricted under the TCPA. This design lets the business _store_ mobiles for
lawful manual handling (or export) while guaranteeing the automated system never
places a call to them. It does not, by itself, authorize any later decision to
call those mobiles — that would be a separate change requiring a documented
lawful basis (e.g., prior express consent) and should go through the
legal-risk review.

## Migration & deploy safety

- Adding a nullable column and re-creating the view/function are all
  backward-compatible; existing code keeps working, and existing leads read as
  "not mobile."
- Follows the repo rule (never drop/rename a column before dependent code
  deploys): here we only **add**. The migration can be pushed with
  `supabase db push --linked` before or alongside the code deploy without risk.
- One PR: migration + regenerated types + import/wizard/call-now changes.

## Testing (Playwright contract)

Tests run against the live environment and can't be executed locally, but the
contract should be extended in `tests/import.spec.ts`:

- With the split enabled and a CSV containing a mock mobile (`+1700…`) and a
  landline, assert the landline lands in the main list and the mobile in the
  mobile list, and that the imported mobile lead carries `line_type = 'mobile'`.
- (If feasible in the harness) assert a mobile lead cannot be dialed via Call Now
  (expects the `lead_is_mobile` message).

## Local verification before "done"

Run and confirm clean on changed files: `npx tsc --noEmit`, `npx eslint`,
`npm run build`.

## Out of scope / future

- Showing a "Mobile" badge on the Leads page or lead detail (uses the new
  `line_type`) — nice follow-up, not built here.
- Any feature that would actually dial mobiles (SMS, manual-dial workflow) —
  separate spec + legal review.
