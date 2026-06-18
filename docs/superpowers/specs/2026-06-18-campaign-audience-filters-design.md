# Campaign audience filters (filter-based targeting)

**Date:** 2026-06-18
**Status:** Design — awaiting review
**Author:** Marija + Claude

## The problem (in plain English)

Lead lists can be attached to campaigns, and the dialer calls whoever is in those
lists. But a lead can only live in **one** list at a time, and phone numbers are
unique per account. So when you upload a second list that overlaps an earlier one
(e.g. a Mindbody export with 30 F45 locations, then a dedicated F45 list), the
import **skips** the 30 already-known F45 leads — it has nowhere to put them
without yanking them out of their original list. Attach the F45 list to a
campaign and those 30 leads never get called, even though they're F45 locations.

### Root cause (confirmed in code)

- `leads.list_id` is a single, mandatory foreign key — _"every lead belongs to
  exactly one list."_ There is no membership/join table.
  ([create_leads.sql](../../../supabase/migrations/20260521022121_create_leads.sql))
- A `unique (owner_id, business_phone)` constraint means a phone can exist only
  once per account, so the same business cannot be added to a second list.
- On import, dedup is **global per account**: existing phones are skipped (or
  updated in place, staying in their original list).
  ([import-actions.ts](../../../src/lib/leads/import-actions.ts))
- The dialer picks leads through the `dial_queue` SQL view, which joins
  `leads → list_campaign_attachments → campaigns` on `list_id`. A lead is only
  ever reachable through its single home list.
  ([dial_queue view](../../../supabase/migrations/20260617120000_callbacks_dial_when_autopilot_off.sql))

This is structural, not a tuning issue: with one-lead-one-list, the same business
_cannot_ be in two lists, so no amount of dedup-setting fixes it.

## The decision

Target campaigns by a **saved filter ("smart view")** instead of relying solely
on physical lists. Specifically, a campaign can call **every lead whose company
name contains a given text** (e.g. company contains "F45"). Because targeting no
longer depends on which file a lead came in on, dedup becomes harmless: the 30
F45 leads in the Mindbody list still match the F45 filter and get called.

Decisions locked in during brainstorming:

- **Direction:** filter-based targeting (chosen over making leads belong to
  multiple lists).
- **Segment basis:** company-name **text match** (uses existing data; no new tag
  or category field). Upgrade path to a dedicated segment field is noted below if
  text matching proves too loose.
- **Scope:** this **adds** filter targeting; it does **not** replace lists. A
  campaign can target a list, a filter, or both. Existing list-based campaigns
  keep working unchanged.
- **Tie-breaker:** when a lead qualifies for more than one campaign, scheduled
  callbacks dial first; otherwise the **older** campaign (earliest `created_at`)
  wins. No manual per-campaign priority for now.

## Design

### 1. Audience filter stored on the campaign

Add a nullable `audience_search text` column to `campaigns`. When set, the
campaign targets leads whose **company name** contains that text
(case-insensitive), in addition to any attached lists.

The filter text is stored **on the campaign itself**, not as a link to a
`saved_views` row. Saved views are private per-user and can be deleted, so a link
would be fragile. The campaign settings UI may still let the user **pick an
existing smart view as a shortcut** to pre-fill the text, but we copy the text
onto the campaign so it is self-contained.

Matching is **company-name only** — not the 3-column search (company, phone,
email) used by the leads page `q` filter. Reason: for a calling audience, matching
against phone/email text is meaningless and risky. The campaign's live preview
count uses the same company-only match, so "what you see = who gets called."

### 2. Dialer honors the filter

Extend the `dial_queue` view so eligibility comes from **either**:

- the existing list join (`list_campaign_attachments`), **or**
- a new filter branch: `leads` joined to a campaign by `owner_id` where
  `company ILIKE '%' || campaign.audience_search || '%'` and
  `audience_search IS NOT NULL`.

Every existing safety gate stays **exactly the same** for both branches:
callable status (`ready_to_call` / `callback`), `next_call_at` due, not deleted,
has a phone, not on DNC, within calling hours, campaign active with a Twilio
number, and the autopilot rule (callbacks dial even when autopilot is off). The
final `pre_call_check` RPC (caps, concurrency, spend, hours, DNC) is unchanged
and remains the last line of defense before any call is placed.
([tick.ts](../../../src/lib/dialer/tick.ts),
[pre_call_check](../../../supabase/migrations/20260525160000_create_calls_and_dial_queue.sql))

A campaign with **both** a list and a filter targets the **union** of the two
audiences (deduped per lead — see next).

### 3. Double-call guard (one campaign per lead)

Today "one lead = one list" quietly prevents a lead from being dialed by two
campaigns. Filter targeting removes that, because a lead can match a filter while
also sitting in another campaign's list (or match two filters). The view must
therefore return **at most one row per lead**, deterministically:

- Collapse to one row per `lead_id` (e.g. `DISTINCT ON (lead_id)`).
- Ordering that decides the winner: scheduled **callbacks first**
  (`dial_priority`), then the **older campaign** (`campaigns.created_at` ascending,
  `campaigns.id` as a stable final tiebreak), then soonest-due.

This guarantees a lead is dialed by exactly one campaign at a time, never both.

### 4. Campaign settings UI

In the campaign settings dialog, alongside the existing **Lists** tab, add an
**Audience** field:

- A text input: _"Also call leads whose company name contains: \_\_\_"_
- An optional shortcut to pick one of the user's saved smart views to pre-fill it.
- A **live match count** ("matches 312 leads") so the user sees how many phones
  the filter targets **before** saving/enabling — critical for a system that
  spends money and must respect TCPA.

([campaign-settings-dialog.tsx](<../../../src/app/(app)/campaigns/campaign-settings-dialog.tsx>),
[list-attachments-actions.ts](../../../src/lib/campaigns/list-attachments-actions.ts))

## Safety & rollout

- **Migration sequencing:** add the nullable `audience_search` column first
  (harmless to existing code), then ship the view change and the UI in the same
  deploy. Never drop/rename anything existing. List-based campaigns are
  untouched, so nothing in production breaks.
- **No data edits** to existing leads or campaigns are required.
- **Contract test:** add/adjust a Playwright spec describing the new behavior — a
  campaign with an `audience_search` calls a matching lead that lives in a
  _different_ list, and a lead matching two campaigns is dialed by only one.
  (Specs run against the live environment and can't be run locally.)
- **Local verification before merge:** `npx tsc --noEmit`, `npx eslint` on
  changed files, and `npm run build` must all be clean.
- **Deploy path:** feature branch → PR → merge to main (auto-deploys on Vercel).

## Out of scope / future

- A **dedicated segment/brand field** on leads (set on import or in bulk) that
  campaigns filter on. This is the robust upgrade if company-name text matching
  proves too loose (false positives, or F45 records whose names don't contain
  "F45"). Not built now.
- Filtering campaigns by any dimension other than company-name text (status,
  time zone, date ranges, custom fields). The plumbing makes this extensible, but
  only company-name text ships in this change.
- Per-campaign manual priority setting for the tie-breaker.
