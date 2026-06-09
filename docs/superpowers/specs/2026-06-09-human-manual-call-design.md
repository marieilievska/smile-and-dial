# Human / Manual Call — Design

**Status:** Approved design, ready for implementation plan
**Date:** 2026-06-09

## Goal

Let a user place a **live human call** to a lead from the app — talking through
the browser (headset/mic) instead of the AI agent. The lead is dialed from the
campaign's Twilio number; the user and lead are bridged so they talk in real
time. The call is recorded, transcribed, and summarized so it looks just like an
AI call in the call log, only tagged **Human**.

This is the human counterpart to the existing AI auto-dialer. Inbound calling is
explicitly **out of scope** here (tracked as a separate follow-up).

## User flow

1. On the **Lead detail page**, the user clicks **Call**.
2. The browser requests a short-lived Twilio voice token from our backend and
   connects via the Twilio Voice SDK (mic-permission prompt the first time).
3. Twilio calls back into our app; we create the `calls` record (tagged
   `human`), resolve the lead's phone + the campaign's Twilio number (caller
   ID), and return TwiML that **dials the lead and bridges the user**, with
   recording enabled.
4. An **in-call panel** shows the lead name, a live timer, mute, and hang-up.
5. When the recording is ready, we run it through **OpenAI Whisper** (transcript)
   and **OpenAI** (summary), storing them on the call — so the call detail modal
   shows audio + transcript + summary like an AI call.
6. After hang-up, a **"How did it go?"** panel lets the user set the outcome
   (goal met / callback / not interested / …) plus a note. This runs the **same**
   outcome side-effects as an AI call (lead status, retry scheduling, callback
   creation).

## Approach (chosen: A)

Twilio Voice SDK in the browser → Twilio records → OpenAI Whisper transcript →
OpenAI summary. Reuses tools already in the stack (Twilio, OpenAI) and makes
human calls indistinguishable from AI calls in the UI except for the tag.

**Estimated cost:** ~$0.027/min (~$0.12–0.15 for a typical 5-minute call).
Dominated by Twilio voice (~$0.018/min across both legs) and Whisper
($0.006/min); the OpenAI summary is negligible.

## Data model

Add to `calls`:

- `call_mode text not null default 'ai'` — `check (call_mode in ('ai','human'))`.
  The tag distinguishing human vs AI calls.
- `placed_by uuid references profiles(id)` — the user who placed a human call
  (null for AI calls).

Human-call outcomes are written with `outcome_source = 'manual'` (so we know the
user set them, not the AI). Human calls live in the **same** `calls` table, so
they appear in the Calls list, Costs, and Analytics with no extra wiring.

## Components (each independently testable)

1. **Voice token endpoint** — `POST /api/twilio/voice-token`. Mints a Twilio
   `AccessToken` with a `VoiceGrant` (identity = user id, outgoing application =
   our TwiML App). Signed with the existing `TWILIO_API_KEY_SID` /
   `TWILIO_API_KEY_SECRET`. Auth-gated to the logged-in user.
2. **Browser-dial handler** — `POST /api/twilio/voice-browser-dial`. Twilio hits
   this when the browser connects. It creates the `calls` row
   (`call_mode='human'`, `direction='outbound'`, `placed_by=<user>`), resolves
   the lead phone + campaign caller-ID number, and returns TwiML:
   `<Dial record="record-from-answer-dual" callerId="<twilio#>" action=…>`
   `<Number statusCallback=…>{leadPhone}</Number></Dial>`.
3. **Recording → transcription step** — the existing Twilio recording/status
   webhook fans out: on `recording` ready, fetch the audio, send to Whisper for
   a transcript, then OpenAI for a summary, and store `recording_path`,
   `transcript_json`, `summary` on the call. Reuses the existing post-call
   summary plumbing where possible.
4. **In-call panel (client)** — Twilio Voice SDK `Device`; connect, live timer,
   mute, hang-up. Lives on the Lead detail page.
5. **Disposition panel + server action** — after hang-up, set outcome + note;
   reuses the existing outcome→retry/side-effects pipeline (status update,
   callback scheduling via the callbacks flow, etc.).
6. **Migration + Calls list tag/filter** — the migration above; a **"Human"**
   badge in the Calls list and call detail modal; an **All / AI / Human** filter
   on the Calls page.

## Twilio setup (handled programmatically — no console work)

The signing API key already exists in the environment
(`TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET`). The only new Twilio resource is
a **TwiML App** whose Voice URL points at the deployed `voice-browser-dial`
handler. This is created via the Twilio API (using the existing account
credentials) once the handler is deployed, and its SID is stored as
`TWILIO_TWIML_APP_SID` in the env (`.env.local` + production). No manual Twilio
console steps required from the user.

New env var: `TWILIO_TWIML_APP_SID`. Caller-ID number reuses the campaign's
existing Twilio number.

## Out of scope

- **Recording disclosure / consent announcement** — intentionally omitted per
  product decision. (Legal review available separately if desired later.)
- **Inbound calling** — separate follow-up (point a Twilio number at the existing
  `/api/twilio/voice-inbound` handler).
- **Browser calling from other surfaces** (Leads table, Callbacks, Calls list) —
  v1 is Lead detail only; other entry points can be added later.

## Testing

- Unit/route tests: voice-token endpoint returns a well-formed token for the
  authed user; browser-dial handler returns correct `<Dial>` TwiML for a given
  lead (caller ID, recording flag, lead number); disposition action applies the
  right outcome side-effects; migration applies cleanly.
- Calls list: "Human" badge + AI/Human filter render correctly.
- **Manual test call** before merge — the live talk-and-hear path (WebRTC audio)
  can't be automated, so it's verified by a real call.
