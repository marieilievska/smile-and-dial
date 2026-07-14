# Close texting (SMS) + live email sending — design

- **Date:** 2026-07-14
- **Status:** Approved for planning
- **Ships as:** two separate PRs — Phase 1 (email → live), then Phase 2 (in-call texting)

## Goal

Let the AI **text a lead through Close** during a call, the same way it can
"email" one today — landing the message in the Close timeline and honoring
opt-out. Because the email path is currently a mock, Phase 1 first makes email
_actually deliver_, and Phase 2 mirrors that working pattern for SMS.

## Background — what actually happens today (grounded in code)

There are **two** `sendEmail` functions, and they don't do the same thing:

1. **The live, in-call path** — `sendEmail()` in
   [`src/lib/elevenlabs/tool-webhook.ts`](../../../src/lib/elevenlabs/tool-webhook.ts)
   (dispatched ~line 269). This is what runs when the AI uses its `send_email`
   tool on a call. It renders the campaign's fixed template and **writes a
   `emails` row with a fake `close_message_id` (`mock-msg-…`)** — it never calls
   Close. The lead receives nothing. The code says so directly: _"Live Close
   delivery isn't built yet, so this is the mock path."_

2. **The real-but-dormant path** — `sendEmail()` in
   [`src/lib/close/actions.ts`](../../../src/lib/close/actions.ts). This one
   genuinely delivers: it finds/creates the Close contact and posts an
   `status: "outbox"` email via `sendCloseEmail()` in
   [`src/lib/close/api.ts`](../../../src/lib/close/api.ts). **Nothing calls it** —
   confirmed by grep; the only wired Close actions are `saveCloseConnection`,
   `disconnectClose`, and `handoffLeadToClose`.

So "we send emails from Close" is, in production, "we log emails that look
sent." The delivery code exists; it's just not connected to the tool.

**Reusable machinery that already exists** (we extend, not rebuild):

- Close REST helpers with Basic auth — `src/lib/close/api.ts`
  (`findCloseLeadByEmail`, `createCloseLead`, `sendCloseEmail`, …).
- Per-user Close key — `user_integrations.close_api_key` (per lead **owner**).
- Per-agent tool enable/disable — `ToolsEnabled` / `toolIdsForEnabled`
  (`src/lib/elevenlabs/server-tools.ts`), toggled in the agent wizard.
- Do-not-call list — `dnc_entries` (phone-keyed) + `addToDnc()`
  (`src/lib/dnc/actions.ts`); the dialer already skips DNC numbers.
- Inbound Close webhook — `src/app/api/close/webhook/route.ts` (today handles
  `email.received`; we add `sms.received`).

## Confirmed: Close SMS API

`POST https://api.close.com/api/v1/activity/sms/` — to send now, set
`status: "outbox"` and provide:

| Field                       | Meaning                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `status`                    | `"outbox"` = send immediately (`"scheduled"` + `date_scheduled` = later)                           |
| `local_phone`               | **sender** number, E.164 — must be a Close number "of type internal" (an SMS-enabled Close number) |
| `remote_phone`              | **recipient** number, E.164                                                                        |
| `text` **or** `template_id` | message body (we send our own rendered `text`)                                                     |
| `lead_id`, `contact_id`     | the Close lead/contact to attach to                                                                |

This maps one-to-one onto the email path. The one new lookup we need: the org's
SMS-enabled Close number to use as `local_phone` (email got its sender from
`closeSenderEmail()`; SMS needs the equivalent for phone numbers).

---

## Phase 1 — Make email actually send

**Change:** the in-call `send_email` handler stops writing a mock row and instead
delivers through Close, reusing the helpers that already exist.

- Extract the real delivery (find/create contact → `sendCloseEmail` outbox) into
  a shared helper both the in-call tool and the (currently dormant) server action
  can call, so there's **one** send path, not two that drift.
- Resolve the campaign's fixed template (already done), render it, deliver it.
- **Honesty rule:** the AI only tells the lead "I've emailed that to you" when a
  real send succeeded. If the lead's owner has **no** Close connection (or no
  connected sending email), the AI does **not** claim it sent — it either offers
  an alternative or simply doesn't promise. No fake "sent" rows.
- The `emails` row records the real Close message id (no more `mock-msg-…`).
- No new settings, no schema change. Same per-agent toggle, same per-campaign
  template.

**Enablement / permissions:** unchanged. `send_email` stays a per-agent toggle,
opt-in, available to any user (not admin-gated).

---

## Phase 2 — In-call texting (the SMS mirror)

A new **`send_text`** server tool, structurally a copy of `send_email`.

### 2.1 The tool

- Registered alongside the other server tools in
  `src/lib/elevenlabs/server-tools.ts` (add to `SERVER_TOOL_KEYS`,
  `TOOL_DESCRIPTIONS`, `bodySchemaFor`) and handled in `tool-webhook.ts`.
- Enabled per-agent via the same `ToolsEnabled` toggle + agent wizard, opt-in,
  not admin-gated.
- Description (LLM-facing): _"Text the lead the information they asked for.
  Confirm their mobile number and that they're OK to receive a text first."_

### 2.2 Which number we text — the mobile wrinkle

Texting is **not** the same target as calling:

- You **cannot** SMS a landline.
- Our dialer **never auto-dials mobiles** (the mobile-dial lock on
  `leads.line_type = 'mobile'`). So for an outbound-called lead, the number the
  AI is talking on (`leads.business_phone`) is by construction **not** a mobile —
  meaning it usually **can't be texted at all**. Capturing a separate mobile is
  therefore _required_, not a nice-to-have.
- Texting a mobile (with consent) and not auto-dialing one are consistent, not in
  conflict — they're complementary channels.

**Design:** the AI asks for / confirms the lead's **mobile number** on the call
(reading it back, exactly like it confirms an email), and we text that. We
persist it on a new nullable `leads.mobile_phone` (E.164) so repeat texts don't
re-ask. `remote_phone` = that mobile; never `business_phone` unless it is itself
a mobile.

### 2.3 Content — fixed per-campaign template

Mirror of email, minus the subject:

- New `sms_templates` table: `id, owner_id, name, body, last_used_at, timestamps`
  (no `subject`). Same `{{lead.company}}` / `{{lead.owner_name}}` / custom-field
  interpolation via the existing `renderTemplate()`.
- New `campaigns.sms_template_id` (nullable FK) — the fixed text that `send_text`
  sends verbatim, chosen in campaign settings next to the email template.
- Authored in the same Settings area as email templates
  (`/settings/email-templates`, likely renamed/extended to cover both).
- The AI does **not** freewrite SMS copy — content stays pre-approved. (Close has
  native SMS templates via `template_id`; we deliberately use **our** templates
  for consistency with email and to keep authoring + variables in-app.)

### 2.4 Delivery

- New helpers in `src/lib/close/api.ts`:
  - `closeSmsFromNumber(apiKey)` → the org's SMS-enabled Close number (E.164) for
    `local_phone`. (Confirm the exact Close phone-number endpoint at build.)
  - `sendCloseSms(apiKey, { leadId, contactId, localPhone, remotePhone, text })`
    → `POST /activity/sms/` with `status: "outbox"`; returns the activity id or a
    surfaced error, same defensive shape as `sendCloseEmail`.
- Find/create the Close contact by the mobile (or reuse the email-matched
  contact), then send.
- **Opt-out line appended** to the body: `text + "\n\nReply STOP to opt out."`
- Log a `texts` row (see 2.6).

### 2.5 Consent & opt-out (the compliance core)

- **Consent:** `send_text` only fires when the lead says yes on the call. We log
  the agreement (tool event on the call record) as the consent trail.
- **Opt-out language:** every text carries "Reply STOP to opt out."
- **STOP = full do-not-contact** (Marija's choice): a STOP reply marks the lead
  **do-not-call** through the existing DNC action — adding **both** the mobile
  **and** `business_phone` to `dnc_entries` and setting the lead terminal — so
  **calls _and_ texts stop.** Carriers also block further SMS at the 10DLC level
  as a backstop.
- Actual on-call wording, the opt-out line, and the STOP matcher get a dedicated
  **compliance pass** (legal-risk red-team) at build — not eyeballed.

### 2.6 Inbound replies (STOP + everything else)

Extend `src/app/api/close/webhook/route.ts` to also handle `sms.received`:

- Match the inbound SMS to a lead by `remote_phone` (→ `mobile_phone` /
  `business_phone`).
- If the body is a STOP keyword (STOP / STOPALL / UNSUBSCRIBE / CANCEL / END /
  QUIT, case-insensitive) → run the mark-do-not-call path (2.5) + notify owner.
- Otherwise → log a `direction: "received"` `texts` row and notify the owner.
  The full reply also lives in the Close inbox for a human — we are **not**
  building a two-way texting inbox in-app (see Out of scope).

### 2.7 Data model summary

- **New** `sms_templates` (mirror of `email_templates`, no subject).
- **New** `texts` table — mirror of `emails`: `lead_id, owner_id, campaign_id,
call_id, direction ('sent'|'received'), body, to_number, from_number,
close_message_id, status, template_id → sms_templates, raw, timestamps`.
  Same RLS shape (owner or admin). (A separate table keeps SMS clean vs. adding
  many null columns to `emails`.)
- **New** `campaigns.sms_template_id` (nullable FK).
- **New** `leads.mobile_phone` (nullable, E.164).

---

## Prerequisites (Marija sets up — not code)

- **Phase 1:** a Close account with a connected sending email. _We verify who has
  Close connected before shipping, so "live" is testable._
- **Phase 2:** the Close texting number registered for **A2P 10DLC** (the number
  exists; confirm the carrier registration — un-registered sending is blocked).
- Author the per-campaign email + text templates.

## Out of scope (YAGNI)

- No in-app two-way texting inbox — replies live in Close (+ a logged `texts`
  row + owner notification).
- No manual "send text" button for operators in Phase 2 (AI-in-call only, per the
  chosen use case). Easy to add later on the same `sendCloseSms` helper.
- No scheduled/drip texting, no MMS/attachments.
- No AI-composed SMS copy — fixed templates only.

## To verify at build (not guessed)

- Exact Close endpoint to list the org's SMS-enabled ("internal") phone numbers
  for `local_phone`.
- Who currently has a working Close connection (+ connected email for Phase 1).
- Close inbound webhook event name/shape for received SMS (`sms.received`) and
  whether STOP arrives as an inbound activity vs. only carrier-level.

## Testing (Playwright as contract, runs against live env)

- Phase 1: a `send_email` spec asserting a real (non-`mock-`) message id path and
  the honest "no Close connection → no false sent" behavior.
- Phase 2: `send_text` happy path (consent → template rendered → `texts` row);
  STOP inbound → lead on DNC + dialing paused; landline/no-mobile → AI asks for a
  mobile.

## Rollout

1. **PR 1 — email live.** Wire the in-call tool to real delivery; honesty rule;
   unify the send path. No migration.
2. **PR 2 — texting.** Migration (`sms_templates`, `texts`,
   `campaigns.sms_template_id`, `leads.mobile_phone`); `send_text` tool + Close
   SMS helpers; campaign + template UI; inbound `sms.received` + STOP→DNC;
   compliance pass. Migration is additive only (safe ordering per house rules).
