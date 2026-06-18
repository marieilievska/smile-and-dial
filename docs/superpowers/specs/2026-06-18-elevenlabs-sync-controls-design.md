# ElevenLabs sync controls (Effort 1: outbound + buttons)

**Date:** 2026-06-18
**Status:** Design — approved direction; building
**Author:** Marija + Claude

Fix the "added a number to a campaign but it never reached ElevenLabs" bug and
add one-click sync controls. **Inbound is untouched** here — moving inbound to
ElevenLabs is a separate effort (Effort 2).

## Root cause (from the audit)

- Attaching a Twilio number to a campaign only sets `twilio_numbers.attached_campaign_id`
  ([`syncTwilioAttachment`](../../../src/lib/campaigns/actions.ts)). The ElevenLabs
  number registration (`importTwilioNumberToElevenLabs`, POST
  `/v1/convai/phone-numbers`) only happens **lazily on the first dial**
  ([`agent-dial.ts`](../../../src/lib/dialer/agent-dial.ts)). So before any dial —
  or if that first import fails — ElevenLabs never learns the number.
- An agent's **custom** `extra_data_collection` fields only reach ElevenLabs on
  agent edit+save (the full `syncAgentToElevenLabs`). "Re-sync all agents" uses the
  overlay (`applyConnectedAgentIntegration`), which doesn't push custom fields.
- The agent is sent with **every** outbound call, so no separate "attach agent to
  number" is needed for outbound — once the number is registered, calls connect.

## Decisions (approved)

- Numbers: **auto-register with ElevenLabs on campaign attach** + a per-number
  **"Connect to ElevenLabs"** button to repair/retry.
- Agents: a per-agent **"Sync to ElevenLabs"** button (full sync, custom fields).
- **Inbound unchanged** (Effort 2 will move it; tracked separately).

## Design

### 1. Shared number-import helper

Add `ensureNumberImportedToElevenLabs(supabase, twilioNumberId)` to
[`src/lib/twilio/place-call.ts`](../../../src/lib/twilio/place-call.ts):
reads the row; errors if released; returns the cached `elevenlabs_phone_number_id`
if present (idempotent); otherwise imports via `importTwilioNumberToElevenLabs`
(Twilio creds from env) and caches the id on the row. Returns the existing
`ImportNumberResult` union. **Refactor `agent-dial.ts`** to call this helper
instead of its inline import block (same behavior, one code path).

### 2. Auto-register on attach

In `syncTwilioAttachment` (campaigns/actions.ts), after attaching the new number,
call `ensureNumberImportedToElevenLabs(supabase, newNumberId)` **best-effort** —
it never blocks the campaign save (mirrors the existing best-effort
`reapplyAgentIntegration`). The per-number button is the visible repair path if
this hiccups.

### 3. Per-number "Connect to ElevenLabs" button

- New action `connectNumberToElevenLabs(id)` in
  [`number-actions.ts`](../../../src/lib/twilio/number-actions.ts) (admin-gated like
  the others) → calls the helper, returns `{ error }`, revalidates.
- New client button (mirror `repoint-button.tsx`) on the Twilio Numbers page rows.
  Show a small **"Connected to ElevenLabs"** indicator when
  `elevenlabs_phone_number_id` is set, and the button when it isn't.

### 4. Per-agent "Sync to ElevenLabs" button

- Extract a `syncAgentRow(supabase, agent)` helper from `resyncAllAgents` (the
  externally-managed branch → overlay; else full `syncAgentToElevenLabs` + id
  update) so both the bulk re-sync and the new per-agent action share one path.
- New action `syncAgent(id)` in agents/actions.ts (admin-gated) → loads the one
  agent (same select as `resyncAllAgents`) → `syncAgentRow` → revalidate.
- New client button (mirror `resync-agents-button.tsx`, scoped to one agent) on
  each agent row in the Agents list.

## Safety & rollout

- **Outbound-only.** Inbound routing, the voice-inbound webhook, and inbound lead
  creation are untouched.
- **No schema change** — `twilio_numbers.elevenlabs_phone_number_id` already exists.
- **Idempotent** — the helper skips re-import when an id is already cached.
- **Best-effort on attach** — a campaign save never fails on an ElevenLabs hiccup;
  the button surfaces/repairs failures explicitly.
- Actions are **admin-gated** (Twilio numbers + agents are admin-managed).
- **Local verification:** `tsc`, `eslint` (changed files), `npm run build` clean.
- **Deploy:** branch `feat/elevenlabs-sync-controls` → PR → merge to main. No migration.

## Out of scope (Effort 2)

- Moving inbound to ElevenLabs-native (repoint Twilio routing, assign EL inbound
  agent, and rebuild inbound lead creation / call logging / dedup from EL's
  webhook). Its own spec.
