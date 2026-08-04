# Campaigns: Draft → Launch flow — design

**Date:** 2026-08-04
**Status:** Spec for review (not yet built)
**Owner:** Marija
**Context:** Follows PR #355, which removed the _dead_ Draft scaffolding and made the current "create is live" behavior explicit. This spec adds a **real** draft state so nothing dials until a teammate deliberately launches.

## Goal

Today a new campaign goes live the instant you click **Create** — with a list attached and inside calling hours, it starts dialing real businesses immediately. For a nervous new teammate that's an easy "wait, I didn't mean to call 200 people yet." Add a deliberate **Draft → Launch** step: campaigns are created as drafts, reviewed, then launched explicitly.

## Behavior

- **Create** saves a campaign as `status = 'draft'` — it does **not** dial. All config (agent, goal, lists, caps) is editable in draft.
- A draft shows a **Launch** action (row + board + settings footer). Launching sets `status = 'active'` and re-applies the agent's ElevenLabs integration / webhooks (same side effects `resumeCampaign` runs today).
- A draft can be **edited**, **cloned**, **deleted**, or launched. It cannot be paused (nothing to pause) and doesn't count toward "active" stats or the dialer.
- Everything downstream already excludes non-active campaigns from dialing (`status = 'active'` gates the dial queue), so a draft simply never dials.

## Changes

### DB (migration — apply BEFORE the code deploy)

1. Extend the check constraint: `status in ('draft','active','paused','ended')`.
2. **Change the column default** `active` → `draft` **only after** the create action explicitly sets a status (see sequencing) — or set status explicitly in `createCampaign` and leave the default. **Recommend: set `status: 'draft'` explicitly in `createCampaign`** and leave the DB default as-is, so no other insert path is affected.
3. No backfill — existing campaigns stay `active`/`paused`/`ended`.

### Code (`src/lib/campaigns/actions.ts`)

- `createCampaign`: insert `status: 'draft'`. Do **not** run `reapplyAgentIntegration` at create (defer to launch) — or keep it (harmless), but the campaign won't dial until launched.
- New `launchCampaign(id)`: draft → active; set nothing else; run `reapplyAgentIntegration` + `syncTwilioAttachment` refresh; write a `campaign_launched` system_event. Guard: only from `draft` (and maybe re-launch a paused one? no — keep pause/resume separate).
- `cloneCampaign`: clone as `draft` (currently clones as `active`) so a cloned campaign also gets a deliberate launch. **Confirm with Marija** — some users clone-to-relaunch-fast and may want active. (Recommend: clone as draft for consistency.)

### UI

- **Restore the Draft status** across the surface that #355 removed: `campaigns-status-tabs` (Draft tab), `page.tsx` STATUS_VALUES + tabCounts, `campaign-cells` statusVariant (draft → `secondary`/grey), and the attention rail (a draft with no lists is fine, not an alarm).
- **Launch control**: `campaign-row-actions` — for `draft`, show a primary **Launch** button (coral, Rocket/PlayCircle icon) + Clone + Delete + End. On the board card + the settings-sheet footer too.
- **Create form**: replace the "Goes live as soon as you create it" note (from #355) with "Saved as a draft — you'll launch it when you're ready." Primary button becomes **"Save draft"**; optionally a secondary "Save & launch" for power users who do want it live now.
- **Empty/Today onboarding**: the 4th onboarding step ("Launch campaign") should key off `status = 'active'` (it already does via `fetchOnboardingProgress`), so creating a draft won't prematurely tick the step — good, no change.

## Migration sequencing

1. Ship the **constraint** migration first (adds `'draft'` as _allowed_ — nothing produces it yet; fully backward-compatible).
2. Deploy the **code** (createCampaign → draft, `launchCampaign`, UI). Now drafts exist and can be launched.
   - Order matters: the constraint must accept `'draft'` **before** any code writes it.

## Risks / notes

- **No permission change** — launch is owner-or-admin like the other lifecycle actions (RLS on `campaigns`).
- Audit everything that assumes a campaign is dialing the moment it exists: `fetchOnboardingProgress` (keys off active — fine), stats strips (count active — fine), the "active campaign" top-bar chip (excludes ended; a draft would appear in the picker — decide whether drafts should be selectable as the manual-call active campaign; **recommend excluding drafts** from that picker).
- The dialer already gates on `status = 'active'`, so a draft can never dial even if some check is missed — fail-safe.

## Open questions

1. **Clone as draft or active?** (Recommend draft.)
2. Offer a **"Save & launch"** secondary button on create, or force the two-step? (Recommend offering it — keeps the fast path for experienced users while making draft the safe default.)
3. Should a launched-then-ended campaign be re-openable as a draft? (Recommend no — `ended` stays terminal; clone instead.)
