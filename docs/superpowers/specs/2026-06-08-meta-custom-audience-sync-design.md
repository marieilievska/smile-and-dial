# Meta (Facebook) Custom Audience Sync — Design

**Status:** Approved (design phase). Build not started.
**Date:** 2026-06-08

## Goal

Get the email addresses we collect on calls into a **Meta Custom Audience** so
the team can run Facebook/Instagram ads to those leads — and, more powerfully,
build **Lookalike Audiences** from them to find new prospects. Lookalikes are
created by the user inside Meta Ads Manager; our job is to keep an accurate,
fresh source audience in Meta.

## Scope (decided)

- **Which contacts:** every lead with a `business_email`, across all campaigns,
  in **one** audience ("Smile & Dial — All Leads"). Not segmented per campaign.
- **Match keys sent (all hashed):** `email`, `phone`, `city`, `state`,
  `country`. No names (we rarely capture last name). No zip/DOB/gender (not
  collected). Country is derived as **US or CA** (Canadian province or Canadian
  area code → CA; otherwise US).
- **Two delivery paths, both built:**
  - **A — Manual CSV export:** download a Meta-formatted CSV for upload in Ads
    Manager. Works with zero Meta credentials; also a fallback.
  - **B — Automated sync (primary):** push to the Custom Audience via Meta's
    Marketing API, **nightly + on-demand "Sync now."** Not real-time.

## Consent & safety (decided)

- **Exclude** any lead on **DNC** or soft-deleted from both export and sync.
- **Two-way:** when a lead later becomes DNC'd or deleted, the nightly sync
  **removes** them from the Meta audience (opt-outs respected over time).
- **Connect-time acknowledgment:** a required checkbox certifying the user has
  the right to use this contact data for advertising — mirrors Meta's Custom
  Audience Terms. (No separate legal/counsel gate — explicitly waived by owner.)

## Match-rate expectations (set with the user)

- ~50–80% of contacts typically match a Meta account. Normal.
- Audience needs ~100 matched people before ads can run.
- Email + phone do the heavy matching; city/state/country only strengthen and
  disambiguate (they do not match on their own).

## Architecture

### Data (app_settings singleton — same pattern as Calendly/Close secrets)

New columns:

- `meta_ad_account_id` (text) — e.g. `act_123…`
- `meta_access_token` (text) — long-lived System User token, server-only
- `meta_custom_audience_id` (text) — the audience we create/own
- `meta_audience_terms_accepted_at` (timestamptz) — the acknowledgment
- `meta_connected_at`, `meta_last_sync_at` (timestamptz)
- `meta_last_sync_count` (int), `meta_last_sync_error` (text, nullable)
- `meta_sync_secret` (text) — protects the sync endpoint (like `dialer_tick_secret`)

Per-lead sync state (so removals can be computed without reading the audience
back from Meta, which Meta doesn't allow): a `leads.meta_synced_at` timestamp.
A lead that has `meta_synced_at` set but is now DNC'd/deleted/email-cleared is
sent to `removeUsers` and its `meta_synced_at` cleared. Newly-eligible leads get
added and stamped.

### Components (each a small, focused unit)

1. **`src/lib/meta/hash.ts`** — normalize + SHA-256 each field per Meta's rules
   (email: trim+lowercase; phone: digits with country code; city/state:
   lowercase, strip non-alpha; country: 2-letter lowercase). Pure, unit-testable.
2. **`src/lib/meta/audience-fields.ts`** — turn a lead row into Meta's
   multi-key user record (`{ EMAIL, PHONE, CT, ST, COUNTRY }` → hashed),
   including the US/CA country derivation. Pure.
3. **`src/lib/meta/api.ts`** — thin Meta Marketing API client: create audience,
   `addUsers`, `removeUsers` (POST/DELETE `/{audience_id}/users`, batched at
   Meta's 10k/request limit, schema = the keys we send). Live vs mock gated by
   whether a token is configured.
4. **`src/lib/meta/sync.ts`** — orchestration: gather eligible leads (email
   present, not DNC, not deleted), add them; reconcile removals (leads now
   DNC'd/deleted that were previously synced); write status back to
   app_settings. Paginates leads, batches to the API.
5. **CSV export** — `src/app/(app)/settings/integrations/meta/export/route.ts`:
   streams the eligible contacts as a Meta-format CSV.
6. **Sync endpoint** — `src/app/api/meta/sync/route.ts`: secret-protected
   (`x-meta-sync-secret`) POST that runs `sync.ts`. Also callable by a signed-in
   admin ("Sync now").
7. **Nightly trigger** — pg_cron job (same mechanism as the dialer) POSTs the
   sync endpoint once a day with the secret from app_settings.
8. **Settings UI** — a "Meta Ads (Facebook / Instagram)" card on
   `settings/integrations`: Connect form (ad account ID + token + acknowledgment
   checkbox), Disconnect, Export CSV, Sync now, and a status line
   ("Last synced 2h ago · 7,412 contacts").

### Data flow (automated path)

nightly pg_cron → POST `/api/meta/sync` (secret) → `sync.ts` reads eligible
leads → `audience-fields` + `hash` → `api.addUsers` in 10k batches → reconcile
removals → write `meta_last_sync_at` / count / error → status shows in Settings.

## Error handling

- **No token / not connected:** sync + "Sync now" no-op with a clear status;
  CSV export still works.
- **Invalid/expired token:** Meta returns auth error → store
  `meta_last_sync_error`, surface "Reconnect needed" in the card; don't crash.
- **Rate limits / partial batch failure:** retry the failed batch with backoff;
  record how many succeeded; never lose the whole run for one bad batch.
- **Audience deleted in Meta:** detect missing audience → recreate and full-sync.
- **Empty/too-small audience:** surface the ~100-match minimum as a hint.

## Prerequisites (dependency the user is chasing)

From whoever owns the Meta Business account:

1. **Ad account ID** (`act_…`).
2. A **Meta app** with **ads_management** permission.
3. A **long-lived System User access token** (Business Settings → System Users).
4. **Accept Custom Audience Terms** once in Ads Manager.
   Build proceeds without these (mock mode + CSV export work); live sync switches on
   once they're entered in the Connect form.

## Out of scope (v1)

- Lookalike creation (done by the user in Meta).
- Per-campaign / segmented audiences (one audience for now).
- Zip / DOB / gender / name keys.
- Real-time per-lead sync (nightly + on-demand only).
- OAuth "Login with Facebook" connect flow (paste-token v1; OAuth later).

## Open dependency

Live sync is blocked only on the Meta credentials above. Everything else —
CSV export, the UI, hashing, the sync engine in mock mode — can be built and
verified now.
