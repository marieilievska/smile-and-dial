# Fix Patterns

How to fix a mislabel safely: correct the **call**, move the **lead** to match, and (if systematic) harden the **live agent**. Every bulk write dry-runs first.

## 1. Relabel a call + move the lead

Relabeling a call is only half the fix — the lead's state must match the new outcome, or the lead is stranded (a `goal_met` lead stays terminal forever; a wrongly-rested lead never gets called).

**Per call:** `PATCH /calls?id=eq.<id>` → `{ outcome: <target>, outcome_source: "manual", retry_applied_at: null }`.

**Per lead — set state to what the retry engine would produce for that outcome** (`src/lib/dialer/retry-engine.ts`):

| Target outcome                                      | Lead patch                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| `gatekeeper` (retry)                                | `status="ready_to_call"`, `next_call_at`=now+2d, `resting_until=null`     |
| `gatekeeper_not_interested`                         | `status="resting"`, `resting_until`=`next_call_at`=now+15d, counters 0    |
| `not_interested`                                    | `status="resting"`, `resting_until`=`next_call_at`=now+30d, counters 0    |
| `voicemail`/`no_answer`/`busy`/`failed`/`hung_up_*` | `status="ready_to_call"`, `next_call_at`=now+2d (retry cycle)             |
| `ai_error`                                          | `status="ready_to_call"`, `next_call_at`=now+~2h (no cycle advance)       |
| `goal_met`                                          | `status="goal_met"`, `next_call_at=null`, `resting_until=null` (terminal) |
| `callback`                                          | see §2 (needs a callbacks row)                                            |

`scripts/relabel.js` does this: feed it `{ "<callId>": "<targetOutcome>", ... }`, it dry-runs (prints current outcome + planned lead state), and on `--apply` writes both and refuses any call not currently what you expect. It also **blocks un-DNC unless the lead is DNC-clean** (§3).

## 2. Relabel _to_ callback

A `callbacks` row is required or the lead strands (the dialer dials `MIN(scheduled_at)` of pending callbacks; status alone does nothing).

1. `POST /callbacks` → `{ lead_id, campaign_id, originating_call_id:<callId>, scheduled_at:<ISO>, status:"pending", voicemail_attempts:0 }`
2. `PATCH /calls` → `outcome="callback"`, `outcome_source="manual"`
3. `PATCH /leads` → `status="callback"`, `next_call_at=<scheduled_at>`, `resting_until=null`

## 3. Un-DNC safety (reversing a compliance flag)

Before making a formerly-`dnc` lead callable, **prove it has no other DNC signal**:

- no `dnc`-outcome call on any _other_ day, and
- exactly one `dnc_entries` row, tied to this call (match `phone` E.164 OR `source_call_id` ∈ the lead's call ids); no stray entry.

Only then: relabel the call, `DELETE` the `dnc_entries` row(s), set the lead to the real outcome's state. `relabel.js --allow-undnc` enforces this check and aborts on any stray signal.

## 4. Reschedule leads pushed out by an ai_error spike

For leads whose **latest** call that day was a quota `ai_error` and are now `ready_to_call`/`resting` with a future `next_call_at`: `PATCH /leads` → `next_call_at`=now, `status="ready_to_call"`, `resting_until=null`. Exclude leads that got a later real call (already rescheduled) and any on active callbacks. `scripts/credit-check.js --reschedule` does the dry-run/apply.

## 5. Live-agent PATCH (harden the future)

> **🚫 REQUIRES MARIJA'S EXPLICIT CONFIRMATION.** Never change a live agent's prompt (disposition or conversation) on your own. Show her the exact before/after diff and the effect, get a clear "yes", THEN run `el-patch.js --apply --confirmed`. `--apply` without `--confirmed` refuses. This applies even for an "obvious" fix.

The agent's **disposition extractor prompt** decides most outcomes; the **conversation prompt** decides behaviour (offers, booking). Fix the code source AND the live agent (they drift). Keep the code prompt in `src/lib/elevenlabs/agents.ts`; the conversation prompt is EL-managed (not in the repo).

**Recipe (the live agent, verify):**

1. `GET /v1/convai/agents/{id}` with header `xi-api-key: $ELEVENLABS_API_KEY`.
2. Anchor-replace the exact clause in the target string. Assert the old anchor was present and the new text is in; assert the _removed_ concept is gone.
3. PATCH back, then re-GET and verify.

**Disposition prompt** lives at `platform_settings.data_collection.disposition.description` (+ `.enum`). PATCH `{ platform_settings: {...ps, data_collection:{...dc, disposition:{...d, description:newDesc}} } }`. **Preserve `platform_settings.workspace_overrides.webhooks`** (post_call_webhook_id `f14b67aba33b4744a1ea1741cb058a70`) — verify it survived.

**Conversation prompt** lives at `conversation_config.agent.prompt.prompt`. ⚠️ **Gotcha:** the GET returns BOTH deprecated inline `prompt.tools` (10) AND `prompt.tool_ids` (6) + `built_in_tools` (4); PATCHing both → `400 "Cannot specify both tools and tool IDs"`. Fix: `delete newCc.agent.prompt.tools` before PATCH (tool_ids=6 custom + built_in_tools=4 system fully cover the 10). Re-GET and confirm `tool_ids.length===6` and `built_in_tools` intact.

`scripts/el-patch.js` wraps this (anchor-replace with assertions, tools-safe, webhook-preserving, dry-run by default).

## 6. Booking a lead manually (e.g. an agreed lead whose in-call booking errored)

Reuses the app's Calendly path (`src/lib/calendly/api.ts` `createInvitee`). Additive and safe; **never cancel** a group-event registrant.

1. Lead → `campaign_id`; campaign → `owner_id`, `calendly_event_id`; token = `user_integrations.calendly_api_key` (by `user_id=owner_id`); event uri = `calendly_event_types.event_uri`.
2. `GET /event_type_available_times?event_type=<uri>&start_time=&end_time=` (≤7-day window) → pick the exact slot `start_time`. Location kind from `GET <event_uri>` → `locations[0].kind`.
3. `POST https://api.calendly.com/invitees` (Bearer token) → `{ event_type, start_time, invitee:{ email, timezone:<lead tz>, name }, location:{ kind } }`. **Omit `tracking`** (Calendly's tracking is all-or-nothing; a partial one rejects the whole booking — omitting is safe, just no UTM attribution).
4. On success: lead → `calendly_event_uri`=response event uri, `status="goal_met"`, `next_call_at=null`; call → `outcome="goal_met"`. Guard: skip if the lead already has a `scheduled` `calendly_events` row.

## 7. git / verify

Branch off `origin/main`. Stage files **explicitly** (`git add src/...`, never `-A`). `tsc --noEmit`, `eslint <files>`, `npx next build` — all must pass (no CI). Commit `--no-verify` (lint-staged races a concurrent session). One PR per fix; squash-merge; Vercel auto-deploys on merge. For a code change that changes lead scheduling, ship + let it deploy BEFORE running the matching data fix.
